/******************************************************************************
 * Schedule Manager
 *
 * Owns the daily scheduled review: persistence, the schedule-zone time check, the
 * idempotency token that prevents double-firing, and the tick loop that runs
 * once a minute inside the API server.
 *
 * ── Design principles ───────────────────────────────────────────────────────
 * 1. Default-off. `enabled` is always false on a fresh install — the feature
 *    must be explicitly opted into from the UI.
 *
 * 2. Write-before-fire idempotency. The lastFiredMinute token is written to
 *    the state file BEFORE reviewPRs is called. If the process dies between
 *    the write and the run, that minute is skipped — acceptable. Firing twice
 *    posts duplicate comments to every PR in the run — not acceptable.
 *
 * 3. Fail loud, never fire wrong. If Intl cannot resolve the schedule zone
 *    (stripped ICU build), the scheduler disables itself with a clear warning
 *    rather than firing at the wrong time silently.
 *
 * 4. Single-flight respect. The scheduler claims reviewState.running = true
 *    synchronously — verbatim copy of lines 532–537 of server.js — before
 *    the async reviewPRs call, so a concurrent manual trigger sees the claim.
 *
 * 5. Same file-persistence patterns as creditLedger: atomic tmp→rename write,
 *    ENOENT returns defaults, parse error resets to defaults and overwrites.
 *
 * 6. Elasticsearch as cross-deployment durable store. On a fresh container the
 *    local state file does not exist (ENOENT). loadSchedule() attempts one ES
 *    GET to restore the previous deployment's state before falling back to
 *    defaults. saveSchedule() upserts the same state to ES after the file write
 *    succeeds — fire-and-forget, so an ES failure never blocks the idempotency
 *    token write (principle #2). The file remains the primary gate; ES is the
 *    off-container backup.
 *****************************************************************************/

'use strict';

const fs = require('fs').promises;
const path = require('path');
const os = require('os');

// Lazy-require so the module loads fine when esClient is unavailable in tests.
const { esCall } = require('../observability/esClient');
const esNames = require('../esNames');
const { getBalance, isLowBalance } = require('./bobCredits');
const agents = require('../agents');
const {
  startProgress,
  applyProgress,
  endProgress,
} = require('./reviewProgress');
const { postLowTokenAlert } = require('../slackNotifier');

// ── State file location ──────────────────────────────────────────────────────

/**
 * Where the schedule state lives.
 *
 * Follows the same directory convention as creditLedger: defaults beside
 * MCP_STATE_PATH (/workspace in the container), so this file shares whatever
 * durable-storage mount is already configured.
 */
function getSchedulePath() {
  if (process.env.SCHEDULE_STATE_PATH) return process.env.SCHEDULE_STATE_PATH;

  if (process.env.MCP_STATE_PATH) {
    return path.join(
      path.dirname(process.env.MCP_STATE_PATH),
      'carbon-monitor-schedule.json'
    );
  }

  const newPath = path.join(
    os.homedir(),
    '.config',
    'carbon-monitor',
    'schedule.json'
  );
  const oldPath = path.join(
    os.homedir(),
    '.bob',
    'carbon-monitor-schedule.json'
  );

  const fssync = require('fs');
  if (fssync.existsSync(oldPath) && !fssync.existsSync(newPath)) {
    try {
      fssync.mkdirSync(path.dirname(newPath), { recursive: true });
      fssync.renameSync(oldPath, newPath);
      console.warn(
        '[scheduleManager] migrated schedule to ~/.config/carbon-monitor/schedule.json'
      );
    } catch (e) {
      console.warn(
        `[scheduleManager] migration skipped, using legacy path: ${e.message}`
      );
      return oldPath;
    }
  }

  return newPath;
}

// ── Default state ────────────────────────────────────────────────────────────

// Zone of the stored run time. Configurable so a team sets its own; the console
// converts for whatever zone the operator picks.
const SCHEDULE_TIMEZONE = (
  process.env.SCHEDULE_TIMEZONE || 'America/Chicago'
).trim();

/**
 * Convert a wall-clock "HH:MM" from one IANA zone to another, on today's date.
 * Returns null when the value is malformed or Intl cannot resolve a zone.
 */
