/******************************************************************************
 * Carbon MCP Connection Manager
 *
 * Owns everything about the container's connection to the Carbon MCP server:
 * discovery, the OAuth authorization-code flow, unattended token refresh, and
 * writing the resulting credentials into Bob Shell's MCP configuration.
 *
 * ── Why this module exists ──────────────────────────────────────────────────
 * Carbon MCP authenticates with a w3id id_token that expires roughly two hours
 * after issue. On a developer Mac, Bob refreshes that by opening a browser. A
 * Code Engine container has no browser, so without this module the connection
 * dies every couple of hours and stays dead until a human pastes a new token.
 *
 * Carbon MCP advertises `grant_types_supported: ['authorization_code',
 * 'refresh_token']` but NOT `device_code`, so the container cannot bootstrap a
 * session on its own. It can, however, finish the job once a human has signed
 * in exactly once through this app's own UI:
 *
 *   1. BOOTSTRAP (human, once)  — the UI sends the operator to Carbon MCP's
 *      /authorize with PKCE; the callback lands back on this app and is
 *      exchanged for an id_token + refresh_token.
 *   2. STEADY STATE (unattended) — a timer redeems the refresh_token for a new
 *      id_token before the old one expires and rewrites Bob's mcp.json.
 *
 * Refresh tokens ROTATE: every refresh may return a new refresh_token, and the
 * old one is invalidated. Persisting the rotated value is therefore mandatory —
 * dropping it breaks the chain and forces a human back through step 1.
 *
 * ── The manual fallback ─────────────────────────────────────────────────────
 * Operators can instead paste a bearer token and an X-MCP-Session id. The
 * session id is the durable half: carbon-mcp's authGateWithRefresh mints a
 * fresh id_token from the session alone even when the bearer is absent or
 * expired, so a pasted session keeps working long after its bearer has died.
 *****************************************************************************/

const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const esClient = require('../observability/esClient');

// ── Configuration ───────────────────────────────────────────────────────────

const MCP_URL =
  process.env.CARBON_MCP_URL || 'https://mcp.carbondesignsystem.com/mcp';

const SERVER_NAME = 'carbon-mcp';

// Tools the agent is permitted to call without an interactive prompt. A headless
// `bob run` has no way to answer a permission prompt, so anything omitted here
// would hang the review until the 10-minute timeout fires.
const ALWAYS_ALLOW = [
  'labs_search',
  'get_charts',
  'code_search',
  'docs_search',
  'code_audit',
];

// Renew this far ahead of expiry. Carbon MCP's own REFRESH_MARGIN_SEC default is
// 300s; going wider means a single failed attempt still leaves room to retry
// before the token actually dies.
const REFRESH_MARGIN_SEC = Number(process.env.MCP_REFRESH_MARGIN_SEC || 900);

// How often the background timer re-evaluates expiry. Cheap — it only performs
// network I/O when a token is actually close to expiring.
const REFRESH_CHECK_MS = Number(process.env.MCP_REFRESH_CHECK_MS || 60_000);

// Authorization requests that are started but never completed would otherwise
// accumulate in memory for the life of the process.
const PENDING_AUTH_TTL_MS = 10 * 60 * 1000;

/** Bob's global MCP server configuration directory. */
function getBobConfigDir() {
  return path.join(os.homedir(), '.bob', 'settings');
}

/** Bob's global MCP server configuration file. */
function getBobMcpConfigPath() {
  return path.join(getBobConfigDir(), 'mcp.json');
}

/**
 * File path for the connection state — used by the FILE backend (local dev, and
 * any deployment without Elasticsearch). Defaults next to Bob's own state.
 *
 * Note: in Code Engine this file is on the ephemeral container layer and does NOT
 * survive an instance replacement. The cloud deployment sets
 * MCP_STATE_BACKEND=elasticsearch (see readState/writeState) so the refresh token
 * is persisted durably in ES instead, which is what keeps the connection alive
 * across redeploys and platform recycling.
 */
