/**
 * API client for the Carbon Monitor console.
 *
 * Every call sends the session cookie. `credentials: 'same-origin'` rather than
 * 'include' because the console is always served from the same origin as the
 * API — 'include' would additionally send the cookie cross-origin, which this
 * app never needs.
 */

/**
 * Raised for a non-2xx response, carrying the status so callers can distinguish
 * an expired session (401) from a genuine failure.
 */
export class ApiError extends Error {
  constructor(message, status, body = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    // The parsed error body, so a caller can read structured fields a plain
    // message cannot carry — e.g. the 409 from POST /api/review/trigger names
    // the in-flight run's startedAt / mode / prNumbers for the "already
    // running" modal to show what is blocking the new run.
    this.body = body;
  }
}

async function request(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });

  let body = null;
  try {
    body = await res.json();
  } catch {
    // A body is not guaranteed — 202 and some errors return none.
  }

  if (!res.ok) {
    throw new ApiError(
      body?.error || body?.message || `Request failed (${res.status})`,
      res.status,
      body
    );
  }

  return body;
}

export const api = {
  // ── Session ──────────────────────────────────────────────────────────────
  authStatus: () => request('/api/auth/status'),

  login: (username, password) =>
    request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),

  logout: () => request('/api/auth/logout', { method: 'POST' }),

  // ── Status ───────────────────────────────────────────────────────────────
  status: () => request('/api/status'),
  config: () => request('/api/config'),

  /**
   * Liveness probe, and the only endpoint that carries the build version.
   *
   * GET /api/config deliberately does not: it describes the review target, not
   * the running binary. Unauthenticated, so the version is readable before a
   * session exists.
   */
  health: () => request('/api/health'),

  // ── Carbon MCP ───────────────────────────────────────────────────────────
  mcpStatus: () => request('/api/mcp/status'),

  mcpConnect: () => request('/api/mcp/connect', { method: 'POST' }),

  mcpTest: () => request('/api/mcp/test', { method: 'POST' }),

  /**
   * Clear the stored OAuth grant and strip Bob's MCP credentials.
   *
   * Idempotent server-side, so a double click cannot fail — but recovering the
   * connection needs a full browser sign-in, which is why the caller confirms.
   */
  mcpDisconnect: () => request('/api/mcp/disconnect', { method: 'POST' }),

  /** With no arguments, forces a refresh using the stored OAuth grant. */
  mcpRefresh: (credentials = {}) =>
    request('/api/mcp/refresh', {
      method: 'POST',
      body: JSON.stringify(credentials),
    }),

  // ── Reviews ──────────────────────────────────────────────────────────────

  /**
   * Start a review run.
   *
   * With no argument — or an empty list — the request carries no body at all and
   * the server auto-selects: the most recent MAX_PRS reviewable PRs from the
   * last DAYS_BACK days. Passing an array of numbers switches it to explicit
   * mode, where exactly those PRs are reviewed with no label, draft or age
   * filtering. The server re-validates either way; the console's own checks are
   * a convenience, not the authority.
   */
  triggerReview: (prNumbers) =>
    request('/api/review/trigger', {
      method: 'POST',
      ...(prNumbers && prNumbers.length ? { body: JSON.stringify({ prNumbers }) } : {}),
    }),

  reviewStatus: () => request('/api/review/status'),

  /**
   * Incremental tail of the running review's output.
   *
   * `since` is the `nextSince` cursor from the previous response, so each call
   * returns only new lines rather than the whole buffer.
   */
  reviewLogs: (since = 0) =>
    request(`/api/review/logs?since=${encodeURIComponent(since)}`),

  /**
   * Discard the server's ring buffer of review output.
   *
   * The buffer survives a run, so a failure from an hour ago is still on screen
   * when the next run starts.
   *
   * The server's sequence counter deliberately keeps counting across a clear, so
   * the emptied buffer looks to `read` like a gap — which it reports as
   * `dropped`. The caller therefore resets its own `since` cursor to 0 as well:
   * that both empties the view and stops the next poll announcing the clear the
   * operator just asked for as discarded output.
   */
  clearReviewLogs: () => request('/api/review/logs/clear', { method: 'POST' }),

  // ── Schedule ──────────────────────────────────────────────────────────────

  /** Current schedule config plus computed nextRunAt. */
  schedule: () => request('/api/schedule'),

  /**
   * Save a partial schedule update.
   *
   * Body: { enabled?: boolean, timeLocal?: string }
   * The server validates all fields and returns 400 with a descriptive message
   * on invalid input.
   */
  setSchedule: (patch) =>
    request('/api/schedule', {
      method: 'POST',
      body: JSON.stringify(patch),
    }),

  // ── Bobcoins ─────────────────────────────────────────────────────────────
  /** Current Bob gateway balance plus a summary of locally recorded spend. */
  credits: () => request('/api/credits'),

  /**
   * Per-review spend, newest first, plus a cumulative series.
   *
   * `limit` is optional; the server picks its own default when it is omitted.
   */
  creditsHistory: (limit) =>
    request(
      limit == null
        ? '/api/credits/history'
        : `/api/credits/history?limit=${encodeURIComponent(limit)}`
    ),
};
