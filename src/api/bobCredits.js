/******************************************************************************
 * Bobcoins Balance — Bob gateway client
 *
 * Reads the account's Bobcoins usage and monthly allowance from Bob Shell's
 * admin gateway, so the console can show what a review costs and how much of
 * the month's budget is left.
 *
 * ── Why the numbers come from here ──────────────────────────────────────────
 * Bob only reports a run's own cost in `-f stream-json` output, and this app
 * deliberately runs Bob in its default `pretty` format because src/reviewParser
 * parses that text. Switching formats to get a cost figure would break parsing
 * for every review. The gateway's running `usage` total is therefore the only
 * cost signal available, and a single review's spend is inferred by diffing two
 * snapshots taken around the run (see computeSpend).
 *
 * ── Why nothing here ever throws ────────────────────────────────────────────
 * getBalance() is called from a health check AND from inside the review loop.
 * A billing endpoint that is down, slow, or unauthorized must not turn a
 * working review into a failed one, so every failure is returned as
 * `{ available: false, reason }` rather than raised. The `reason` is what makes
 * the failure diagnosable — a missing key, a rejected key, an exhausted budget
 * and an unreachable host each need a different remedy.
 *****************************************************************************/

'use strict';

// ── Configuration ───────────────────────────────────────────────────────────

// Matches Bob Shell's own DEFAULT_GATEWAY_BASE_URL + ADMIN_SERVICE_PATH, so the
// balance shown here is the same one `bob` bills against.
const DEFAULT_BASE_URL = 'https://api.us-east.bob.ibm.com';
const ADMIN_SERVICE_PATH = '/admin/v1';