function getStatePath() {
  if (process.env.MCP_STATE_PATH) return process.env.MCP_STATE_PATH;

  const newPath = path.join(
    os.homedir(),
    '.config',
    'carbon-monitor',
    'mcp-state.json'
  );
  const oldPath = path.join(
    os.homedir(),
    '.bob',
    'carbon-monitor-mcp-state.json'
  );

  const fssync = require('fs');
  if (fssync.existsSync(oldPath) && !fssync.existsSync(newPath)) {
    try {
      fssync.mkdirSync(path.dirname(newPath), { recursive: true });
      fssync.renameSync(oldPath, newPath);
      console.warn(
        '[mcpConnection] migrated state file to ~/.config/carbon-monitor/mcp-state.json'
      );
    } catch (e) {
      console.warn(
        `[mcpConnection] migration skipped, using legacy path: ${e.message}`
      );
      return oldPath;
    }
  }

  return newPath;
}

// ── In-memory state ─────────────────────────────────────────────────────────

/** Pending authorization requests, keyed by OAuth `state`. */
const pendingAuth = new Map();

/** Discovery metadata, cached for the process lifetime. */
let cachedMetadata = null;

/** Dynamically registered client id, cached for the process lifetime. */
let cachedClientId = null;

/** Background refresh timer handle. */
let refreshTimer = null;

/** Diagnostics surfaced in the UI status panel. */
let lastRefresh = null;
let lastRefreshError = null;

// ── Small helpers ───────────────────────────────────────────────────────────