function convertWallClock(hhmm, fromTz, toTz) {
  if (!/^\d{2}:\d{2}$/.test(hhmm || '')) return null;
  try {
    const [h, m] = hhmm.split(':').map(Number);
    const now = new Date();
    const day = new Intl.DateTimeFormat('en-CA', {
      timeZone: fromTz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
    const utcMs =
      Date.parse(
        `${day}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`
      ) + getZoneOffsetMs(now, fromTz);
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: toTz,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(new Date(utcMs));
    const hh = parts.find((p) => p.type === 'hour')?.value;
    const mm = parts.find((p) => p.type === 'minute')?.value;
    if (!hh || !mm) return null;
    return `${hh === '24' ? '00' : hh}:${mm}`;
  } catch (_) {
    return null;
  }
}

/**
 * State written before SCHEDULE_TIMEZONE existed holds `timeEST`, a wall-clock
 * time in America/New_York. Convert it once so the absolute firing time is kept.
 */
function migrateState(state) {
  if (
    !state ||
    typeof state !== 'object' ||
    state.timeEST === undefined ||
    state.timeLocal !== undefined
  ) {
    return state;
  }
  const { timeEST, ...rest } = state;
  return {
    ...rest,
    timeLocal:
      convertWallClock(timeEST, 'America/New_York', SCHEDULE_TIMEZONE) ||
      timeEST,
  };
}

function defaultState() {
  return {
    enabled: false,
    paused: false,
    timeLocal: '09:00',
    lastRunAt: null,
    lastRunSkipped: false,
    lastSkipReason: null,
    // Idempotency token: the "HH:MM" that was last fired.
    // Reset conceptually on each new day by comparing against the current
    // clock — "same minute today" is the only window that matters.
    lastFiredMinute: null,
    // Full ISO string of the minute that was last fired (includes the date),
    // so "09:00" on Monday is not blocked by "09:00" on Tuesday.
    lastFiredAt: null,
  };
}

// ── In-memory cache ──────────────────────────────────────────────────────────

/** Cached copy of the on-disk state, kept in sync by loadSchedule/saveSchedule. */
let _state = null;

// ── Elasticsearch helpers ─────────────────────────────────────────────────────

// Derived at call time so ES_INDEX_PREFIX is read after .env loads.
const getEsIndex = () => esNames.scheduleIndex();
const ES_DOC_ID = 'singleton';

/**
 * Fetch the schedule state from Elasticsearch.
 *
 * Returns the stored state object merged onto defaults, or null if ES is
 * unavailable, the document does not exist, or any error occurs.
 * Never throws.
 */
async function esLoadSchedule() {
  try {
    const result = await esCall((client) =>
      client.get({ index: getEsIndex(), id: ES_DOC_ID })
    );
    if (!result || !result._source || typeof result._source !== 'object') {
      return null;
    }
    return { ...defaultState(), ...result._source };
  } catch (_) {
    return null;
  }
}

/**
 * Upsert the schedule state to Elasticsearch.
 *
 * Fire-and-forget — the returned promise is intentionally not awaited by
 * saveSchedule(), so an ES failure never blocks the idempotency token write.
 * Never throws.
 */
async function esSaveSchedule(state) {
  try {
    await esCall((client) =>
      client.index({ index: getEsIndex(), id: ES_DOC_ID, document: state })
    );
  } catch (_) {
    // Failure is already logged by esCall's circuit breaker. Nothing to add.
  }
}

// ── File I/O ─────────────────────────────────────────────────────────────────

/**
 * Read state from disk.
 *
 * Returns defaults on ENOENT. On any parse error: logs, overwrites with
 * defaults (so a corrupt file is not permanently broken), and returns defaults.
 */
async function loadSchedule() {
  const schedulePath = getSchedulePath();
  let raw;
  try {
    raw = await fs.readFile(schedulePath, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[schedule] could not read state file: ${err.message}`);
    }
    // File absent (fresh container) — attempt to restore from ES before
    // falling back to defaults. This is the only path that queries ES on read;
    // when the file exists it is always preferred (faster, no network hop).
    const esState = await esLoadSchedule();
    if (esState) {
      console.log(
        '[schedule] restored state from Elasticsearch (no local file found)'
      );
      _state = migrateState(esState);
      if (esState.timeEST !== undefined) saveSchedule(_state).catch(() => {});
      return _state;
    }
    _state = defaultState();
    return _state;
  }

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('state file is not a JSON object');
    }
    // Merge parsed fields onto defaults so a state file written by an older
    // version of the app (missing new fields) still works correctly.
    _state = { ...defaultState(), ...migrateState(parsed) };
    if (parsed.timeEST !== undefined) saveSchedule(_state).catch(() => {});
    return _state;
  } catch (err) {
    console.warn(
      `[schedule] state file at ${schedulePath} is corrupt (${err.message}) — resetting to defaults`
    );
    _state = defaultState();
    // Overwrite so the next read does not re-encounter the corrupt file.
    await saveSchedule(_state).catch(() => {});
    return _state;
  }
}

/**
 * Write state to disk atomically.
 *
 * Written to a sibling .tmp file and renamed, so a crash mid-write leaves
 * either the old state or the new one, never a half-written file.
 */
async function saveSchedule(state) {
  const schedulePath = getSchedulePath();
  await fs.mkdir(path.dirname(schedulePath), { recursive: true });
  const tmp = `${schedulePath}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2) + '\n', {
    encoding: 'utf8',
    mode: 0o600,
  });
  await fs.rename(tmp, schedulePath);
  _state = state;
  // Upsert to ES after the file write succeeds. Fire-and-forget — an ES
  // failure must never prevent the idempotency token from being recorded
  // (design principle #2). The file is always written first.
  esSaveSchedule(state).catch((err) => {
    console.warn(
      `[schedule] could not upsert state to Elasticsearch: ${err.message}`
    );
  });
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Current schedule state plus a computed nextRunAt.
 *
 * nextRunAt is the next wall-clock occurrence of timeLocal in the schedule zone,
 * as a UTC ISO string. Always in the future.
 */
async function getSchedule() {
  if (!_state) await loadSchedule();
  return {
    ..._state,
    timezone: SCHEDULE_TIMEZONE,
    nextRunAt: computeNextRunAt(_state.timeLocal),
  };
}

/**
 * Apply a partial update, validate, persist, and return the updated state.
 *
 * Unknown fields are silently dropped. Returns an error string on invalid
 * input rather than throwing — the HTTP handler turns that into a 400.
 *
 * @param {Object} patch - { enabled?: boolean, timeLocal?: string }
 * @returns {{ ok: boolean, state?: Object, error?: string }}
 */
async function setSchedule(patch) {
  if (!_state) await loadSchedule();

  const next = { ..._state };

  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== 'boolean') {
      return { ok: false, error: '"enabled" must be a boolean' };
    }
    next.enabled = patch.enabled;
  }

  if (patch.paused !== undefined) {
    if (typeof patch.paused !== 'boolean') {
      return { ok: false, error: '"paused" must be a boolean' };
    }
    next.paused = patch.paused;
  }

  if (patch.timeEST !== undefined && patch.timeLocal === undefined)
    patch = { ...patch, timeLocal: patch.timeEST };
  if (patch.timeLocal !== undefined) {
    const err = validateTimeLocal(patch.timeLocal);
    if (err) return { ok: false, error: err };
    next.timeLocal = patch.timeLocal;
  }

  await saveSchedule(next);
  return {
    ok: true,
    state: { ...next, nextRunAt: computeNextRunAt(next.timeLocal) },
  };
}

// ── Validation ───────────────────────────────────────────────────────────────

/**
 * Validate a timeLocal value.
 * @param {*} value
 * @returns {string|null} Error message, or null if valid
 */
function validateTimeLocal(value) {
  if (typeof value !== 'string')
    return '"timeLocal" must be a string in HH:MM format';
  if (!/^\d{2}:\d{2}$/.test(value))
    return '"timeLocal" must be in HH:MM format (e.g. "09:00")';
  const [h, m] = value.split(':').map(Number);
  if (h < 0 || h > 23) return `"timeLocal" hour must be 00–23, got "${value}"`;
  if (m < 0 || m > 59)
    return `"timeLocal" minute must be 00–59, got "${value}"`;
  return null;
}

// ── Intl / zone helpers ───────────────────────────────────────────────────────

/** Whether Intl can resolve the schedule zone (checked once at startup). */
let _icuAvailable = null;

/**
 * Return the current wall-clock time in the schedule zone as "HH:MM".
 * Returns null if Intl is unavailable.
 */
function currentLocalMinute() {
  if (_icuAvailable === false) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: SCHEDULE_TIMEZONE,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(new Date());

    const hour = parts.find((p) => p.type === 'hour')?.value ?? '';
    const minute = parts.find((p) => p.type === 'minute')?.value ?? '';
    // Intl may return "24" for midnight in some environments; normalise to "00".
    const h = hour === '24' ? '00' : hour;
    return `${h}:${minute}`;
  } catch (_) {
    return null;
  }
}

