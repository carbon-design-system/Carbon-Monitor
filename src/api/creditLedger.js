/******************************************************************************
 * Bobcoins Ledger — append-only per-review spend log
 *
 * One JSONL line per review, so the console can answer "what did that PR cost?"
 * and "what are we spending per week?" without querying Elasticsearch.
 *
 * ── Why a file, when every other metric goes to ES ──────────────────────────
 * Elasticsearch remains the durable source of truth (each entry is also emitted
 * as a `pr_review_cost` event). This file is a local cache so the console shows
 * cost history when ES is absent — which is the normal state on a laptop and a
 * survivable one in production. A fresh container legitimately starts empty;
 * callers must treat that as "no history yet", never as an error.
 *
 * ── Why it is bounded ───────────────────────────────────────────────────────
 * The deployment runs at min-scale 1, so this process can live for months on a
 * container filesystem nothing else prunes. An unbounded append-only log would
 * eventually fill the disk and take the app down with it, so the file is capped
 * at CREDIT_LEDGER_MAX lines and the oldest are dropped.
 *
 * ── Why a bad line is skipped, not fatal ────────────────────────────────────
 * A container killed mid-append leaves a truncated final line. Parsing that as
 * a hard error would brick every read of the ledger from then on, turning a
 * half-written record into a permanently broken feature.
 *****************************************************************************/

'use strict';

const fs = require('fs').promises;
const path = require('path');
const os = require('os');

/** Newest entries retained; older ones are pruned on write. */
function getMaxEntries() {
  const n = Number(process.env.CREDIT_LEDGER_MAX || 1000);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1000;
}

/**
 * Where the ledger lives.
 *
 * Defaults beside MCP_STATE_PATH — the one directory the deployment has already
 * established as writable and app-owned (/workspace in the container), so this
 * inherits whatever persistence that mount has without a new variable.
 */
function getLedgerPath() {
  if (process.env.CREDIT_LEDGER_PATH) return process.env.CREDIT_LEDGER_PATH;

  if (process.env.MCP_STATE_PATH) {
    return path.join(path.dirname(process.env.MCP_STATE_PATH), 'carbon-monitor-credit-ledger.jsonl');
  }

  const newPath = path.join(os.homedir(), '.config', 'carbon-monitor', 'credit-ledger.jsonl');
  const oldPath = path.join(os.homedir(), '.bob', 'carbon-monitor-credit-ledger.jsonl');

  const fssync = require('fs');
  if (fssync.existsSync(oldPath) && !fssync.existsSync(newPath)) {
    try {
      fssync.mkdirSync(path.dirname(newPath), { recursive: true });
      fssync.renameSync(oldPath, newPath);
      console.warn('[creditLedger] migrated ledger to ~/.config/carbon-monitor/credit-ledger.jsonl');
    } catch (e) {
      console.warn(`[creditLedger] migration skipped, using legacy path: ${e.message}`);
      return oldPath;
    }
  }

  return newPath;
}

// ── Reading ─────────────────────────────────────────────────────────────────

/** Memoised summary(), invalidated by the fingerprint below. */
let summaryCache = null;

/**
 * A value that changes whenever the ledger does.
 *
 * Size alone would suffice for the append-only path — every record lengthens the
 * file — but prune() can rewrite it to a coincidentally identical length, so the
 * modification time is folded in. The path is included because tests and the
 * CREDIT_LEDGER_PATH override can point this module at a different file mid-run.
 */
async function ledgerFingerprint() {
  const ledgerPath = getLedgerPath();
  try {
    const { size, mtimeMs } = await fs.stat(ledgerPath);
    return `${ledgerPath}:${size}:${mtimeMs}`;
  } catch (_) {
    return `${ledgerPath}:absent`;
  }
}

/**
 * Read and parse every entry, oldest first.
 *
 * Unreadable lines are dropped silently — see the header note on truncated
 * writes. An absent file is an empty ledger, not a failure.
 *
 * @returns {Promise<Object[]>}
 */