function base64url(buffer) {
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

/**
 * Decode a JWT payload without verifying the signature.
 *
 * Verification is deliberately not attempted: this app is not the token's
 * audience and holds none of the issuer's keys. The decoded `exp` is used only
 * to decide when to refresh and what to display — never to authorize anything.
 *
 * @param {string} token
 * @returns {Object|null} Decoded claims, or null if the token is not a JWT
 */
function decodeJwt(token) {
  try {
    const parts = String(token).split('.');
    if (parts.length !== 3) return null;
    return JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
  } catch (_) {
    return null;
  }
}

/**
 * Seconds until the token expires, or null when that cannot be determined.
 * Negative values mean the token has already expired.
 */
function secondsUntilExpiry(token) {
  const claims = decodeJwt(token);
  if (!claims || typeof claims.exp !== 'number') return null;
  return claims.exp - Math.floor(Date.now() / 1000);
}

/** Fetch with a hard timeout so a hung endpoint cannot wedge the refresh loop. */
async function fetchWithTimeout(url, options = {}, timeoutMs = 15_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ── Persisted state ─────────────────────────────────────────────────────────
//
// The connection state — crucially the ROTATING refresh token — must outlive the
// process. There are two backends:
//
//   • Elasticsearch (MCP_STATE_BACKEND=elasticsearch) — a single document in a
//     dedicated index. Code Engine's container filesystem is ephemeral, so a file
//     does not survive an instance replacement (a redeploy, an OOM, or platform
//     recycling) and the connection cannot self-heal. Elasticsearch does survive
//     it, and it is already wired up for telemetry, so no extra cloud resource is
//     needed. This is the cloud default.
//   • File (default) — getStatePath(), for local development and any deployment
//     without Elasticsearch.
//
// The document holds the refresh token — the one credential that can mint Carbon
// MCP access indefinitely — so it lives in a DEDICATED, access-restricted index,
// never the broadly-readable telemetry index.

/** Dedicated index holding the single connection-state document. */
const MCP_STATE_INDEX =
  process.env.MCP_STATE_INDEX || 'carbon-monitor-mcp-state';

/** Fixed id of that one document — one Carbon MCP connection per deployment. */
const MCP_STATE_DOC_ID = process.env.MCP_STATE_DOC_ID || 'connection';

/**
 * Whether Elasticsearch is the active, durable backend.
 *
 * Gated on an EXPLICIT opt-in, not merely on ES_URL being present: a developer
 * running locally against the shared telemetry cluster must not silently write to
 * the same singleton document the cloud instance owns.
 */
function usingEsStateBackend() {
  return (
    process.env.MCP_STATE_BACKEND === 'elasticsearch' && !!esClient.getClient()
  );
}

// A deployment that asked for ES durability but has no ES configured would
// silently fall back to the ephemeral file — the exact failure this backend
// exists to prevent. Say so loudly, once, at startup.
if (process.env.MCP_STATE_BACKEND === 'elasticsearch' && !process.env.ES_URL) {
  console.warn(
    '[mcpConnection] MCP_STATE_BACKEND=elasticsearch but ES_URL is not set — ' +
      'falling back to the ephemeral state file. The Carbon MCP connection will ' +
      'NOT survive an instance replacement until Elasticsearch is configured.'
  );
}

/**
 * Read persisted connection state.
 * @returns {Promise<Object>} State object; empty when nothing is stored yet
 */
async function readState() {
  return usingEsStateBackend() ? readStateFromEs() : readStateFromFile();
}

/**
 * Persist connection state.
 * @param {Object} state
 */
async function writeState(state) {
  return usingEsStateBackend()
    ? writeStateToEs(state)
    : writeStateToFile(state);
}

// ── File backend ─────────────────────────────────────────────────────────────

async function readStateFromFile() {
  try {
    return JSON.parse(await fs.readFile(getStatePath(), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

/**
 * Written 0600 because it holds the refresh token — the single credential that
 * can mint new Carbon MCP access indefinitely.
 */
async function writeStateToFile(state) {
  const statePath = getStatePath();
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, JSON.stringify(state, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
}

// ── Elasticsearch backend ────────────────────────────────────────────────────

async function readStateFromEs() {
  const client = esClient.getClient();
  try {
    // GET by id is real-time in Elasticsearch (it reads the translog), so state
    // written by the previous instance is visible to a fresh one immediately —
    // no index refresh delay to wait out on boot.
    const res = await client.get({
      index: MCP_STATE_INDEX,
      id: MCP_STATE_DOC_ID,
    });
    return res._source || {};
  } catch (error) {
    // 404 = never connected yet: no document, or the index does not exist. Same
    // meaning as an absent file — empty state, not an error.
    if (error.meta?.statusCode === 404) return {};
    throw error;
  }
}

async function writeStateToEs(state) {
  const client = esClient.getClient();

  // The write must be durable before a freshly rotated refresh token is relied
  // upon, so a transient network blip cannot silently drop it. index() with a
  // fixed id upserts (create-or-replace), so there is exactly one state document
  // per deployment; refresh:true makes it immediately visible to any reader.
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await client.index({
        index: MCP_STATE_INDEX,
        id: MCP_STATE_DOC_ID,
        document: { ...state, updatedAt: new Date().toISOString() },
        refresh: true,
      });
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
      }
    }
  }
  throw new Error(
    `Failed to persist Carbon MCP state to Elasticsearch index ` +
      `'${MCP_STATE_INDEX}': ${lastError.message}`
  );
}

// ── Bob MCP configuration ───────────────────────────────────────────────────

/**
 * Read Bob's MCP server configuration.
 * @returns {Promise<Object>} Parsed config, or an empty shell when absent
 */
async function readBobMcpConfig() {
  try {
    return JSON.parse(await fs.readFile(getBobMcpConfigPath(), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return { mcpServers: {} };
    throw error;
  }
}

/**
 * Write the carbon-mcp entry into Bob's MCP configuration.
 *
 * Existing fields on the entry are preserved so operator-tuned settings (extra
 * allowed tools, a custom timeout) survive a token refresh; only the headers
 * this function owns are replaced.
 *
 * @param {Object} options
 * @param {string} [options.token] - Bearer id_token
 * @param {string} [options.sessionId] - X-MCP-Session opaque session id
 * @returns {Promise<Object>} Summary of what was written
 */
async function writeBobMcpHeaders({ token, sessionId }) {
  if (!token && !sessionId) {
    throw new Error('Either a token or a sessionId is required');
  }

  const config = await readBobMcpConfig();
  if (!config.mcpServers) config.mcpServers = {};

  const existing = config.mcpServers[SERVER_NAME] || {
    type: 'streamable-http',
    url: MCP_URL,
    alwaysAllow: ALWAYS_ALLOW,
    timeout: 300000,
    disabled: false,
  };

  const headers = { ...(existing.headers || {}) };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  // A session id is only ever added or replaced, never cleared by a token-only
  // write: it is the durable credential that lets carbon-mcp refresh server-side
  // once the bearer expires, so silently dropping it would remove the safety net.
  if (sessionId) {
    headers['X-MCP-Session'] = sessionId;
  }

  // Union, so an entry written before a tool was added still gets it and a
  // headless run never waits on an approval prompt.
  const alwaysAllow = [
    ...new Set([...(existing.alwaysAllow || []), ...ALWAYS_ALLOW]),
  ];

  config.mcpServers[SERVER_NAME] = {
    ...existing,
    headers,
    alwaysAllow,
    disabled: false,
  };

  await fs.mkdir(getBobConfigDir(), { recursive: true });
  await fs.writeFile(getBobMcpConfigPath(), JSON.stringify(config, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });

  return {
    configPath: getBobMcpConfigPath(),
    serverName: SERVER_NAME,
    hasToken: !!headers['Authorization'],
    hasSession: !!headers['X-MCP-Session'],
  };
}

/**
 * The URL and headers of the carbon-mcp entry in Bob's mcp.json, for agents that
 * take their MCP config as a file of their own. That file stays the credential
 * store the refresh timer writes.
 * @returns {Promise<{url: string, headers: Object}|null>} null without a bearer
 */
async function getCredentials() {
  let entry;
  try {
    entry = (await readBobMcpConfig()).mcpServers?.[SERVER_NAME];
  } catch (_) {
    return null;
  }
  // Header names are case-insensitive and the file can be hand-edited.
  const pick = (name) => {
    const key = Object.keys(entry?.headers || {}).find(
      (k) => k.toLowerCase() === name.toLowerCase()
    );
    return key ? entry.headers[key] : undefined;
  };
  const bearer = pick('Authorization');
  if (!bearer) return null;
  const session = pick('X-MCP-Session');
  return {
    url: entry.url || MCP_URL,
    headers: {
      Authorization: bearer,
      ...(session ? { 'X-MCP-Session': session } : {}),
    },
  };
}

// ── OAuth discovery and registration ────────────────────────────────────────

/**
 * Discover Carbon MCP's authorization endpoints.
 *
 * Follows RFC 9728 (protected-resource metadata) to find the authorization
 * server, then RFC 8414 for its endpoints — rather than hardcoding paths, which
 * differ between the root and /mcp mounts of carbon-mcp's OAuth router.
 *
 * @returns {Promise<Object>} { issuer, authorization_endpoint, token_endpoint, registration_endpoint }
 */
async function discover() {
  if (cachedMetadata) return cachedMetadata;

  const origin = new URL(MCP_URL).origin;

  // RFC 9728 — the MCP spec's preferred discovery entry point.
  let authServer = origin;
  try {
    const res = await fetchWithTimeout(
      `${origin}/.well-known/oauth-protected-resource`
    );
    if (res.ok) {
      const prm = await res.json();
      if (
        Array.isArray(prm.authorization_servers) &&
        prm.authorization_servers[0]
      ) {
        authServer = prm.authorization_servers[0];
      }
    }
  } catch (_) {
    // Non-fatal: fall through to the origin and let RFC 8414 discovery decide.
  }

  // RFC 8414, with OIDC discovery as the fallback.
  const candidates = [
    `${authServer}/.well-known/oauth-authorization-server`,
    `${authServer}/.well-known/openid-configuration`,
  ];

  for (const url of candidates) {
    try {
      const res = await fetchWithTimeout(url);
      if (!res.ok) continue;
      const meta = await res.json();
      if (meta.authorization_endpoint && meta.token_endpoint) {
        cachedMetadata = meta;
        return meta;
      }
    } catch (_) {
      // Try the next candidate.
    }
  }

  throw new Error(
    `Could not discover OAuth endpoints for ${MCP_URL}. ` +
      'Check that the container can reach the Carbon MCP host.'
  );
}

/**
 * Obtain a client_id via dynamic client registration (RFC 7591).
 *
 * Carbon MCP is a public client (`token_endpoint_auth_methods_supported: ['none']`)
 * and accepts all registrations, so this needs no pre-provisioned credentials.
 * Registration failure is non-fatal — carbon-mcp's /authorize falls back to a
 * server-side client_id when the parameter is blank.
 *
 * @param {string} redirectUri
 * @returns {Promise<string|null>} client_id, or null when registration is unavailable
 */
async function registerClient(redirectUri) {
  if (cachedClientId) return cachedClientId;

  const meta = await discover();
  if (!meta.registration_endpoint) return null;

  try {
    const res = await fetchWithTimeout(meta.registration_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Carbon Monitor',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
    });

    if (!res.ok) return null;
    const reg = await res.json();
    cachedClientId = reg.client_id || null;
    return cachedClientId;
  } catch (_) {
    return null;
  }
}

// ── Authorization-code flow ─────────────────────────────────────────────────

/** Drop authorization requests the operator never completed. */
function prunePendingAuth() {
  const cutoff = Date.now() - PENDING_AUTH_TTL_MS;
  for (const [state, entry] of pendingAuth) {
    if (entry.createdAt < cutoff) pendingAuth.delete(state);
  }
}

/**
 * Begin the OAuth authorization-code flow.
 *
 * @param {string} redirectUri - This app's callback URL; must match at exchange
 * @returns {Promise<{authorizationUrl: string, state: string}>}
 */
async function beginAuthorization(redirectUri) {
  prunePendingAuth();

  const meta = await discover();
  const clientId = await registerClient(redirectUri);

  // PKCE (S256) is mandatory — carbon-mcp rejects /authorize without a challenge
  // and accepts no other challenge method.
  const codeVerifier = base64url(crypto.randomBytes(32));
  const codeChallenge = base64url(
    crypto.createHash('sha256').update(codeVerifier).digest()
  );
  const state = base64url(crypto.randomBytes(16));

  pendingAuth.set(state, { codeVerifier, redirectUri, createdAt: Date.now() });

  const url = new URL(meta.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (clientId) url.searchParams.set('client_id', clientId);

  return { authorizationUrl: url.toString(), state };
}

/**
 * Complete the OAuth flow and persist the resulting credentials.
 *
 * @param {Object} options
 * @param {string} options.code - Authorization code from the callback
 * @param {string} options.state - State parameter from the callback
 * @returns {Promise<Object>} Summary of the established connection
 */
async function completeAuthorization({ code, state }) {
  const pending = pendingAuth.get(state);
  if (!pending) {
    throw new Error(
      'Unknown or expired authorization state. Start the connection again.'
    );
  }
  pendingAuth.delete(state);

  const meta = await discover();

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: pending.redirectUri,
    code_verifier: pending.codeVerifier,
  });
  if (cachedClientId) body.set('client_id', cachedClientId);

  const res = await fetchWithTimeout(meta.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const tokens = await res.json();
  if (!res.ok) {
    throw new Error(
      `Token exchange failed (${res.status}): ${
        tokens.error_description || tokens.error || 'unknown error'
      }`
    );
  }

  const idToken = tokens.id_token || tokens.access_token;
  if (!idToken) {
    throw new Error('Token exchange returned no id_token or access_token');
  }

  // carbon-mcp's strict OAuth view omits session_id, so an OAuth-bootstrapped
  // connection is refreshed by this app rather than server-side. The field is
  // still read because the extended view does return it.
  const sessionId = tokens.session_id || undefined;

  await writeState({
    mode: 'oauth',
    refreshToken: tokens.refresh_token || null,
    sessionId: sessionId || null,
    redirectUri: pending.redirectUri,
    clientId: cachedClientId || null,
    connectedAt: new Date().toISOString(),
  });

  await writeBobMcpHeaders({ token: idToken, sessionId });

  lastRefresh = new Date().toISOString();
  lastRefreshError = null;

  return {
    mode: 'oauth',
    canAutoRefresh: !!tokens.refresh_token,
    expiresInSeconds: secondsUntilExpiry(idToken),
    sessionId: sessionId || null,
  };
}

// ── Unattended refresh ──────────────────────────────────────────────────────

/**
 * Redeem the stored refresh token for a fresh id_token.
 *
 * @returns {Promise<Object>} Result of the refresh
 */
async function refreshWithStoredToken() {
  const state = await readState();
  if (!state.refreshToken) {
    throw new Error(
      'No refresh token stored. Connect to Carbon MCP through the UI first.'
    );
  }

  const meta = await discover();

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: state.refreshToken,
  });
  if (state.clientId) body.set('client_id', state.clientId);

  const res = await fetchWithTimeout(meta.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const tokens = await res.json();
  if (!res.ok) {
    // A refused refresh usually means the token family was invalidated, which no
    // amount of retrying will fix — the operator has to sign in again. Flagging
    // it in state is what lets the UI say so instead of silently retrying hourly.
    await writeState({ ...state, needsReauth: true });
    throw new Error(
      `Refresh failed (${res.status}): ${
        tokens.error_description || tokens.error || 'unknown error'
      }`
    );
  }

  const idToken = tokens.id_token || tokens.access_token;
  if (!idToken) throw new Error('Refresh returned no id_token or access_token');

  // Refresh tokens rotate. Persisting the new one is what keeps the chain alive;
  // keeping the old one on a response that omits it is equally deliberate.
  await writeState({
    ...state,
    refreshToken: tokens.refresh_token || state.refreshToken,
    needsReauth: false,
    lastRefreshAt: new Date().toISOString(),
  });

  await writeBobMcpHeaders({ token: idToken, sessionId: state.sessionId });

  lastRefresh = new Date().toISOString();
  lastRefreshError = null;

  return {
    refreshed: true,
    expiresInSeconds: secondsUntilExpiry(idToken),
    rotated: !!tokens.refresh_token,
  };
}

/**
 * Refresh the connection if the current token is near expiry.
 * @param {boolean} [force=false] - Refresh regardless of remaining lifetime
 */
async function refreshIfNeeded(force = false) {
  const config = await readBobMcpConfig();
  const entry = config.mcpServers?.[SERVER_NAME];
  const authHeader = entry?.headers?.Authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');

  const remaining = token ? secondsUntilExpiry(token) : null;

  // A pasted session with no refresh token of our own is not stale — carbon-mcp
  // refreshes that one server-side from the session id, so there is nothing to do.
  const state = await readState();
  if (!state.refreshToken) {
    return {
      skipped: true,
      reason: 'no-refresh-token',
      expiresInSeconds: remaining,
    };
  }

  if (!force && remaining !== null && remaining > REFRESH_MARGIN_SEC) {
    return { skipped: true, reason: 'not-due', expiresInSeconds: remaining };
  }

  return refreshWithStoredToken();
}

/** Start the background refresh loop. Idempotent. */
function startAutoRefresh() {
  if (refreshTimer) return;

  refreshTimer = setInterval(() => {
    refreshIfNeeded().catch((error) => {
      lastRefreshError = error.message;
      console.error('[mcpConnection] auto-refresh failed:', error.message);
    });
  }, REFRESH_CHECK_MS);

  // Do not hold the event loop open on shutdown.
  if (typeof refreshTimer.unref === 'function') refreshTimer.unref();

  console.log(
    `[mcpConnection] auto-refresh active (every ${REFRESH_CHECK_MS / 1000}s, ` +
      `margin ${REFRESH_MARGIN_SEC}s)`
  );

  // Kick once now, without waiting a full interval. A freshly replaced instance
  // starts with an empty mcp.json but a valid refresh token in the persisted
  // state (Elasticsearch), so an immediate refresh rebuilds the live connection
  // in seconds — before the next review or the deploy's post-restart status check
  // — rather than up to REFRESH_CHECK_MS later. Backgrounded; never fatal.
  refreshIfNeeded().catch((error) => {
    lastRefreshError = error.message;
    console.error('[mcpConnection] initial refresh failed:', error.message);
  });
}

/** Stop the background refresh loop. */
function stopAutoRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

// ── Manual credential entry ─────────────────────────────────────────────────

/**
 * Store operator-supplied credentials.
 *
 * @param {Object} options
 * @param {string} [options.token] - Bearer id_token
 * @param {string} [options.sessionId] - X-MCP-Session opaque session id
 * @returns {Promise<Object>} Summary of what was written
 */
async function setManualCredentials({ token, sessionId }) {
  if (!token && !sessionId) {
    throw new Error('Provide a bearer token, a session id, or both');
  }

  const written = await writeBobMcpHeaders({ token, sessionId });

  // Manual entry supersedes any OAuth grant: keeping a stale refresh token would
  // let the background timer overwrite the credentials just pasted.
  const previous = await readState();
  await writeState({
    ...previous,
    mode: 'manual',
    refreshToken: null,
    sessionId: sessionId || previous.sessionId || null,
    needsReauth: false,
    connectedAt: new Date().toISOString(),
  });

  return written;
}

// ── Disconnect ──────────────────────────────────────────────────────────────

/**
 * Take the connection down: forget the stored OAuth grant AND strip the
 * credentials out of Bob's MCP configuration.
 *
 * Both halves are required. Clearing state alone would leave a working bearer in
 * mcp.json, so the next review would still authenticate — and "sign out" that
 * leaves the credential usable is not a sign-out. Stripping the headers alone
 * would leave the refresh token behind, and the background timer would put a
 * fresh bearer straight back.
 *
 * The server ENTRY itself is kept, headers aside, so operator-tuned fields (a
 * custom timeout, a narrowed allow-list) survive a disconnect/reconnect cycle,
 * exactly as they survive a token refresh.
 *
 * `disabled` is deliberately left alone: an entry with no credentials already
 * fails closed at carbon-mcp, and reconnecting rewrites the flag anyway.
 *
 * The refresh timer keeps running. With no refresh token, refreshIfNeeded()
 * returns `skipped: no-refresh-token` on every tick, so it costs nothing and a
 * later reconnect works without restarting the process.
 *
 * Idempotent: a second call is a no-op that still reports success.
 *
 * @returns {Promise<Object>} Summary of what was cleared
 */
async function disconnect() {
  const config = await readBobMcpConfig();
  const entry = config.mcpServers?.[SERVER_NAME];

  const hadToken = !!entry?.headers?.Authorization;
  const hadSession = !!entry?.headers?.['X-MCP-Session'];

  if (entry) {
    // Matched case-insensitively. This app always writes the canonical spellings,
    // but HTTP header names are case-insensitive and a hand-edited mcp.json is a
    // supported way in — a surviving `authorization` key would keep working.
    const headers = {};
    for (const [name, value] of Object.entries(entry.headers || {})) {
      const lower = name.toLowerCase();
      if (lower === 'authorization' || lower === 'x-mcp-session') continue;
      headers[name] = value;
    }

    config.mcpServers[SERVER_NAME] = { ...entry, headers };

    await fs.mkdir(getBobConfigDir(), { recursive: true });
    await fs.writeFile(getBobMcpConfigPath(), JSON.stringify(config, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
  }

  const previous = await readState();
  const hadRefreshToken = !!previous.refreshToken;

  // Replaced, not deleted. A file saying "disconnected" outlives a restart and
  // keeps getStatus honest; deleting it would leave getStatus inferring `mode`
  // from the surviving server entry and reporting 'manual' for a connection that
  // no longer has any credentials at all.
  await writeState({
    mode: 'none',
    refreshToken: null,
    sessionId: null,
    needsReauth: false,
    disconnectedAt: new Date().toISOString(),
  });

  // In-memory diagnostics describe a connection that no longer exists.
  lastRefresh = null;
  lastRefreshError = null;

  return {
    disconnected: true,
    // What was actually there to remove — the operator's confirmation that a
    // credential really was in play, and the second call's proof that it wasn't.
    hadToken,
    hadSession,
    hadRefreshToken,
    configPath: getBobMcpConfigPath(),
  };
}

// ── Connectivity probe ──────────────────────────────────────────────────────

/**
 * Verify the configured credentials actually work against Carbon MCP.
 *
 * Sends `X-MCP-Force-Refresh: true`, which makes carbon-mcp attempt a
 * server-side refresh when it has the context to do so. That turns this from a
 * passive check into a repair: a pasted session whose bearer has expired is
 * refreshed by the act of probing it.
 *
 * @returns {Promise<Object>} Probe outcome
 */
async function probe() {
  const config = await readBobMcpConfig();
  const entry = config.mcpServers?.[SERVER_NAME];

  if (!entry?.headers?.Authorization && !entry?.headers?.['X-MCP-Session']) {
    return { reachable: false, authorized: false, reason: 'not-configured' };
  }

  const headers = {
    ...entry.headers,
    'X-MCP-Force-Refresh': 'true',
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };

  try {
    // An MCP `initialize` is the cheapest call that still exercises the full auth
    // path; anything lighter would pass without proving the credentials work.
    const res = await fetchWithTimeout(entry.url || MCP_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'carbon-monitor-probe', version: '1.4.0' },
        },
      }),
    });

    if (res.status === 401 || res.status === 403) {
      let detail = '';
      try {
        detail = (await res.json()).detail || '';
      } catch (_) {
        /* body may not be JSON */
      }
      return {
        reachable: true,
        authorized: false,
        status: res.status,
        reason: detail || 'credentials rejected',
      };
    }

    return { reachable: true, authorized: res.ok, status: res.status };
  } catch (error) {
    return { reachable: false, authorized: false, reason: error.message };
  }
}

// ── Status ──────────────────────────────────────────────────────────────────

/**
 * Summarise the connection for the UI.
 *
 * Returns only non-secret facts: expiry, mode, and which credentials are
 * present. Tokens and session ids are never included in the response.
 *
 * @returns {Promise<Object>} Status summary
 */
async function getStatus() {
  const config = await readBobMcpConfig();
  const entry = config.mcpServers?.[SERVER_NAME];
  const state = await readState();

  const authHeader = entry?.headers?.Authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  const claims = token ? decodeJwt(token) : null;
  const remaining = token ? secondsUntilExpiry(token) : null;

  return {
    configured: !!entry,
    url: entry?.url || MCP_URL,
    disabled: entry?.disabled === true,
    hasToken: !!token,
    hasSession: !!entry?.headers?.['X-MCP-Session'],
    mode: state.mode || (entry ? 'manual' : 'none'),
    canAutoRefresh: !!state.refreshToken,
    needsReauth: state.needsReauth === true,
    expiresInSeconds: remaining,
    expiresAt: claims?.exp ? new Date(claims.exp * 1000).toISOString() : null,
    // Whether the cached token carries a decoded identity, surfaced to the UI as
    // a generic readiness signal only. The identifying value (email / username)
    // is deliberately NOT returned, so an operator's address never reaches the
    // browser or the status payloads (/api/status, /api/mcp/status).
    authenticated: !!(claims?.email || claims?.preferred_username),
    connectedAt: state.connectedAt || null,
    lastRefreshAt: state.lastRefreshAt || lastRefresh,
    lastRefreshError,
    configPath: getBobMcpConfigPath(),
  };
}

module.exports = {
  beginAuthorization,
  completeAuthorization,
  refreshWithStoredToken,
  refreshIfNeeded,
  startAutoRefresh,
  stopAutoRefresh,
  setManualCredentials,
  disconnect,
  writeBobMcpHeaders,
  getCredentials,
  probe,
  getStatus,
  decodeJwt,
  secondsUntilExpiry,
  getBobMcpConfigPath,
  MCP_URL,
  SERVER_NAME,
};
