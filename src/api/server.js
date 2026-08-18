/******************************************************************************
 * Carbon Monitor - API Server
 *
 * Serves the Carbon React operator console and the REST API behind it:
 *   - Carbon MCP connection management (OAuth bootstrap, refresh, manual entry)
 *   - Live dependency status for the console's tiles
 *   - Manual review triggers
 *
 * Runs identically on a laptop (`npm run api`) and in IBM Code Engine; the only
 * difference is which port is injected and whether the client bundle has been
 * built. Deliberately built on node:http with no web framework, so the container
 * carries no dependency that exists purely to serve four routes.
 *****************************************************************************/

// Load .env BEFORE requiring anything that reads process.env at import time —
// sessionAuth captures AUTH_REQUIRED the moment it is required, so a later load
// would leave sign-in silently off. Guarded to the entrypoint so importing this
// module from a test does not overwrite the env the test set up (loadEnv uses
// override:true).
if (require.main === module) require('../loadEnv');

const http = require('http');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const { URL } = require('url');
const { timingSafeEqual, createHash } = require('crypto');

const mcpConnection = require('./mcpConnection');
const healthChecks = require('./healthChecks');
const sessionAuth = require('./sessionAuth');
const bobCredits = require('./bobCredits');
const creditLedger = require('./creditLedger');
const reviewLog = require('./reviewLog');
const { reviewPRs, parsePrNumbers, resolveReviewTargets } = require('../index');
const { MAX_PRS_PER_RUN, N_DAYS_SINCE_PR_CREATED } = require('../constants');

// ── Configuration ───────────────────────────────────────────────────────────

// Code Engine injects PORT. API_PORT is kept for existing local workflows, and
// 3000 remains the local default so `npm run api` behaves as it always has.
const PORT = Number(process.env.PORT || process.env.API_PORT || 3000);

const API_SECRET = process.env.API_SECRET || '';
const ENABLE_AUTH = process.env.API_ENABLE_AUTH !== 'false';

/** Built client bundle. Absent during API-only local development. */
const CLIENT_DIR = path.join(__dirname, '..', '..', 'dist', 'client');

if (ENABLE_AUTH && !API_SECRET) {
  console.warn(
    '[api/server] WARNING: API_ENABLE_AUTH=true but API_SECRET is not set — ' +
      'all authenticated requests will be rejected.'
  );
}

// ── Authentication ──────────────────────────────────────────────────────────

/**
 * Verify a bearer token against API_SECRET using a timing-safe comparison, to
 * prevent timing-based secret enumeration.
 *
 * This is the machine-to-machine path — CI, curl, the deployment runbooks. The
 * console itself signs in and uses a session cookie instead.
 */
function verifyBearer(req) {
  const authHeader = req.headers.authorization;
  if (!API_SECRET || typeof authHeader !== 'string') return false;

  const token = authHeader.replace('Bearer ', '');

  // Compared as fixed-length digests rather than as raw buffers.
  //
  // timingSafeEqual requires equal BYTE lengths and THROWS when they differ, so
  // comparing the raw values means the length guard has to be exactly right —
  // and `token.length` counts UTF-16 code units, not bytes. A non-ASCII token
  // whose code-unit count happens to match the secret's is longer in bytes,
  // passes such a guard, and makes timingSafeEqual throw from inside the auth
  // check, where an unhandled rejection would take the process down. Hashing
  // both sides first makes the inputs unconditionally 32 bytes, so there is no
  // length case left to get wrong, and it still leaks nothing about the secret.
  const a = createHash('sha256').update(token, 'utf8').digest();
  const b = createHash('sha256').update(API_SECRET, 'utf8').digest();
  return timingSafeEqual(a, b);
}

/**
 * Authorize a request by either accepted credential.
 *
 * Two independent mechanisms, because two different callers exist: an operator
 * in a browser holds a session cookie, while scripts hold API_SECRET. Either
 * alone is sufficient; requiring both would break one of them.
 */