async function readAll() {
  let raw;
  try {
    raw = await fs.readFile(getLedgerPath(), 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn(`[creditLedger] could not read ledger: ${error.message}`);
    }
    return [];
  }

  const entries = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) entries.push(parsed);
    } catch (_) {
      // Truncated or corrupt line — skip it and keep the rest of the history.
    }
  }
  return entries;
}

/**
 * The most recent entries, newest first.
 *
 * Reads the whole file and slices, rather than seeking to the tail: the file is
 * capped at CREDIT_LEDGER_MAX lines, so the read is bounded by that cap and not
 * by the caller's `limit`. Callers capping `limit` are bounding the RESPONSE,
 * not the work done here.
 *
 * @param {number} [limit=100]
 * @returns {Promise<Object[]>}
 */
async function readRecent(limit = 100) {
  const n = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : 100;
  const entries = await readAll();
  return entries.slice(-n).reverse();
}

// ── Writing ─────────────────────────────────────────────────────────────────

/** Coerce to a number, or null — keeps each field's type stable for charting. */
function numberOrNull(value) {
  const n = Number(value);
  return value === null || value === undefined || value === '' || !Number.isFinite(n) ? null : n;
}

/**
 * Normalise an entry to the history contract.
 *
 * Every field is forced to its contracted type here rather than trusted from the
 * caller, because a string where a number belongs would poison both the charts
 * and Elasticsearch's dynamic mapping.
 */
function normalize(entry = {}) {
  return {
    at: entry.at || new Date().toISOString(),
    prNumber: numberOrNull(entry.prNumber),
    repo: typeof entry.repo === 'string' ? entry.repo : '',
    correlationId: typeof entry.correlationId === 'string' ? entry.correlationId : '',
    coinsSpent: numberOrNull(entry.coinsSpent),
    remainingAfter: numberOrNull(entry.remainingAfter),
    durationMs: numberOrNull(entry.durationMs),
    source: entry.source || 'unknown',
  };
}

/**
 * Rewrite the ledger with only the newest entries.
 *
 * Written to a sibling temp file and renamed so a crash mid-prune leaves either
 * the old ledger or the new one, never a half-written file.
 */
