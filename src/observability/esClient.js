/**
 * Elasticsearch client — lazy singleton with circuit breaker + HTTP fallback
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
 * HTTP fallback:
 *   If the primary HTTPS URL throws a connection-level error (not a 4xx/5xx
 *   HTTP response), the client is rebuilt with the plain-HTTP equivalent and
 *   the call is retried once.  A 4xx/5xx (auth failure, not-found, etc.) is
 *   a real error and does NOT trigger the fallback — use HTTPS in production.
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
let _client     = null;
let _activeUrl  = null; // tracks which URL the singleton was built with

/**
 * Build (or return cached) an ES Client for the given URL.
 * Separated from getClient() so the HTTP-fallback path can call it directly.
 */
function buildClient(url) {
  if (!Client) return null;

  const username = readTrimmedString('ES_USERNAME') || 'elastic';
  const password = readTrimmedString('ES_PASSWORD');
  const caCert   = readTrimmedString('ES_CA_CERT_PATH');

  // ── Startup credential diagnostics (mirrors Carbon Migrate) ──────────────
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
    requestTimeout: 50_000,
    maxRetries: 0,
  };

  if (caCert) {
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
    opts.tls = { rejectUnauthorized: false };
  }

  const c = new Client(opts);
  console.log('[esClient] Elasticsearch client initialised →', url);
  return c;
}

function getClient() {
  if (!Client) return null;

  const url = readTrimmedString('ES_URL');
  if (!url) return null;

  if (!_client || _activeUrl !== url) {
    _client    = buildClient(url);
    _activeUrl = url;
  }

  return _client;
}

/**
 * Returns the plain-HTTP equivalent of an HTTPS URL, or null if the URL is
 * already HTTP or is not a string.
 *   https://host:9243 → http://host:9243
 *   https://localhost:9200 → http://localhost:9200
 */
function httpFallbackUrl(url) {
  if (typeof url === 'string' && url.startsWith('https://')) {
    return url.replace(/^https:\/\//, 'http://');
  }
  return null;
}

/** True when err is a transport/network error rather than an HTTP-level response */
function isConnectionError(err) {
  // The ES client wraps network errors as ConnectionError / NoLivingConnectionsError.
  // HTTP 4xx/5xx come back as ResponseError with a statusCode.
  const name = err?.name ?? '';
  return (
    !err?.meta?.statusCode &&           // no HTTP status → not a server response
    (name.includes('ConnectionError') ||
     name.includes('NoLivingConnections') ||
     name.includes('TimeoutError') ||
     err?.code === 'ECONNREFUSED' ||
     err?.code === 'ECONNRESET' ||
     err?.code === 'ETIMEDOUT')
  );
}

/**
 * Execute an Elasticsearch call with circuit-breaker protection + HTTP fallback.
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

    // ── HTTP fallback ────────────────────────────────────────────────────────
    // Only attempt if this was a connection-level failure (not an HTTP error)
    // and the configured URL is HTTPS — plain-HTTP cluster may still be reachable.
    if (isConnectionError(err)) {
      const primaryUrl = readTrimmedString('ES_URL');
      const fallback   = httpFallbackUrl(primaryUrl);
      if (fallback && _activeUrl !== fallback) {
        console.warn(
          `[esClient] HTTPS connection failed (${err.message}) — retrying over HTTP: ${fallback}`
        );
        try {
          _client    = buildClient(fallback);
          _activeUrl = fallback;
          const result = await fn(_client);
          if (breaker.state === 'HALF_OPEN') {
            breaker.state = 'CLOSED';
            console.log('[esClient] Circuit breaker CLOSED — ES connection restored via HTTP fallback');
          }
          console.warn('[esClient] ⚠️  Running on plain HTTP fallback — update ES_URL to use http:// if this persists');
          return result;
        } catch (fallbackErr) {
          console.error('[esClient] HTTP fallback also failed:', fallbackErr.message);
        }
      }
    }

    tripBreaker();
    console.error('[esClient] ES call failed:', err.message);
    return null;
  }
}

/** Exposed for tests — reset singleton and breaker */
function _reset() {
  _client    = null;
  _activeUrl = null;
  breaker.state = 'CLOSED';
  breaker.lastFailureAt = null;
}

module.exports = { getClient, esCall, _reset, breaker };
