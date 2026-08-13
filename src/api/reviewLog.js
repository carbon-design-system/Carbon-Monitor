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
 * That is only safe because runs are SERIALISED: handleReviewTrigger refuses a
 * second run with 409 while one is in flight, and Code Engine pins the app to a
 * single instance. Two concurrent runs would interleave into one buffer with no
 * way to tell them apart — so if that guard is ever relaxed, this needs a
 * per-run buffer keyed by correlation id.
 *
 * Output still reaches the real stdout, so `ibmcloud ce app logs` is unaffected.
 *****************************************************************************/

/** Lines retained. Bounded: a container runs for months. */
const MAX_LINES = Number(process.env.REVIEW_LOG_MAX_LINES || 2000);

/** Longest single line kept, so one enormous dump cannot dominate memory. */
const MAX_LINE_CHARS = 2000;

/** Ring buffer of { seq, at, stream, text }. */
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
 */
function append(text, stream = 'stdout') {
  const clean = String(text).replace(/\s+$/, '');
  if (!clean) return;

  lines.push({
    seq: nextSeq++,
    at: new Date().toISOString(),
    stream,
    text: clean.length > MAX_LINE_CHARS ? `${clean.slice(0, MAX_LINE_CHARS)}…` : clean,
  });

  // Trim from the front. The console reads forward by seq, so dropping the
  // oldest lines is visible as a gap rather than as corruption.
  if (lines.length > MAX_LINES) lines = lines.slice(-MAX_LINES);
}

/**
 * Partial line carried between writes, per stream.
 *
 * A write is a chunk, not a line: agentRunner's progress dots arrive with no
 * newline at all, and a long message can be split across chunks. Text is held
 * here until a newline completes it, so dots accumulate into one line rather
 * than becoming hundreds of one-character entries.
 */
const partial = { stdout: '', stderr: '' };

/** Split a chunk into complete lines, retaining any trailing fragment. */
function ingest(chunk, stream) {
  partial[stream] += chunk;
  const parts = partial[stream].split('\n');
  partial[stream] = parts.pop();
  for (const line of parts) append(line, stream);
}

/** Emit whatever is left in the partial buffers. */
function flush() {
  for (const stream of ['stdout', 'stderr']) {
    if (partial[stream]) {
      append(partial[stream], stream);
      partial[stream] = '';
    }
  }
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
  partial.stdout = '';
  partial.stderr = '';

  originals = {
    stdoutWrite: process.stdout.write.bind(process.stdout),
    stderrWrite: process.stderr.write.bind(process.stderr),
  };

  process.stdout.write = (chunk, ...rest) => {
    if (typeof chunk === 'string') ingest(chunk, 'stdout');
    return originals.stdoutWrite(chunk, ...rest);
  };
  process.stderr.write = (chunk, ...rest) => {
    if (typeof chunk === 'string') ingest(chunk, 'stderr');
    return originals.stderrWrite(chunk, ...rest);
  };
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
 * @returns {Object} { lines, nextSince, runId, capturing, dropped }
 */
function read(since = 0, limit = 500) {
  const from = Number.isFinite(since) && since > 0 ? since : 0;
  const fresh = lines.filter((l) => l.seq > from);
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

module.exports = { start, stop, read, append, clear, MAX_LINES };