async function prune(ledgerPath, entries) {
  const kept = entries.slice(-getMaxEntries());
  const body = kept.map((e) => JSON.stringify(e)).join('\n') + '\n';
  const tmp = `${ledgerPath}.tmp`;
  await fs.writeFile(tmp, body, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(tmp, ledgerPath);
}

/**
 * Is the ledger newline-terminated, so an append starts a fresh line?
 *
 * True for an absent or empty file, where there is nothing to append after.
 * Only the final byte is read, so this costs one seek regardless of file size.
 *
 * @param {string} ledgerPath
 * @returns {Promise<boolean>}
 */
async function endsWithNewline(ledgerPath) {
  let handle;
  try {
    handle = await fs.open(ledgerPath, 'r');
    const { size } = await handle.stat();
    if (size === 0) return true;

    const buf = Buffer.alloc(1);
    await handle.read(buf, 0, 1, size - 1);
    return buf[0] === 0x0a;
  } catch (error) {
    // No file yet is the common case on a fresh container. Anything else is
    // reported by the append that follows, which is where it actually matters.
    return true;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

/**
 * Append one review's cost.
 *
 * Never throws: this is called from the review loop's `finally`, where an
 * exception would replace the agent's real failure with a bookkeeping one.
 *
 * @param {Object} entry - { at, prNumber, repo, correlationId, coinsSpent,
 *                           remainingAfter, durationMs, source }
 * @returns {Promise<boolean>} Whether the entry was persisted
 */
async function record(entry) {
  const ledgerPath = getLedgerPath();
  try {
    await fs.mkdir(path.dirname(ledgerPath), { recursive: true });

    // Repair the truncated final line this module's header anticipates before
    // writing after it. A half-written record has no trailing newline, so an
    // unconditional append would glue this entry onto the fragment and produce
    // one unparseable line — losing not just the interrupted record but this
    // good one too, permanently, since the next prune rewrites without it.
    const separator = (await endsWithNewline(ledgerPath)) ? '' : '\n';

    await fs.appendFile(ledgerPath, `${separator}${JSON.stringify(normalize(entry))}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });

    // Checked on every write rather than on a timer, so the cap holds even for a
    // process that is restarted before any timer would have fired. Reads cost
    // one pass over a file bounded at CREDIT_LEDGER_MAX lines, once per review.
    const entries = await readAll();
    if (entries.length > getMaxEntries()) await prune(ledgerPath, entries);

    return true;
  } catch (error) {
    console.warn(`[creditLedger] could not record spend: ${error.message}`);
    return false;
  }
}

// ── Derived views ───────────────────────────────────────────────────────────

/**
 * Aggregate the whole ledger for the /api/credits summary block.
 *
 * Entries whose cost could not be determined still count as reviews but
 * contribute nothing to the totals, so the average reflects only reviews whose
 * cost is actually known.
 *
 * Memoised against the ledger's size and mtime, because /api/credits pairs this
 * with a 60s-cached balance and is polled every 30 seconds by every open browser
 * tab — without this, each poll re-reads and re-parses the entire file on the
 * single-threaded loop that also serves the console.
 *
 * @returns {Promise<Object>}
 */
async function summary() {
  const fingerprint = await ledgerFingerprint();
  // The 24h/7d windows move with the clock, so a cached total would drift even
  // on an untouched file. Re-derived when either the file or the minute changes.
  const key = `${fingerprint}:${Math.floor(Date.now() / 60_000)}`;
  if (summaryCache && summaryCache.key === key) return summaryCache.value;

  const entries = await readAll();

  const now = Date.now();
  const DAY_MS = 24 * 60 * 60 * 1000;

  let totalSpent = 0;
  let costedCount = 0;
  let last24hSpent = 0;
  let last7dSpent = 0;
  let firstAt = null;
  let lastAt = null;

  for (const entry of entries) {
    const at = Date.parse(entry.at);
    if (Number.isFinite(at)) {
      if (firstAt === null || at < firstAt) firstAt = at;
      if (lastAt === null || at > lastAt) lastAt = at;
    }

    const spent = typeof entry.coinsSpent === 'number' ? entry.coinsSpent : null;
    if (spent === null) continue;

    totalSpent += spent;
    costedCount++;
    if (Number.isFinite(at)) {
      if (now - at <= DAY_MS) last24hSpent += spent;
      if (now - at <= 7 * DAY_MS) last7dSpent += spent;
    }
  }

  const round = (n) => Math.round(n * 1e6) / 1e6;

  const value = {
    totalSpent: round(totalSpent),
    reviewCount: entries.length,
    averagePerReview: costedCount > 0 ? round(totalSpent / costedCount) : null,
    last24hSpent: round(last24hSpent),
    last7dSpent: round(last7dSpent),
    firstRecordedAt: firstAt === null ? null : new Date(firstAt).toISOString(),
    lastRecordedAt: lastAt === null ? null : new Date(lastAt).toISOString(),
  };

  summaryCache = { key, value };
  return value;
}

/**
 * Running-total series for charting, oldest first.
 *
 * Accepts entries in either order and sorts by timestamp, so a caller holding a
 * newest-first list does not have to reverse it and cannot silently produce a
 * descending "cumulative" line.
 *
 * @param {Object[]} entries
 * @returns {Object[]} [{ at, spent, cumulativeSpent, remaining }]
 */
function buildCumulative(entries = []) {
  const ordered = [...entries].sort((a, b) => {
    const at = Date.parse(a && a.at) || 0;
    const bt = Date.parse(b && b.at) || 0;
    return at - bt;
  });

  let running = 0;
  return ordered.map((entry) => {
    // An unknown cost contributes zero rather than breaking the series — the
    // gap is already visible as a null in the entries list.
    const spent = typeof entry.coinsSpent === 'number' ? entry.coinsSpent : 0;
    running = Math.round((running + spent) * 1e6) / 1e6;
    return {
      at: entry.at,
      spent,
      cumulativeSpent: running,
      remaining: typeof entry.remainingAfter === 'number' ? entry.remainingAfter : null,
    };
  });
}

module.exports = {
  record,
  readRecent,
  readAll,
  summary,
  buildCumulative,
  getLedgerPath,
  getMaxEntries,
};
