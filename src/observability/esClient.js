/**
 * Elasticsearch client — lazy singleton with circuit breaker
 *
 * Architecture matches carbon-migrate/agent-dispatcher/src/services/esClient.js:
 *
 *   - maxRetries: 0   — the circuit breaker owns retry logic, not the client
 *   - requestTimeout  — 50 s hard timeout so a slow ES never stalls a review run
 *   - readTrimmedString() on all credential env vars — prevents silent 401s from
 *     Kubernetes/Code Engine secrets carrying trailing newlines
 *   - Startup credential diagnostics — fingerprints logged without ever logging
 *     the actual value; use SHA-256 prefix to compare local vs deployed secrets
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
 *   ES_CA_CERT_PATH path to PEM CA cert (only for self-signed / IBM Cloud certs)
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { describeCredential, readTrimmedString } = require('../config/env');

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

  const url      = readTrimmedString('ES_URL');
  const username = readTrimmedString('ES_USERNAME') || 'elastic';
  const password = readTrimmedString('ES_PASSWORD');
  const caCert   = readTrimmedString('ES_CA_CERT_PATH');

  if (!url) return null;             // not configured

  if (!_client) {
    // ── Startup credential diagnostics (mirrors Carbon Migrate) ──────────────
    // Logs a safe fingerprint of each credential: length, whitespace flags,
    // first/last 2 chars, SHA-256 prefix. Never logs the actual secret value.
    // Compare this output between local and cloud to find stale secrets.
    const diagnostics = [
      describeCredential('ES_URL',      url),
      describeCredential('ES_USERNAME', username),
      describeCredential('ES_PASSWORD', password),
      ...(caCert ? [describeCredential('ES_CA_CERT_PATH', caCert)] : []),
    ];
    console.log('[esClient] Credential diagnostics at startup:',
      JSON.stringify(diagnostics, null, 2));

    const opts = {
      node: url,
      auth: { username, password },
      requestTimeout: 50_000, // 50 s — mirrors Carbon Migrate
      maxRetries: 0,          // circuit breaker handles retries
    };

    if (caCert) {
      // Resolve with two-candidate strategy: CWD first, then package root.
      const candidates = [
        path.resolve(process.cwd(), caCert),
        path.resolve(__dirname, '..', '..', caCert),
      ];
      for (const candidate of candidates) {
        try {
          const pem = fs.readFileSync(candidate);
          opts.tls = { ca: pem };
          const { createHash } = require('crypto');
          console.log(
            '[esClient] CA cert loaded',
            JSON.stringify({
              certPath:     candidate,
              sizeBytes:    pem.length,
              sha256Prefix: createHash('sha256').update(pem).digest('hex').slice(0, 12),
            })
          );
          break;
        } catch (_) { /* try next candidate */ }
      }
      if (!opts.tls) {
        console.warn('[esClient] Could not read ES_CA_CERT_PATH from either candidate path');
      }
    } else if (url.startsWith('https://localhost') || url.startsWith('https://127.')) {
      // Local dev cluster with self-signed cert — skip verification
      opts.tls = { rejectUnauthorized: false };
    }

    _client = new Client(opts);
    console.log('[esClient] Elasticsearch client initialised →', url);
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
    // 404/409/403 are expected control-flow errors — do not trip the breaker
    const status = err.meta?.statusCode;
    if (status === 404 || status === 409 || status === 403) {
      console.warn('[esClient] ES call returned expected status', status, '— breaker not tripped');
      return null;
    }
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
