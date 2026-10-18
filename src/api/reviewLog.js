/******************************************************************************
 * Review Log Buffer
 *
 * Captures everything a review run prints and keeps it in memory so the console
 * can show the operator what is happening.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * A review takes minutes. Run locally you watch it work — PR fetched, diff
 * sized, bundle built, agent thinking, findings parsed. Triggered from the
 * console you got a greyed-out button and no way to tell a working run from a
 * wedged one. This makes the cloud run as legible as the local one.
 *
 * ── How ─────────────────────────────────────────────────────────────────────
 * src/index.js and its collaborators log with console.log/console.error and,
 * in agentRunner, raw process.stdout.write for the progress dots. Rather than
 * thread a logger through nine modules — a large diff through the most
 * load-bearing code in the project, purely for an observability feature — the
 * console methods are wrapped for the lifetime of a run and restored after.
 *
 * Batches are SERIALISED (handleReviewTrigger refuses a second with 409), but
 * the reviews inside one batch run side by side, so each line is tagged with the
 * review that wrote it. An AsyncLocalStorage store set around each review
 * carries { worker, pr }; the spawned child's stream handlers are created inside
 * it and inherit it. Lines written outside any review are tagged [batch].
 *
 * Output still reaches the real stdout, with the same tags, so
 * `ibmcloud ce app logs` can tell two reviews apart.
 *****************************************************************************/

const { AsyncLocalStorage } = require('node:async_hooks');

/** The review writing right now: { worker, pr }, or undefined at batch level. */
const reviewContext = new AsyncLocalStorage();

/** Lines retained. Bounded: a container runs for months. */
const MAX_LINES = Number(process.env.REVIEW_LOG_MAX_LINES || 2000);

/** Longest single line kept, so one enormous dump cannot dominate memory. */
const MAX_LINE_CHARS = 2000;

/** Ring buffer of { seq, at, stream, text, worker?, pr? }. */
let lines = [];

/**
 * Monotonic sequence number.
 *
 * Never reset, including across runs. The console polls with `?since=N`, and a
 * counter that restarted would make it re-render the previous run's tail as if
 * it were new output.
 */
let nextSeq = 1;

/** Original console/stdout functions while capture is active. */
let originals = null;

/** Correlation id of the run being captured, for the client to detect a change. */
let currentRunId = null;

/**
 * Append one line.
 *
 * @param {string} text
 * @param {string} [stream='stdout'] - 'stdout' | 'stderr'
 * @param {{worker: number, pr: number}} [ctx] - Defaults to the current review
 */
