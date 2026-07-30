/**
 * Elasticsearch client — lazy singleton with circuit breaker
 *
 * Architecture matches carbon-migrate/agent-dispatcher/src/services/esClient.js:
 *
 *   - maxRetries: 0   — the circuit breaker owns retry logic, not the client
 *   - requestTimeout  — 50 s hard timeout so a slow ES never stalls a review run
 *
 * Circuit breaker states:
 *   CLOSED    — normal operation
 *   OPEN      — tripped after 1 failure; calls are dropped for RESET_TIMEOUT_MS
 *   HALF_OPEN — one probe call allowed; success → CLOSED, failure → OPEN
 *
 * Required env vars (all optional — if absent ES is simply disabled):
 *   ES_URL          e.g. https://my-cluster.es.ibm.com:9243
 *   ES_USERNAME     e.g. elastic
 *   ES_PASSWORD     e.g. <password>
 *   ES_CA_CERT_PATH path to PEM CA cert (only for self-signed certs)
 */

'use strict';

const fs = require('fs');

// Lazy-require so the app starts fine when the package is not yet installed.
let Client;
try {
  ({ Client } = require('@elastic/elasticsearch'));
} catch (_) {
  Client = null;
}

// ── Circuit breaker ───────────────────────────────────────────────────────────
const RESET_TIMEOUT_MS = 150_000; // 150 s — mirrors Carbon Migrate

const breaker = {
  state: 'CLOSED', // CLOSED | OPEN | HALF_OPEN
  lastFailureAt: null,
};

function tripBreaker() {
  breaker.state = 'OPEN';
  breaker.lastFailureAt = Date.now();
  console.warn('[esClient] Circuit breaker OPEN — ES calls suspended for 150 s');
}

function maybeResetBreaker() {
  if (
    breaker.state === 'OPEN' &&
    Date.now() - breaker.lastFailureAt >= RESET_TIMEOUT_MS
  ) {
    breaker.state = 'HALF_OPEN';
    console.log('[esClient] Circuit breaker HALF_OPEN — probing ES');
  }
}

// ── Singleton client ──────────────────────────────────────────────────────────
let _client = null;

function getClient() {
  if (!Client) return null;          // package not installed
  if (!process.env.ES_URL) return null; // not configured

  if (!_client) {
    const opts = {
      node: process.env.ES_URL,
      auth: {
        username: process.env.ES_USERNAME || 'elastic',
        password: process.env.ES_PASSWORD || '',
      },
      requestTimeout: 50_000, // 50 s — mirrors Carbon Migrate
      maxRetries: 0,          // circuit breaker handles retries
    };

    if (process.env.ES_CA_CERT_PATH) {
      // Explicit CA cert provided — use it (IBM Cloud / production clusters)
      try {
        opts.tls = { ca: fs.readFileSync(process.env.ES_CA_CERT_PATH) };
      } catch (err) {
        console.warn('[esClient] Could not read ES_CA_CERT_PATH:', err.message);
      }
    } else if (process.env.ES_URL && process.env.ES_URL.startsWith('https://localhost')) {
      // Local dev cluster with self-signed cert — skip verification
      opts.tls = { rejectUnauthorized: false };
    }

    _client = new Client(opts);
    console.log('[esClient] Elasticsearch client initialised →', process.env.ES_URL);
  }

  return _client;
}

/**
 * Execute an Elasticsearch call with circuit-breaker protection.
 *
 * @param {Function} fn - async (client) => result
 * @returns {Promise<any|null>} result, or null if breaker is OPEN / ES is disabled
 */
async function esCall(fn) {
  maybeResetBreaker();

  if (breaker.state === 'OPEN') return null;

  const client = getClient();
  if (!client) return null;

  try {
    const result = await fn(client);

    if (breaker.state === 'HALF_OPEN') {
      breaker.state = 'CLOSED';
      console.log('[esClient] Circuit breaker CLOSED — ES connection restored');
    }
    return result;
  } catch (err) {
    tripBreaker();
    console.error('[esClient] ES call failed:', err.message);
    return null;
  }
}

/** Exposed for tests — reset singleton and breaker */
function _reset() {
  _client = null;
  breaker.state = 'CLOSED';
  breaker.lastFailureAt = null;
}

module.exports = { getClient, esCall, _reset, breaker };

// Made with Bob