/**
 * Compute the next UTC ISO timestamp at which timeLocal will occur in the schedule zone.
 *
 * Finds today's occurrence; if it is in the past (or already this minute),
 * advances to tomorrow. Returns an ISO string in UTC.
 *
 * @param {string} timeLocal - "HH:MM"
 * @returns {string|null}
 */
function computeNextRunAt(timeLocal) {
  if (!timeLocal || !_icuAvailable) return null;

  try {
    const [hStr, mStr] = timeLocal.split(':');
    const targetH = Number(hStr);
    const targetM = Number(mStr);

    const now = new Date();

    // Build a candidate: today at timeLocal in ET, expressed as UTC.
    // We iterate day by day until we find one strictly in the future.
    for (let daysAhead = 0; daysAhead <= 1; daysAhead++) {
      // Get the ET date for (now + daysAhead days)
      const candidate = new Date(now.getTime() + daysAhead * 86400_000);

      // Find what YYYY-MM-DD it is in ET
      const etDate = new Intl.DateTimeFormat('en-CA', {
        timeZone: SCHEDULE_TIMEZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(candidate); // "YYYY-MM-DD"

      // Build a Date in ET by constructing an ISO string and letting the
      // browser/Node normalise it. We use a temp UTC parse then adjust — the
      // reliable cross-platform way is to use Intl to get the ET offset.
      const etOffsetMs = getZoneOffsetMs(candidate);
      // etDate is "YYYY-MM-DD"; form "YYYY-MM-DDTHH:MM:00" in ET, convert to UTC.
      const etStr = `${etDate}T${String(targetH).padStart(2, '0')}:${String(targetM).padStart(2, '0')}:00`;
      // Parse as if UTC, then add the ET→UTC offset (ET is behind UTC, so
      // offset is positive — e.g. EDT = +4h, EST = +5h).
      const utcMs = Date.parse(etStr + 'Z') + etOffsetMs;
      const result = new Date(utcMs);

      if (result.getTime() > now.getTime()) {
        return result.toISOString();
      }
    }
    return null;
  } catch (_) {
    return null;
  }
}

/**
 * Returns a zone's offset from UTC in milliseconds for a given Date.
 * Positive = ET is behind UTC (e.g. EST = -5h = -18000000ms).
 *
 * Derived by asking Intl what the ET wall-clock time is for a known UTC
 * timestamp, then computing the difference.
 */
function getZoneOffsetMs(date, tz = SCHEDULE_TIMEZONE) {
  // Format the same instant in ET and UTC, compare the difference.
  const utcParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const zoneParts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);

  function toMs(parts) {
    const get = (type) => {
      const val = parts.find((p) => p.type === type)?.value ?? '0';
      return Number(val === '24' ? '0' : val);
    };
    return Date.UTC(
      get('year'),
      get('month') - 1,
      get('day'),
      get('hour'),
      get('minute'),
      get('second')
    );
  }

  return toMs(utcParts) - toMs(zoneParts);
}

// ── Scheduler tick ───────────────────────────────────────────────────────────

let _tickInterval = null;

/**
 * Start the once-a-minute scheduler tick.
 *
 * Must be called from startServer() after all modules are wired up. Receives
 * reviewPRs, reviewState, and reviewLog by reference so it can honour the
 * same single-flight contract as handleReviewTrigger.
 *
 * @param {Function} reviewPRs
 * @param {Object}   reviewState - The mutable state object from server.js
 * @param {Object}   reviewLog   - The reviewLog module from server.js
 */
function startScheduler(reviewPRs, reviewState, reviewLog) {
  // ICU probe — must succeed before any tick fires.
  try {
    const resolved = new Intl.DateTimeFormat('en', {
      timeZone: SCHEDULE_TIMEZONE,
    }).resolvedOptions().timeZone;

    if (resolved !== SCHEDULE_TIMEZONE) {
      throw new Error(`resolved to "${resolved}"`);
    }
    _icuAvailable = true;
  } catch (err) {
    console.warn(
      `[schedule] Intl cannot resolve ${SCHEDULE_TIMEZONE} (${err.message}) — ` +
        'scheduled reviews disabled. This Node build may lack full ICU data.'
    );
    _icuAvailable = false;
    return;
  }

  // Warm the in-memory cache before the first tick.
  loadSchedule().catch((err) => {
    console.warn(
      `[schedule] could not pre-load schedule state: ${err.message}`
    );
  });

  _tickInterval = setInterval(() => {
    tick(reviewPRs, reviewState, reviewLog).catch((err) => {
      console.error('[schedule] tick error:', err);
    });
  }, 60_000);

  // Don't let this interval hold the process open if shutdown is waiting.
  if (_tickInterval.unref) _tickInterval.unref();
}

/** Stop the tick loop. Called from the shutdown handler. */
function stopScheduler() {
  if (_tickInterval) {
    clearInterval(_tickInterval);
    _tickInterval = null;
  }
}

/**
 * One scheduler tick.
 *
 * Called every 60 seconds. Performs all checks and fires at most once per
 * minute, using a persistent idempotency token to survive restarts.
 */
async function tick(reviewPRs, reviewState, reviewLog) {
  // 1. Ensure state is loaded.
  if (!_state) await loadSchedule();

  // 2. Quick bail-outs (no I/O needed).
  if (!_state.enabled) return;
  if (!_icuAvailable) return;

  // 3. Check if the current schedule-zone minute matches the configured time.
  // This check must come before the paused bail-out so that reminders only
  // fire once per day (on the scheduled minute), not on every 60-second tick.
  const now = new Date();
  const current = currentLocalMinute();
  if (!current || current !== _state.timeLocal) return;

  // Paused bail-out — fires the daily reminder and exits without writing any
  // idempotency token, so the reminder re-fires again on the next scheduled day.
  if (_state.paused) {
    console.log('[schedule] skipped — schedule is paused');
    const adapter = agents.current();
    const bobcoins = adapter.costUnit === 'bobcoins';
    const balance = bobcoins ? await getBalance() : await adapter.credits();
    // An unmetered agent has no budget to remind about.
    if (!bobcoins && !balance.available) {
      console.log(
        `[schedule] low-budget reminder skipped — ${adapter.creditLabel} is not metered (${balance.reason})`
      );
      return;
    }
    const lowPct = bobcoins
      ? Number(process.env.BOB_CREDITS_LOW_PCT || 10)
      : balance.threshold;
    postLowTokenAlert({
      percentRemaining: balance.percentRemaining,
      threshold: lowPct,
      agent: adapter.id,
      repo: `${process.env.GITHUB_AI_AGENT_OWNER || 'carbon-design-system'}/${process.env.GITHUB_AI_AGENT_REPO || 'carbon'}`,
      isReminder: true,
    });
    return;
  }

  // 4. Idempotency: build a token that includes the date so tomorrow's run
  //    is not blocked by today's.
  const etDateStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: SCHEDULE_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now); // "YYYY-MM-DD"
  const firedToken = `${etDateStr}T${current}`;

  // Check in-memory first (fast path), then the persisted value (cross-restart).
  if (_state.lastFiredAt === firedToken) return;

  // 5. If a review is already running, skip and record the skip.
  if (reviewState.running) {
    console.log(
      `[schedule] skipped — a review is already in flight (started ${reviewState.startedAt})`
    );
    const updated = {
      ..._state,
      lastFiredAt: firedToken,
      lastRunSkipped: true,
      lastSkipReason: `Manual review was in flight (started ${reviewState.startedAt})`,
    };
    await saveSchedule(updated).catch((err) => {
      console.warn(`[schedule] could not persist skip record: ${err.message}`);
    });
    return;
  }

  // Low-token guard: check balance before committing to fire. If below the
  // threshold, auto-pause and notify. Do NOT write the idempotency token so
  // the next scheduled tick re-evaluates and re-notifies.
  // IMPORTANT: balance unavailable (available:false) or null percentRemaining
  // (uncapped plan) must never block a review — only a confirmed low reading pauses.
  // Bob keeps its cached gateway balance; any other agent reports through credits().
  const adapter = agents.current();
  let balance, low, lowPct;
  if (adapter.costUnit === 'bobcoins') {
    balance = await getBalance();
    ({ low, threshold: lowPct } = isLowBalance(balance));
  } else {
    balance = await adapter.credits();
    ({ low, threshold: lowPct } = balance);
  }
  if (low) {
    console.warn(
      `[schedule] auto-pausing — ${adapter.creditLabel} at ${balance.percentRemaining}% (threshold ${lowPct}%)`
    );
    const autoPaused = {
      ..._state,
      paused: true,
      lastRunSkipped: true,
      lastSkipReason: `Auto-paused: ${adapter.creditLabel} at ${balance.percentRemaining}% (below ${lowPct}% threshold)`,
    };
    await saveSchedule(autoPaused).catch((err) => {
      console.warn(
        `[schedule] could not persist auto-pause state: ${err.message}`
      );
    });
    postLowTokenAlert({
      percentRemaining: balance.percentRemaining,
      threshold: lowPct,
      agent: adapter.id,
      repo: `${process.env.GITHUB_AI_AGENT_OWNER || 'carbon-design-system'}/${process.env.GITHUB_AI_AGENT_REPO || 'carbon'}`,
      isReminder: false,
    });
    return;
  }

  // 6. Write the idempotency token BEFORE firing — see design principle #2.
  //    If the process dies here, this day's run is skipped (acceptable). Firing
  //    twice and posting duplicate comments is not acceptable.
  const preFire = {
    ..._state,
    lastFiredAt: firedToken,
    lastRunSkipped: false,
    lastSkipReason: null,
  };
  try {
    await saveSchedule(preFire);
  } catch (err) {
    // If we cannot persist the token, do NOT fire — the risk of double-firing
    // on the next restart outweighs the cost of skipping this run.
    console.error(
      `[schedule] could not write idempotency token — skipping this run to prevent double-fire: ${err.message}`
    );
    return;
  }

  // 7. Claim the single-flight lock synchronously, exactly as handleReviewTrigger
  //    does (server.js lines 532–537). No async gap between the check above and
  //    this claim — we are on the single-threaded event loop.
  reviewState.running = true;
  reviewState.startedAt = new Date().toISOString();
  reviewState.finishedAt = null;
  reviewState.error = null;
  reviewState.mode = 'auto';
  reviewState.prNumbers = null;
  startProgress(reviewState);

  console.log(
    `[schedule] triggering scheduled review at ${current} ${SCHEDULE_TIMEZONE}`
  );

  // 8. Start log capture so the console can show output, same as a manual run.
  reviewLog.start(reviewState.startedAt);

  // 9. Fire the review in the background. Do not await — the tick must return
  //    promptly so the interval does not stack up.
  reviewPRs({
    triggeredBy: 'schedule',
    onProgress: (snapshot) => applyProgress(reviewState, snapshot),
  })
    .then(() => {
      reviewState.error = null;
    })
    .catch((err) => {
      console.error('[schedule] background review error:', err);
      reviewState.error = err.message;
    })
    .finally(async () => {
      reviewState.running = false;
      reviewState.finishedAt = new Date().toISOString();
      endProgress(reviewState);
      reviewLog.stop();

      // Update lastRunAt now that the run is complete.
      const postRun = {
        ..._state,
        lastRunAt: reviewState.finishedAt,
        lastRunSkipped: false,
        lastSkipReason: null,
      };
      await saveSchedule(postRun).catch((err) => {
        console.warn(`[schedule] could not persist lastRunAt: ${err.message}`);
      });
    });
}

// ── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  getSchedulePath,
  getSchedule,
  setSchedule,
  loadSchedule,
  startScheduler,
  stopScheduler,
  // Exported for tests
  tick,
  currentLocalMinute,
  computeNextRunAt,
  validateTimeLocal,
  defaultState,
  SCHEDULE_TIMEZONE,
};