/** Gateway origin, overridable for a non-us-east instance. */
function getBaseUrl() {
  return (process.env.BOB_GATEWAY_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

/** Warned-about variables, so a bad value is reported once and not per call. */
const warnedEnv = new Set();

/**
 * A positive, finite millisecond value from the environment, or the default.
 *
 * Deliberately strict, and matches creditLedger.getMaxEntries. `Number('10s')`
 * is NaN, and NaN silently destroys both knobs it feeds: `setTimeout(fn, NaN)`
 * is clamped to ~0ms, so every gateway call would abort before it could finish,
 * and `Date.now() - cachedAt < NaN` is always false, so the cache would never
 * hit. Both failures are invisible at the call site, so a rejected value is
 * logged once rather than silently swallowed.
 */
function positiveMsFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;

  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return n;

  if (!warnedEnv.has(name)) {
    warnedEnv.add(name);
    console.warn(`[bobCredits] ${name}="${raw}" is not a positive number — using ${fallback}ms`);
  }
  return fallback;
}

/**
 * How long a fetched balance stays fresh.
 *
 * The console polls status on a timer and every open browser tab drives that
 * poll, so without a cache a handful of tabs would hammer the gateway once per
 * poll each. 60s is well inside the resolution anyone reads a budget at.
 */
function getTtlMs() {
  return positiveMsFromEnv('BOB_CREDITS_TTL_MS', 60_000);
}

/** Hard ceiling on the gateway call, so a hung host cannot stall a review. */
function getTimeoutMs() {
  return positiveMsFromEnv('BOB_CREDITS_TIMEOUT_MS', 10_000);
}

/**
 * Largest response body accepted from the gateway.
 *
 * A profile document is a few hundred bytes. Anything vastly larger is either a
 * wrong endpoint or a hostile/degraded one, and res.json() would buffer all of
 * it into memory on the single instance that also serves the console.
 */
const MAX_BODY_BYTES = 512 * 1024;

// ── Cache ───────────────────────────────────────────────────────────────────

let cached = null;
let cachedAt = 0;

/**
 * The unforced fetch currently in flight, if any.
 *
 * On a cold or expired cache every open browser tab's poll would otherwise start
 * its own gateway call, which is the stampede the cache exists to prevent — the
 * cache only helps once a call has *finished*. Forced callers never join this:
 * the review loop's "after" snapshot must observe spend that landed during the
 * run, and a request issued before the agent finished would under-report it.
 */
let inFlight = null;

/** Drop the cached balance. Used by tests and after a credential change. */
function resetCache() {
  cached = null;
  cachedAt = 0;
  inFlight = null;
}

// ── Response parsing ────────────────────────────────────────────────────────

/** Coerce a gateway field to a number, treating anything unusable as absent. */
function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Normalise `refresh_at` to an ISO string.
 *
 * Bob's own code treats it as unix seconds, but the field is echoed from a
 * service that may already have serialised it, so both shapes are accepted.
 */
function toIsoDate(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' || /^\d+$/.test(String(value))) {
    // Values below ~1e11 are seconds; anything larger is already milliseconds.
    const n = Number(value);
    const ms = n < 1e11 ? n * 1000 : n;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Does this object carry the fields that make it a profile rather than a wrapper? */
function looksLikeProfile(obj) {
  return (
    !!obj &&
    typeof obj === 'object' &&
    ('usage' in obj || 'budget_limit' in obj || 'plan' in obj || 'plan_name' in obj)
  );
}

/**
 * Choose the active entry from a list of profiles, falling back to the first.
 *
 * Filtered with the same looksLikeProfile test the single-object paths use.
 * Bob's UserProfileService profiles can carry connection config with no billing
 * fields at all; accepting one of those would produce `available: true` with
 * every figure null — a green health tile and a console asserting the numbers
 * are real, for a balance that was never actually read. An array carrying no
 * billing-bearing object must fall through to `bad-response`, exactly as the
 * same body would if it were not wrapped in an array.
 */
function pickActive(list, activeId) {
  const usable = list.filter(looksLikeProfile);
  if (usable.length === 0) return null;

  if (activeId !== null && activeId !== undefined) {
    const match = usable.find(
      (p) => p.id === activeId || p.profile_id === activeId || p.instance_id === activeId
    );
    if (match) return match;
  }

  return usable.find((p) => p.is_active === true || p.active === true) || usable[0];
}

/**
 * Extract the profile from whatever shape the gateway returned.
 *
 * Bob's UserProfileService stores a `profiles` ARRAY with an activeProfileId, so
 * GET /profile can legitimately answer with an array, a wrapper around one, or a
 * single profile object. Guessing wrong here would report another instance's
 * budget as this one's, so all three are handled explicitly.
 *
 * @param {*} body - Parsed JSON response
 * @returns {Object|null} The profile, or null when none can be identified
 */
function pickProfile(body) {
  if (!body || typeof body !== 'object') return null;

  // The shape the live gateway actually returns, verified against
  // api.us-east.bob.ibm.com:
  //
  //   { user_id, instances: [ { instance_id, plan_id, plan_name, refresh_at,
  //                             is_internal, teams: [ { id, name, usage,
  //                                                     budget_limit } ] } ] }
  //
  // The billing figures live on a TEAM nested inside an INSTANCE — they are not
  // on the profile root, which is where every other branch here looks. Checked
  // first because an instance also carries plan/refresh_at and would otherwise
  // be mistaken for a flat profile by looksLikeProfile, yielding a balance with
  // null usage and a null budget: available, and empty.
  const fromInstances = pickFromInstances(body);
  if (fromInstances) return fromInstances;

  if (Array.isArray(body)) return pickActive(body, null);

  if (Array.isArray(body.profiles)) {
    return pickActive(body.profiles, body.activeProfileId ?? body.active_profile_id ?? null);
  }

  if (looksLikeProfile(body.profile)) return body.profile;
  if (body.data && typeof body.data === 'object') return pickProfile(body.data);

  return looksLikeProfile(body) ? body : null;
}

/**
 * Flatten `instances[].teams[]` into the flat profile the rest of this module
 * expects.
 *
 * Selection is explicit rather than "first wins": an account can hold several
 * instances and several teams, and silently charging the console against the
 * wrong one would misreport the budget with no visible sign of it. BOB_INSTANCE_ID
 * and BOB_TEAM_ID pin the choice; without them the sole entry is used, and an
 * ambiguous list without a pin is reported so the operator can resolve it.
 *
 * @param {Object} body - Parsed /profile response
 * @returns {Object|null} A flat profile carrying usage and budget_limit
 */
function pickFromInstances(body) {
  const instances = Array.isArray(body.instances) ? body.instances : null;
  if (!instances || instances.length === 0) return null;

  const wantedInstance = process.env.BOB_INSTANCE_ID;
  const instance =
    (wantedInstance && instances.find((i) => i && i.instance_id === wantedInstance)) ||
    (instances.length === 1 ? instances[0] : null) ||
    instances[0];

  if (!instance || typeof instance !== 'object') return null;

  const teams = Array.isArray(instance.teams) ? instance.teams : [];
  const billable = teams.filter(
    (t) => t && (toNumber(t.usage) !== null || toNumber(t.budget_limit) !== null)
  );
  if (billable.length === 0) return null;

  const wantedTeam = process.env.BOB_TEAM_ID;
  const team =
    (wantedTeam && billable.find((t) => t.id === wantedTeam || t.team_id === wantedTeam)) ||
    billable.find((t) => t.name === 'default') ||
    billable[0];

  return {
    usage: team.usage,
    budget_limit: team.budget_limit,
    // plan_id on the instance is the slug getPlanDisplayName strips; the rest of
    // the module reads `plan`, so it is normalised here rather than special-cased
    // in toBalance.
    plan: instance.plan_id ?? instance.plan ?? null,
    plan_name: instance.plan_name ?? null,
    refresh_at: instance.refresh_at ?? null,
    is_internal: instance.is_internal === true,
    team_id: team.id ?? team.team_id ?? null,
    team_name: team.name ?? null,
    // Surfaced so the console can say WHICH budget it is showing when an account
    // spans more than one.
    ambiguous: instances.length > 1 || billable.length > 1,
  };
}

// ── Balance shape ───────────────────────────────────────────────────────────

/** An unavailable balance, carrying the reason it could not be determined. */
function unavailable(reason) {
  return {
    available: false,
    reason,
    usage: null,
    budgetLimit: null,
    remaining: null,
    percentRemaining: null,
    plan: null,
    planName: null,
    isTrial: false,
    refreshAt: null,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Project a gateway profile onto the balance contract.
 *
 * `usage` is money already SPENT and `budget_limit` is the cap, so remaining is
 * the difference — not the raw usage figure, which reads backwards.
 */
function toBalance(profile) {
  const usage = toNumber(profile.usage);
  const budgetLimit = toNumber(profile.budget_limit);

  const remaining =
    usage !== null && budgetLimit !== null
      ? Math.round((budgetLimit - usage) * 1e6) / 1e6
      : null;

  // An unlimited or unreported budget has no meaningful percentage; reporting 0
  // there would light up the console as if the account were exhausted.
  const percentRemaining =
    remaining !== null && budgetLimit !== null && budgetLimit > 0
      ? Math.round(Math.min(100, Math.max(0, (remaining / budgetLimit) * 100)) * 100) / 100
      : null;

  const plan = typeof profile.plan === 'string' ? profile.plan : null;

  return {
    available: true,
    reason: null,
    usage,
    budgetLimit,
    remaining,
    percentRemaining,
    plan,
    // Mirrors Bob's getPlanDisplayName: prefer the server's label, else strip
    // the internal `ibm_bob_` prefix so the console shows "trial", not the slug.
    planName: profile.plan_name || (plan ? plan.replace(/^ibm_bob_/, '') : null),
    isTrial: !!plan && plan.includes('ibm_bob_trial'),
    refreshAt: toIsoDate(profile.refresh_at),
    fetchedAt: new Date().toISOString(),
  };
}

// ── Gateway call ────────────────────────────────────────────────────────────

/**
 * Fetch the current Bobcoins balance.
 *
 * Never throws and never returns the API key — the returned object is safe to
 * serialise straight into an HTTP response.
 *
 * @param {Object}  [options]
 * @param {boolean} [options.force=false] - Bypass the cache (required around a
 *   review, where a stale "before" snapshot would silently zero the delta)
 * @returns {Promise<Object>} Balance per the /api/credits contract
 */
async function getBalance({ force = false } = {}) {
  const apiKey = process.env.BOB_API_KEY;
  if (!apiKey) {
    // Not cached: the key can appear at runtime via a secret remount, and this
    // path costs nothing anyway.
    return unavailable('no-api-key');
  }

  if (!force) {
    if (cached && Date.now() - cachedAt < getTtlMs()) return cached;
    // A poll that arrives while another poll is still waiting on the gateway
    // joins it rather than opening a second connection.
    if (inFlight) return inFlight;

    inFlight = fetchBalance(apiKey).finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  return fetchBalance(apiKey);
}

/**
 * One gateway round-trip, with the abort armed across the whole exchange.
 *
 * The timer is cleared in a `finally` that encloses the body read as well as the
 * fetch. Clearing it when the fetch promise settles would disarm it the moment
 * response HEADERS arrived, leaving `res.json()` to stream the body with no
 * ceiling at all — a gateway that answers 200 and then stalls would hang this
 * call indefinitely, in direct contradiction of the module's stated contract.
 */
async function fetchBalance(apiKey) {
  const headers = {
    // Bob's ApiKeyAuthStrategy: the scheme is literally `apikey`, not `Bearer`.
    Authorization: `apikey ${apiKey}`,
    Accept: 'application/json',
    'User-Agent': 'carbon-monitor',
  };
  if (process.env.BOB_INSTANCE_ID) headers['x-instance-id'] = process.env.BOB_INSTANCE_ID;
  if (process.env.BOB_TEAM_ID) headers['x-team-id'] = process.env.BOB_TEAM_ID;

  let result;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), getTimeoutMs());

  try {
    const res = await fetch(`${getBaseUrl()}${ADMIN_SERVICE_PATH}/profile`, {
      headers,
      signal: controller.signal,
    });

    if (res.status === 401 || res.status === 403) {
      result = unavailable('unauthorized');
    } else if (res.status === 402) {
      // Bob's own handleBudgetError treats 402 as budget exhausted. It is a
      // definite answer about the balance, not a lookup failure.
      result = unavailable('budget-exceeded');
    } else if (!res.ok) {
      result = unavailable(`http-${res.status}`);
    } else if (oversized(res)) {
      // Declared too large to be a profile — refused before it is buffered.
      result = unavailable('bad-response');
    } else {
      let body;
      try {
        // Still inside the try/finally below, so the abort remains armed: a
        // body that never finishes arriving is cut off at the same ceiling as
        // the headers were.
        body = await res.json();
      } catch (error) {
        // A body that was cut off is a reachability failure, not a malformed
        // profile, and must not be relabelled as one on the way past.
        if (controller.signal.aborted || error.name === 'AbortError') throw error;
        body = null;
      }

      const profile = pickProfile(body);
      result = profile ? toBalance(profile) : unavailable('bad-response');
    }
  } catch (error) {
    // AbortError and DNS/socket failures land here alike: from the caller's
    // point of view the balance simply could not be reached.
    result = unavailable('unreachable');
  } finally {
    clearTimeout(timer);
  }

  cached = result;
  cachedAt = Date.now();
  return result;
}

/**
 * Does the response declare a body far larger than a profile document?
 *
 * Only the declared length is checked — a lying or absent Content-Length is
 * still bounded by the abort timer above, which now covers the body read.
 */
function oversized(res) {
  const headers = res && res.headers;
  if (!headers || typeof headers.get !== 'function') return false;

  const declared = Number(headers.get('content-length'));
  return Number.isFinite(declared) && declared > MAX_BODY_BYTES;
}

// ── Per-review attribution ──────────────────────────────────────────────────

/**
 * Coins spent between two balance snapshots.
 *
 * Returns null rather than a guess whenever the difference cannot be trusted:
 *   - either snapshot is missing or unavailable
 *   - the monthly budget reset between them (refresh_at passed mid-review), so
 *     the two usage figures count from different periods
 * A wrong cost recorded as fact is worse than an honest gap in the ledger.
 *
 * Note this attributes ALL account spend in the window to this review, which is
 * exact for a single-review-at-a-time process but absorbs concurrent spend if
 * another container shares the account. Entries are tagged `balance-delta` so
 * that imprecision is visible downstream.
 *
 * @param {Object|null} before
 * @param {Object|null} after
 * @returns {number|null} Bobcoins spent, or null when undeterminable
 */
/**
 * Did the monthly budget roll over between the two snapshots?
 *
 * A negative delta is only the *visible* half of a reset — it shows up when the
 * month's prior usage exceeded what this run then spent. The other half is
 * silent and worse: an account that had spent 0.4 before a run costing 3.0 sees
 * usage reset to 0 and climb to 3.0, giving a positive, finite, entirely
 * plausible delta of 2.6 that would be written to the ledger as fact, under-
 * reporting by the whole pre-reset month. Both snapshots already carry the data
 * needed to tell, so it is checked directly rather than inferred from the sign.
 *
 * Two signals, because gateways differ in how promptly they advance the field:
 *   - refresh_at moved, i.e. the period being reported is not the same one
 *   - the "before" reset instant has already passed by the time "after" was read
 */
function budgetResetBetween(before, after) {
  if (before.refreshAt && after.refreshAt && before.refreshAt !== after.refreshAt) return true;

  const resetAt = Date.parse(before.refreshAt);
  const afterAt = Date.parse(after.fetchedAt);
  return Number.isFinite(resetAt) && Number.isFinite(afterAt) && resetAt <= afterAt;
}

function computeSpend(before, after) {
  if (!before || !after || !before.available || !after.available) return null;
  if (typeof before.usage !== 'number' || typeof after.usage !== 'number') return null;
  if (budgetResetBetween(before, after)) return null;

  const delta = after.usage - before.usage;
  if (!Number.isFinite(delta) || delta < 0) return null;

  // Float subtraction of two large running totals leaves noise well below any
  // real cost; rounding keeps the ledger readable.
  return Math.round(delta * 1e6) / 1e6;
}

module.exports = {
  getBalance,
  computeSpend,
  resetCache,
  pickProfile,
  DEFAULT_BASE_URL,
  ADMIN_SERVICE_PATH,
};