function isAuthorized(req) {
  // The AUTH_REQUIRED feature flag is the single switch, and it is OFF by
  // default: the standard deployment is open. Stated first and explicitly,
  // rather than falling out of hasValidSession() returning true when the flag is
  // off — a gate whose open state is a side effect of another function is one
  // refactor away from being wrong.
  if (!sessionAuth.AUTH_REQUIRED) return true;

  // Flag on: either credential admits. A browser holds a session cookie; CI and
  // curl hold API_SECRET. Requiring both would break one of them.
  if (sessionAuth.hasValidSession(req)) return true;
  if (ENABLE_AUTH && verifyBearer(req)) return true;
  return false;
}

// ── Response helpers ────────────────────────────────────────────────────────

function sendJSON(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data, null, 2));
}

function sendError(res, statusCode, message) {
  sendJSON(res, statusCode, {
    error: message,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Render a minimal self-contained HTML page.
 *
 * Used only for the OAuth callback, which the identity provider renders
 * directly — it cannot receive JSON, and it lands before the SPA has booted.
 */
function sendHTML(res, statusCode, { title, message, ok }) {
  const accent = ok ? '#0f62fe' : '#da1e28';
  res.writeHead(statusCode, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  body { font-family: 'IBM Plex Sans', system-ui, sans-serif; background:#161616;
         color:#f4f4f4; display:flex; align-items:center; justify-content:center;
         height:100vh; margin:0; }
  main { max-width: 34rem; padding: 2rem; border-left: 3px solid ${accent}; }
  h1 { font-size: 1.75rem; font-weight: 400; margin: 0 0 1rem; }
  p { color:#c6c6c6; line-height:1.5; margin:0 0 1.5rem; }
  a { color:#78a9ff; }
</style></head>
<body><main>
  <h1>${title}</h1>
  <p>${message}</p>
  <p><a href="/">Return to Carbon Monitor</a></p>
</main>
<script>
  // The console opened this flow in another tab and is polling for the result,
  // so closing here returns the operator to where they started.
  if (${ok ? 'true' : 'false'} && window.opener) { setTimeout(function(){ window.close(); }, 1500); }
</script>
</body></html>`);
}

/** Read and parse a JSON request body, tolerating an empty one. */
async function readJsonBody(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk.toString();
    // Bound the body so a malicious client cannot exhaust memory; every endpoint
    // here takes a small object.
    if (body.length > 256 * 1024) throw new Error('Request body too large');
  }
  return body ? JSON.parse(body) : {};
}

/**
 * Determine this app's externally reachable base URL.
 *
 * BASE_URL is authoritative and is folded into the Code Engine revision at
 * deploy time. The header fallback keeps local development working, where no
 * such variable exists.
 */
function getBaseUrl(req) {
  if (process.env.BASE_URL) return process.env.BASE_URL.replace(/\/+$/, '');
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers.host || `localhost:${PORT}`;
  return `${proto}://${host}`;
}

// ── MCP connection endpoints ────────────────────────────────────────────────

/**
 * POST /api/mcp/connect
 * Start the OAuth bootstrap and hand the browser an authorization URL.
 */
async function handleMcpConnect(req, res) {
  const redirectUri = `${getBaseUrl(req)}/api/mcp/callback`;
  const { authorizationUrl, state } = await mcpConnection.beginAuthorization(redirectUri);
  sendJSON(res, 200, { success: true, authorizationUrl, state, redirectUri });
}

/**
 * GET /api/mcp/callback
 * OAuth redirect target.
 *
 * Exempt from bearer auth by necessity — a browser redirect from the identity
 * provider carries no Authorization header. It is not unauthenticated in
 * practice: the request is rejected unless it carries an unexpired `state` this
 * process generated and has not yet consumed, and a code without a matching
 * state is useless because PKCE binds the exchange to a verifier held only here.
 */
async function handleMcpCallback(req, res, url) {
  const error = url.searchParams.get('error');
  if (error) {
    return sendHTML(res, 400, {
      ok: false,
      title: 'Authorization declined',
      message: `Carbon MCP returned "${error}". Nothing was changed.`,
    });
  }

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  if (!code || !state) {
    return sendHTML(res, 400, {
      ok: false,
      title: 'Invalid callback',
      message: 'The authorization response was missing its code or state.',
    });
  }

  try {
    const result = await mcpConnection.completeAuthorization({ code, state });
    const renewal = result.canAutoRefresh
      ? 'This container will now renew the connection automatically.'
      : 'No refresh token was issued, so this connection cannot renew itself.';

    return sendHTML(res, 200, {
      ok: true,
      title: 'Carbon MCP connected',
      message: renewal,
    });
  } catch (err) {
    return sendHTML(res, 400, {
      ok: false,
      title: 'Connection failed',
      message: err.message,
    });
  }
}

/**
 * POST /api/mcp/refresh
 *
 * Two behaviours, chosen by the request body:
 *   - with `token` and/or `sessionId` — store operator-supplied credentials
 *   - with neither — force a refresh using the stored OAuth refresh token
 *
 * The first form preserves the endpoint's original contract so existing scripts
 * and the deployment runbooks keep working unchanged.
 */
async function handleMcpRefresh(req, res) {
  const data = await readJsonBody(req);
  const { token, sessionId } = data;

  if (token || sessionId) {
    const result = await mcpConnection.setManualCredentials({ token, sessionId });
    return sendJSON(res, 200, {
      success: true,
      message: 'Carbon MCP credentials updated',
      mode: 'manual',
      timestamp: new Date().toISOString(),
      ...result,
    });
  }

  const result = await mcpConnection.refreshWithStoredToken();
  return sendJSON(res, 200, {
    success: true,
    message: 'Carbon MCP token refreshed',
    mode: 'oauth',
    timestamp: new Date().toISOString(),
    ...result,
  });
}

/** GET /api/mcp/status — connection detail without any secret material. */
async function handleMcpStatus(req, res) {
  const status = await mcpConnection.getStatus();
  sendJSON(res, 200, { success: true, ...status, timestamp: new Date().toISOString() });
}

/** POST /api/mcp/test — live probe; also repairs a session-backed connection. */
async function handleMcpTest(req, res) {
  const result = await mcpConnection.probe();
  sendJSON(res, 200, { success: true, ...result, timestamp: new Date().toISOString() });
}

/**
 * POST /api/mcp/disconnect
 * Drop the stored credentials so the next review genuinely runs without them.
 *
 * Idempotent, so the console can offer it unconditionally and a double-click
 * cannot produce an error the operator has to interpret.
 */
async function handleMcpDisconnect(req, res) {
  const result = await mcpConnection.disconnect();
  sendJSON(res, 200, { success: true, ...result, timestamp: new Date().toISOString() });
}

// ── Status and configuration ────────────────────────────────────────────────

/** GET /api/status — every dependency check, for the console's status panel. */
async function handleStatus(req, res) {
  const result = await healthChecks.runAll();
  sendJSON(res, 200, { success: true, ...result });
}

/** GET /api/health — liveness probe. Intentionally unauthenticated. */
function handleHealth(req, res) {
  sendJSON(res, 200, {
    status: 'healthy',
    service: 'carbon-monitor',
    version: require('../../package.json').version,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
}

/**
 * Just the host of ES_URL, so the console can name the cluster without the
 * response carrying credentials embedded in the URL, a port, or a path.
 */
function esHost() {
  const raw = process.env.ES_URL;
  if (!raw) return null;
  try {
    return new URL(raw).hostname;
  } catch (_) {
    return null;
  }
}

/** GET /api/config — sanitized runtime configuration. */
function handleConfig(req, res) {
  sendJSON(res, 200, {
    success: true,
    config: {
      agent: process.env.GITHUB_AI_AGENT_CLI || 'bob',
      owner: process.env.GITHUB_AI_AGENT_OWNER || 'carbon-design-system',
      repo: process.env.GITHUB_AI_AGENT_REPO || 'carbon',
      label: process.env.GITHUB_AI_AGENT_REVIEW_LABEL || 'AIReviewed',
      maxPRs: parseInt(process.env.GITHUB_AI_AGENT_MAX_PRS || '5', 10),
      daysBack: parseInt(process.env.GITHUB_AI_AGENT_DAYS_BACK || '21', 10),
      targetPR: process.env.GITHUB_AI_AGENT_PR_NUMBER || null,
      postInlineComments: process.env.GITHUB_AI_AGENT_POST_INLINE_COMMENTS !== 'false',
      postSummaryComment: process.env.GITHUB_AI_AGENT_POST_SUMMARY_COMMENT !== 'false',
      carbonMcpUrl: mcpConnection.MCP_URL,
      // Presence only — credentials are never returned by this API. The host is
      // enough to tell an operator which cluster is wired up; the full URL can
      // carry a path, port and query an anonymous-ish caller has no use for, and
      // ES_USERNAME / ES_PASSWORD are never exposed at all.
      elasticsearchConfigured: !!process.env.ES_URL,
      elasticsearchHost: esHost(),
    },
    timestamp: new Date().toISOString(),
  });
}

// ── Bobcoins ────────────────────────────────────────────────────────────────

/**
 * GET /api/credits — live balance plus what this app has spent.
 *
 * Authenticated like every other /api route: the account's budget is not
 * something an anonymous caller should be able to read.
 *
 * The balance is served from bobCredits' cache. The console polls this on a
 * timer from every open tab, and a 60-second-old budget figure is indis-
 * tinguishable from a live one at the resolution anyone reads it.
 */
async function handleCredits(req, res) {
  // Independent sources — a slow gateway must not also delay the local ledger.
  let [balance, summary] = await Promise.all([
    bobCredits.getBalance(),
    creditLedger.summary(),
  ]);

  // Re-read the balance when the ledger proves it is out of date.
  //
  // The two halves of this response have different freshness. The ledger is a
  // FILE, so a review recording spend is visible here instantly — but reviews
  // run in their own process (`node src/index.js`), and getBalance()'s cache is
  // per-process, so this server's copy can predate the review by up to the TTL.
  //
  // The visible symptom was a panel contradicting itself: the table showed a
  // finished review with "remaining after 97.77" while the headline above it
  // read 97.93, a mid-review figure this process had cached seconds earlier.
  //
  // A ledger entry newer than the balance we hold is exactly the signal that
  // spend has landed since, and it is the only cross-process signal available.
  // Forcing on that condition alone keeps the cache doing its real job —
  // absorbing the 30-second poll from every open tab — while making the numbers
  // agree whenever they otherwise would not.
  if (summary.lastRecordedAt && balance.fetchedAt) {
    const ledgerNewer =
      new Date(summary.lastRecordedAt).getTime() > new Date(balance.fetchedAt).getTime();
    if (ledgerNewer) {
      balance = await bobCredits.getBalance({ force: true });
      summary = await creditLedger.summary();
    }
  }

  sendJSON(res, 200, {
    success: true,
    balance,
    summary,
    timestamp: new Date().toISOString(),
  });
}

/**
 * GET /api/credits/history?limit=N — recent per-review spend.
 *
 * `entries` is newest first for tabular display; `cumulative` is oldest first
 * because a running total only reads correctly forwards.
 *
 * The URL is re-derived from req.url rather than threaded through the router:
 * ROUTES handlers take (req, res), and adding a third argument for one endpoint
 * would change the calling convention for all of them.
 */
async function handleCreditsHistory(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const requested = Number(url.searchParams.get('limit'));

  // Capped so a caller cannot ask for a response larger than the ledger's own
  // retention, and defaulted to a chartable window.
  const limit =
    Number.isFinite(requested) && requested > 0
      ? Math.min(Math.floor(requested), creditLedger.getMaxEntries())
      : 100;

  const entries = await creditLedger.readRecent(limit);

  sendJSON(res, 200, {
    success: true,
    entries,
    cumulative: creditLedger.buildCumulative(entries),
    timestamp: new Date().toISOString(),
  });
}

// ── Review triggering ───────────────────────────────────────────────────────

/**
 * Tracks the in-flight review so the console can show progress and so a second
 * trigger cannot start a concurrent run — two agents reviewing the same PR would
 * post duplicate comments.
 */
const reviewState = {
  running: false,
  startedAt: null,
  finishedAt: null,
  error: null,
  // What this run is reviewing, so the console can say "reviewing #22971, #22972"
  // instead of just "running". Both fields are rewritten on every trigger — a
  // finished explicit run must not leave its numbers behind for the auto run
  // after it to appear to own.
  mode: null,
  prNumbers: null,
};

/**
 * POST /api/review/trigger
 *
 * Body is optional. `prNumbers` — an array or a comma-separated string — reviews
 * exactly those PRs with no label, draft or age filtering, the same contract as
 * the --pr flag. Without it the run auto-selects as it always has.
 *
 * Returns 202 immediately and runs in the background: a review can take minutes,
 * far longer than Code Engine's 300-second request ceiling.
 */
async function handleReviewTrigger(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    return sendError(res, 400, `Could not read request body: ${error.message}`);
  }

  // JSON.parse happily returns null, a number or an array. `null.prNumbers`
  // throws, which would turn a malformed request into a 500 — and an array body
  // would be read as "no list" and silently start an auto review instead.
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return sendError(res, 400, 'Request body must be a JSON object, e.g. {"prNumbers": [22971]}');
  }

  // Validated by the very function reviewPRs uses, which returns an error string
  // rather than throwing or exiting. index.js resolves --pr and
  // GITHUB_AI_AGENT_PR_NUMBER at module load and calls process.exit(1) on a bad
  // value; that is correct for a CLI and fatal here, where one malformed body
  // would take down the console and the review loop with it. No request can
  // reach that code — it ran once, at require time, before the server existed.
  const parsed = parsePrNumbers(body.prNumbers, MAX_PRS_PER_RUN);
  if (!parsed.ok) return sendError(res, 400, parsed.error);

  // Checked AFTER the awaits above, not before them. Two triggers arriving
  // together would both have passed an earlier check while their bodies were
  // still being read, and two agents on one PR post duplicate comments. The
  // claim below is synchronous from here, so there is no window left.
  if (reviewState.running) {
    // Single-flight by design: one review at a time across this instance, so two
    // agents never review the same PR and post duplicate comments. The message is
    // written to stand on its own — an API caller that prints only `.message`
    // (curl, CI, another script) still learns what is running and since when. The
    // structured fields below are what the console's "already running" modal reads.
    const runningWhat =
      reviewState.mode === 'explicit' && reviewState.prNumbers?.length
        ? reviewState.prNumbers.map((n) => `#${n}`).join(', ')
        : 'auto-selected PRs';
    return sendJSON(res, 409, {
      success: false,
      message:
        `A review of ${runningWhat} is already running (started ${reviewState.startedAt}). ` +
        'Carbon Monitor runs one review session at a time — wait for it to finish before starting another.',
      startedAt: reviewState.startedAt,
      mode: reviewState.mode,
      prNumbers: reviewState.prNumbers,
    });
  }

  // Resolved rather than inferred from the body, so the response names what will
  // actually be reviewed: a container pinned with GITHUB_AI_AGENT_PR_NUMBER runs
  // that PR even when the request named none.
  const target = resolveReviewTargets({ prNumbers: parsed.prNumbers });

  reviewState.running = true;
  reviewState.startedAt = new Date().toISOString();
  reviewState.finishedAt = null;
  reviewState.error = null;
  reviewState.mode = target.mode;
  reviewState.prNumbers = target.prNumbers;

  sendJSON(res, 202, {
    success: true,
    message:
      target.mode === 'explicit'
        ? `Review triggered for ${target.prNumbers.map((n) => `#${n}`).join(', ')}, running in background`
        : 'Review triggered, running in background',
    startedAt: reviewState.startedAt,
    mode: target.mode,
    prNumbers: target.prNumbers,
    maxPRs: MAX_PRS_PER_RUN,
    // Auto mode only. An explicit list ignores the age window entirely, so
    // reporting it there would describe a filter that is not being applied.
    daysBack: target.mode === 'auto' ? N_DAYS_SINCE_PR_CREATED : undefined,
  });

  // Capture the run's output so the console can show progress instead of a
  // greyed-out button. Started before reviewPRs so the first line — the
  // [Carbon-Monitor] banner — is not lost, and stopped in the finally so a
  // throw cannot leave the console methods permanently wrapped.
  reviewLog.start(reviewState.startedAt);

  reviewPRs({ prNumbers: parsed.prNumbers })
    .then(() => {
      reviewState.error = null;
    })
    .catch((error) => {
      console.error('Background review error:', error);
      reviewState.error = error.message;
    })
    .finally(() => {
      reviewState.running = false;
      reviewState.finishedAt = new Date().toISOString();
      reviewLog.stop();
    });
}

/**
 * GET /api/review/logs?since=N&limit=M
 *
 * Incremental log tail for the console. The client keeps the `nextSince` cursor
 * from the previous response and polls with it, so each request carries only new
 * output rather than the whole buffer.
 */
function handleReviewLogs(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const since = Number(url.searchParams.get('since')) || 0;

  // Capped so a caller cannot pull the entire buffer in one response, and
  // defaulted to more than a poll interval's worth of output.
  const requested = Number(url.searchParams.get('limit'));
  const limit =
    Number.isFinite(requested) && requested > 0 ? Math.min(requested, 1000) : 500;

  sendJSON(res, 200, {
    success: true,
    ...reviewLog.read(since, limit),
    running: reviewState.running,
    timestamp: new Date().toISOString(),
  });
}

/**
 * POST /api/review/logs/clear
 *
 * Empties the log buffer so the operator can start from a clean console without
 * waiting for the next run to reset it.
 *
 * Deliberately allowed while a run is in flight — unlike a trigger, this cannot
 * produce duplicate comments, and the common reason to clear is that a long run
 * has filled the pane with output already read. Capture stays active and new
 * lines keep arriving; only what was already buffered is dropped.
 *
 * `cleared` is the number of lines discarded, so the console can say what
 * happened rather than leaving the operator to wonder whether the button worked
 * on an already-empty buffer.
 */
function handleReviewLogsClear(req, res) {
  const cleared = reviewLog.clear();

  sendJSON(res, 200, {
    success: true,
    cleared,
    running: reviewState.running,
    timestamp: new Date().toISOString(),
  });
}

/**
 * GET /api/review/status — state of the most recent or current run, including
 * `mode` and `prNumbers` so the console can show what is being reviewed.
 */
function handleReviewStatus(req, res) {
  sendJSON(res, 200, { success: true, ...reviewState, timestamp: new Date().toISOString() });
}

// ── Static client ───────────────────────────────────────────────────────────

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

/**
 * Serve the built client, falling back to index.html so client-side routes
 * survive a page reload.
 *
 * Returns false when the bundle is absent, which is the normal state during
 * API-only local development; the caller then explains that rather than 404ing.
 */
async function serveClient(req, res, pathname) {
  if (!fs.existsSync(CLIENT_DIR)) return false;

  // Resolve inside CLIENT_DIR and verify containment, so encoded traversal in the
  // request path cannot reach files outside the bundle.
  const requested = pathname === '/' ? '/index.html' : pathname;
  const candidate = path.join(CLIENT_DIR, path.normalize(requested));
  const filePath =
    candidate.startsWith(CLIENT_DIR + path.sep) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()
      ? candidate
      : path.join(CLIENT_DIR, 'index.html');

  if (!fs.existsSync(filePath)) return false;

  const ext = path.extname(filePath);
  const body = await fsp.readFile(filePath);

  // Vite fingerprints asset filenames, so everything under /assets is immutable;
  // index.html must never be cached or a deploy would not reach open tabs.
  const cacheControl = filePath.includes(`${path.sep}assets${path.sep}`)
    ? 'public, max-age=31536000, immutable'
    : 'no-cache';

  res.writeHead(200, {
    'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
    'Cache-Control': cacheControl,
  });
  res.end(body);
  return true;
}

// ── Router ──────────────────────────────────────────────────────────────────

/** Route table for authenticated JSON endpoints. */
const ROUTES = {
  'GET /api/status': handleStatus,
  'GET /api/config': handleConfig,
  'GET /api/credits': handleCredits,
  'GET /api/credits/history': handleCreditsHistory,
  'GET /api/mcp/status': handleMcpStatus,
  'POST /api/mcp/connect': handleMcpConnect,
  'POST /api/mcp/refresh': handleMcpRefresh,
  'POST /api/mcp/test': handleMcpTest,
  'POST /api/mcp/disconnect': handleMcpDisconnect,
  'POST /api/review/trigger': handleReviewTrigger,
  'GET /api/review/status': handleReviewStatus,
  'GET /api/review/logs': handleReviewLogs,
  'POST /api/review/logs/clear': handleReviewLogsClear,
};

/**
 * High-frequency routes polled automatically by the console or the Code Engine
 * health probe. Logging them produces hundreds of identical lines per review run
 * with no diagnostic value. All other routes — POSTs, the OAuth callback, auth
 * events, 404s — are still logged.
 *
 * Set LOG_LEVEL=debug to disable the filter and log everything (useful when
 * diagnosing a polling-related problem). deploy_ce.sh already injects
 * LOG_LEVEL=info, which keeps the filter active in production.
 */
const SILENT_GET_ROUTES = new Set([
  '/api/health',          // CE health probe every 30 s + console on mount
  '/api/status',          // console status panel, every 30 s
  '/api/mcp/status',      // same 30 s batch
  '/api/review/status',   // same 30 s batch
  '/api/review/logs',     // log tail every 2 s while a review is running
  '/api/credits',         // same 30 s batch
  '/api/credits/history', // same 30 s batch
  '/api/auth/status',     // App.jsx on mount + after every 401
  '/api/config',          // Console.jsx once on mount
]);

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  const method = req.method;

  // Static font assets under /plex are fetched on every cold page load and tell
  // an operator nothing — silence them the same way as the API polling routes.
  const isSilentFont =
    method === 'GET' &&
    pathname.startsWith('/plex/') &&
    (pathname.endsWith('.woff2') || pathname.endsWith('.woff'));

  const silenced =
    process.env.LOG_LEVEL !== 'debug' &&
    (method === 'OPTIONS' ||
      (method === 'GET' && (SILENT_GET_ROUTES.has(pathname) || isSilentFont)));
  if (!silenced) console.log(`${method} ${pathname}`);

  // The console is served from this same origin, so CORS is only needed for
  // local development against a separate Vite dev server.
  res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // Unauthenticated by design: liveness probing, the OAuth redirect target, and
  // the sign-in endpoints themselves (which are the way to become authenticated).
  if (pathname === '/api/health' && method === 'GET') return handleHealth(req, res);
  if (pathname === '/api/mcp/callback' && method === 'GET') {
    return handleMcpCallback(req, res, url);
  }
  if (pathname === '/api/auth/status' && method === 'GET') {
    return sendJSON(res, 200, { success: true, ...sessionAuth.status(req) });
  }
  if (pathname === '/api/auth/login' && method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const result = sessionAuth.login(res, body);
      return sendJSON(res, result.status, result.body);
    } catch (error) {
      return sendError(res, 400, error.message);
    }
  }
  if (pathname === '/api/auth/logout' && method === 'POST') {
    const result = sessionAuth.logout(res);
    return sendJSON(res, result.status, result.body);
  }

  if (pathname.startsWith('/api/')) {
    // The authorization check is inside the try, not before it. It parses
    // attacker-controlled headers, so a throw there is exactly as reachable as
    // one from a handler — and an unguarded one would escape handleRequest and
    // become an unhandled rejection that kills the whole single instance.
    try {
      if (!isAuthorized(req)) {
        return sendError(res, 401, 'Unauthorized: sign in or supply a valid API token');
      }

      const handler = ROUTES[`${method} ${pathname}`];
      if (!handler) return sendError(res, 404, 'Not found');

      return await handler(req, res);
    } catch (error) {
      console.error(`Handler error on ${method} ${pathname}:`, error);
      if (!res.headersSent) return sendError(res, 500, error.message);
      return undefined;
    }
  }

  // Everything else is the console.
  try {
    if (await serveClient(req, res, pathname)) return undefined;
  } catch (error) {
    console.error('Static file error:', error);
    return sendError(res, 500, 'Failed to serve client');
  }

  return sendJSON(res, 200, {
    service: 'carbon-monitor',
    message:
      'API is running, but the console bundle was not found. Build it with ' +
      '`npm run build:client`, or use the API directly at /api/health.',
    endpoints: ['GET /api/health', 'GET /api/status', ...Object.keys(ROUTES)],
  });
}

// ── Server lifecycle ────────────────────────────────────────────────────────

/**
 * Last line of defence around a request.
 *
 * handleRequest is async, so anything it rejects with becomes an unhandled
 * rejection — which Node turns into process exit. On a min-scale-1 deployment
 * that means one malformed request can take the console and the review loop
 * down until the container is restarted, so no rejection is allowed to escape.
 */
async function handleRequestSafely(req, res) {
  try {
    await handleRequest(req, res);
  } catch (error) {
    console.error('Unhandled request error:', error);
    if (!res.headersSent) sendError(res, 500, 'Internal server error');
    else res.end();
  }
}

function startServer() {
  const server = http.createServer(handleRequestSafely);

  // Belt and braces: a rejection from a background task (the review loop, the
  // MCP refresh timer) must not be fatal either. Logged, never exited on.
  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled promise rejection:', reason);
  });

  // Guard against slow-client abuse. Well above any endpoint's real cost — the
  // review itself is asynchronous and does not hold a request open.
  server.setTimeout(120_000);

  server.listen(PORT, () => {
    const clientBuilt = fs.existsSync(CLIENT_DIR);
    console.log(`\n${'='.repeat(64)}`);
    console.log('🚀 Carbon Monitor');
    console.log(`${'='.repeat(64)}`);
    console.log(`📡 Listening on:   http://localhost:${PORT}`);
    console.log(`🖥  Console:        ${clientBuilt ? 'served at /' : 'not built (npm run build:client)'}`);
    // Stated unambiguously at every start. An open console is the default and a
    // deliberate choice, but it should never be a surprise to whoever is looking
    // at the logs.
    console.log(
      `🔓 Sign-in:        ${
        sessionAuth.AUTH_REQUIRED
          ? 'REQUIRED (CONSOLE_USERNAME / CONSOLE_PASSWORD)'
          : 'open — no authentication (set AUTH_REQUIRED=true to enable)'
      }`
    );
    if (sessionAuth.AUTH_REQUIRED) {
      console.log(`🔑 Bearer API:     ${ENABLE_AUTH ? 'enabled (API_SECRET)' : 'disabled'}`);
    }
    console.log(`🔗 Carbon MCP:     ${mcpConnection.MCP_URL}`);
    if (process.env.BASE_URL) console.log(`🌐 Base URL:       ${process.env.BASE_URL}`);
    console.log(`${'='.repeat(64)}\n`);
  });

  // Keeps the connection alive without a human once an operator has bootstrapped
  // it — the entire point of the deployment.
  mcpConnection.startAutoRefresh();

  const shutdown = (signal) => {
    console.log(`${signal} received, shutting down gracefully...`);
    mcpConnection.stopAutoRefresh();

    // server.close() stops accepting NEW connections but resolves only once every
    // existing connection has ended — and on its own it never closes keep-alive
    // sockets. The console polls /api/status over a persistent keep-alive
    // connection, so a single open dashboard tab holds that count above zero
    // forever: the callback never fires, process.exit is never reached, and the
    // port stays bound. That is what turns a plain `kill`/Ctrl+C into a hang and
    // makes the next `npm run api` fail with EADDRINUSE. Close idle sockets so the
    // drain can finish, and hard-exit after a grace period so even a genuinely
    // stuck in-flight request cannot wedge shutdown.
    server.close(() => {
      console.log('Server closed');
      process.exit(0);
    });
    server.closeIdleConnections?.();
    setTimeout(() => {
      console.warn('Shutdown grace period elapsed; forcing exit.');
      process.exit(0);
    }, 5000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return server;
}

module.exports = { startServer, handleRequest };

if (require.main === module) {
  // .env is already loaded at the top of this file (before sessionAuth is
  // required), so it is not repeated here.
  startServer();
}

// Made with Bob