function append(text, stream = 'stdout', ctx = reviewContext.getStore()) {
  const clean = String(text).replace(/\s+$/, '');
  if (!clean) return;

  const tagged = `${ctx ? `[agent ${ctx.worker} #${ctx.pr}]` : '[batch]'} ${clean}`;
  lines.push({
    seq: nextSeq++,
    at: new Date().toISOString(),
    stream,
    text:
      tagged.length > MAX_LINE_CHARS
        ? `${tagged.slice(0, MAX_LINE_CHARS)}…`
        : tagged,
    ...(ctx ? { worker: ctx.worker, pr: ctx.pr } : {}),
  });

  // Trim from the front. The console reads forward by seq, so dropping the
  // oldest lines is visible as a gap rather than as corruption.
  if (lines.length > MAX_LINES) lines = lines.slice(-MAX_LINES);
}

/**
 * Partial line carried between writes, per stream and per review.
 *
 * A write is a chunk, not a line: agentRunner's progress dots arrive with no
 * newline at all, and a long message can be split across chunks. Text is held
 * here until a newline completes it, so dots accumulate into one line rather
 * than becoming hundreds of one-character entries. Keyed by review too, so two
 * reviews' fragments never join into one line.
 */
const partial = new Map();

const tagOf = (ctx) => (ctx ? `[agent ${ctx.worker} #${ctx.pr}] ` : '[batch] ');
const tagged = (line, ctx) => (line.trim() ? `${tagOf(ctx)}${line}\n` : '\n');

/**
 * Run `fn` as review `ctx` ({ worker, pr }): every line it writes is tagged.
 * When it settles, a fragment the review left unfinished is emitted into that
 * review's own sequence rather than waiting for the next batch-level flush.
 */
async function runWithContext(ctx, fn) {
  try {
    return await reviewContext.run(ctx, fn);
  } finally {
    drain(
      (held) =>
        held.ctx && held.ctx.worker === ctx.worker && held.ctx.pr === ctx.pr
    );
  }
}

/**
 * Split a chunk into complete lines, retaining any trailing fragment.
 * @returns {string} The complete lines, tagged, for the real stream
 */
function ingest(chunk, stream) {
  const ctx = reviewContext.getStore();
  const key = `${stream}:${ctx ? `${ctx.worker}:${ctx.pr}` : 'batch'}`;
  const held = partial.get(key) || { text: '', ctx, stream };
  const parts = (held.text + chunk).split('\n');
  held.text = parts.pop();
  partial.set(key, held);
  let out = '';
  for (const line of parts) {
    append(line, stream, ctx);
    out += tagged(line, ctx);
  }
  return out;
}

/** Emit the held fragments `match` selects, to the buffer and the real stream. */
function drain(match) {
  for (const [key, held] of partial) {
    if (!match(held)) continue;
    partial.delete(key);
    if (!held.text) continue;
    append(held.text, held.stream, held.ctx);
    if (originals) {
      originals[`${held.stream}Write`](tagged(held.text, held.ctx));
    }
  }
}

/** Emit whatever is left in the partial buffers. */
function flush() {
  drain(() => true);
}

/**
 * Begin capturing output for a run.
 *
 * Only the two STREAM writers are wrapped — not console.log/error/warn.
 * console.log formats its arguments and then calls process.stdout.write, so
 * wrapping both captured every line TWICE (verified: a run produced a perfectly
 * duplicated log). Hooking the streams alone captures console output, raw
 * writes, and anything a dependency prints, exactly once and already formatted
 * the way a terminal would show it.
 *
 * @param {string} runId - Correlation id, echoed to clients
 */
function start(runId) {
  // Idempotent: a second start without a stop would wrap the already-wrapped
  // functions, and restoring once would leave a permanent layer behind.
  if (originals) return;

  currentRunId = runId || null;
  lines = [];
  partial.clear();

  originals = {
    stdoutWrite: process.stdout.write.bind(process.stdout),
    stderrWrite: process.stderr.write.bind(process.stderr),
  };

  // The real stream gets the same tagged complete lines the buffer holds, so
  // `ibmcloud ce app logs` can tell two reviews apart.
  const wrap =
    (stream) =>
    (chunk, ...rest) => {
      if (typeof chunk !== 'string')
        return originals[`${stream}Write`](chunk, ...rest);
      const cb = rest.find((arg) => typeof arg === 'function');
      return originals[`${stream}Write`](ingest(chunk, stream), cb);
    };
  process.stdout.write = wrap('stdout');
  process.stderr.write = wrap('stderr');
}

/** Stop capturing and restore the real streams. Safe to call when not started. */
function stop() {
  if (!originals) return;
  // Before restoring, or a run whose last line lacked a trailing newline would
  // lose it — which is exactly the case for the progress dots.
  flush();
  process.stdout.write = originals.stdoutWrite;
  process.stderr.write = originals.stderrWrite;
  originals = null;
}

/**
 * Read lines newer than `since`.
 *
 * @param {number} [since=0] - Highest seq the caller already has
 * @param {number} [limit=500] - Most lines to return in one response
 * @param {{pr?: number, worker?: number}} [filter] - Only lines of that review
 * @returns {Object} { lines, nextSince, runId, capturing, dropped }
 */
function read(since = 0, limit = 500, filter = {}) {
  const from = Number.isFinite(since) && since > 0 ? since : 0;
  const fresh = lines.filter(
    (l) =>
      l.seq > from &&
      (!filter.pr || l.pr === filter.pr) &&
      (!filter.worker || l.worker === filter.worker)
  );
  const page = fresh.slice(0, limit);

  // Tells the client its cursor fell off the back of the buffer, so it can say
  // output was skipped instead of silently showing a discontinuous log.
  const oldestHeld = lines.length ? lines[0].seq : nextSeq;
  const dropped = from > 0 && oldestHeld > from + 1;

  return {
    lines: page,
    // Unchanged when there is nothing new, so the client's cursor does not move
    // past lines it has not seen.
    nextSince: page.length ? page[page.length - 1].seq : from,
    runId: currentRunId,
    capturing: originals !== null,
    dropped,
    truncated: fresh.length > page.length,
  };
}

/**
 * Discard buffered lines.
 *
 * The sequence counter is deliberately left alone. Clients poll with a `since`
 * cursor holding the highest seq they have rendered; restarting the counter
 * would hand out seq numbers they have already seen and make the next run's
 * output arrive looking like lines they had scrolled past — or vanish entirely
 * behind a cursor that is now ahead of it. A cleared buffer with a running
 * counter simply looks like a gap, which `read` already reports as `dropped`.
 *
 * Safe during a run: capture wraps the stream writers, and this touches neither
 * those wrappers nor `originals`, so lines keep arriving into the emptied
 * buffer. The partial fragments are left in place on purpose — a fragment is
 * half of a line that has not been emitted yet, and dropping it would deliver
 * the second half of a sentence as though it were a whole line.
 *
 * @returns {number} How many buffered lines were discarded
 */
function clear() {
  const discarded = lines.length;
  lines = [];
  return discarded;
}

module.exports = {
  start,
  stop,
  read,
  append,
  clear,
  runWithContext,
  MAX_LINES,
};
