import React, { useEffect, useRef, useState } from 'react';
import {
  InlineLoading,
  CopyButton,
  Button,
  IconButton,
  Tile,
  Link,
  preview__IconIndicator as IconIndicator,
} from '@carbon/react';
import { Download } from '@carbon/icons-react';
import { api } from '../api';
import AboutAi from './AboutAi';

/** How often to pull new output while a review is running. */
const TAIL_INTERVAL_MS = 2000;

// ── Per-PR progress ───────────────────────────────────────────────────────────
// A multi-PR run reviews its PRs one after another, but the server exposes only a
// single `running` flag — no per-PR index. The per-PR view is therefore
// reconstructed from the live log, which already prints a start marker
// ("📌 Reviewing PR #123: title") and a completion marker
// ("✅ PR #123 review complete") for each PR. No backend change is needed.
const PR_START_RE = /Reviewing PR #(\d+):\s*(.*)/;
const PR_DONE_RE = /PR #(\d+) review complete/;

// Derived status → Carbon IconIndicator `kind` + a human label. Kinds are
// Carbon's own status vocabulary, verified against @carbon/react's IconIndicator.
const PR_STATUS = {
  'not-started': { kind: 'not-started', label: 'Queued' },
  'in-progress': { kind: 'in-progress', label: 'Reviewing' },
  succeeded: { kind: 'succeeded', label: 'Reviewed' },
  failed: { kind: 'failed', label: 'Did not finish' },
};

/**
 * Reconstruct per-PR status from the log lines.
 *
 * @param {Array}  lines     - review log lines ({ text })
 * @param {number[]|null} prNumbers - the run's explicit PR targets, if any
 * @param {boolean} running  - whether the run is still in flight
 * @returns {Array<{number:number, title:string, status:string}>}
 */
function parsePrProgress(lines, prNumbers, running) {
  const started = new Map(); // number -> { title, order }
  const done = new Set();
  let order = 0;

  for (const line of lines) {
    const text = line.text || '';
    const start = PR_START_RE.exec(text);
    if (start) {
      const n = Number(start[1]);
      if (!started.has(n)) started.set(n, { title: (start[2] || '').trim(), order: order++ });
      continue;
    }
    const fin = PR_DONE_RE.exec(text);
    if (fin) done.add(Number(fin[1]));
  }

  const statusFor = (n) => {
    if (done.has(n)) return 'succeeded';
    if (started.has(n)) return running ? 'in-progress' : 'failed';
    return 'not-started';
  };

  // Explicit runs list every target in the order given, so queued PRs show before
  // the agent reaches them. Auto runs only know a PR once the agent names it in
  // the log, so those list in the order they appear.
  if (prNumbers && prNumbers.length) {
    return prNumbers.map((n) => ({
      number: n,
      title: started.get(n)?.title || '',
      status: statusFor(n),
    }));
  }
  return [...started.entries()]
    .sort((a, b) => a[1].order - b[1].order)
    .map(([n, meta]) => ({ number: n, title: meta.title, status: statusFor(n) }));
}

/**
 * Live output from the running review.
 *
 * A review takes minutes. Without this the console offered a disabled button and
 * no way to tell a working run from a wedged one — the operator had to hope.
 * This shows the same lines the terminal shows locally.
 *
 * Polled rather than streamed over SSE: Code Engine sits behind a proxy that can
 * close idle connections, and a 2s poll against an in-memory ring buffer costs
 * far less than the reconnect logic a dropped stream would need. The cursor is
 * `nextSince`, so each request carries only lines the client has not seen.
 *
 * `onVisibilityChange` reports whether this component renders anything at all.
 * It has to stay mounted to keep polling — that is how it discovers there is
 * output to show — so the page cannot decide for itself whether the row holding
 * it is occupied, and without being told it would reserve a row's worth of
 * margin for a panel that is not there.
 */
function ReviewLog({ running, startedAt, onVisibilityChange, prNumbers, owner, repo }) {
  const [lines, setLines] = useState([]);
  const [dropped, setDropped] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearError, setClearError] = useState(null);
  const sinceRef = useRef(0);
  // Bumped whenever the cursor is reset under a poll that may already be in
  // flight — a new run starting, or the operator clearing the buffer. A response
  // fetched against the old cursor is discarded rather than appended, which is
  // what stops a clear being silently undone by a request that was already on
  // the wire when the button was pressed.
  const genRef = useRef(0);
  const runRef = useRef(null);
  const scrollRef = useRef(null);
  const pinnedRef = useRef(true);

  // A new run resets the cursor. Without this the first poll of run #2 asks for
  // lines after run #1's last sequence and shows nothing until the new run has
  // out-logged the old one.
  useEffect(() => {
    if (startedAt && runRef.current !== startedAt) {
      runRef.current = startedAt;
      genRef.current += 1;
      sinceRef.current = 0;
      setLines([]);
      setDropped(false);
      setClearError(null);
    }
  }, [startedAt]);

  useEffect(() => {
    let cancelled = false;

    async function tail() {
      const generation = genRef.current;
      try {
        const result = await api.reviewLogs(sinceRef.current);
        // Not just unmounted: the cursor may have been reset while this was in
        // flight, in which case these lines are the ones that reset discarded.
        if (cancelled || generation !== genRef.current) return;

        if (result.lines?.length) {
          sinceRef.current = result.nextSince;
          // Capped client-side too: a very long run would otherwise grow this
          // array without bound in a tab left open all day.
          setLines((prev) => [...prev, ...result.lines].slice(-1000));
        }
        if (result.dropped) setDropped(true);
      } catch (_) {
        // A failed poll is not worth surfacing — the next one is 2s away, and an
        // error banner over a working review would be more alarming than useful.
      }
    }

    tail();

    // Polled only while running. One trailing fetch after it stops catches the
    // final lines, which otherwise land between the last poll and the stop.
    if (!running) return () => { cancelled = true; };

    const timer = setInterval(tail, TAIL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [running, startedAt]);

  // Follow the tail, but stop fighting the operator the moment they scroll up to
  // read something — the usual behaviour of a log view worth watching.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  // Rebuilt each render from the current lines — cheap, and it guarantees the
  // per-PR view can never disagree with the log it is derived from.
  const prProgress = parsePrProgress(lines, prNumbers, running);

  // Exactly the condition the early return below uses, so what the page is told
  // and what this component renders cannot drift apart.
  const visible = lines.length > 0 || running;

  useEffect(() => {
    onVisibilityChange?.(visible);
  }, [visible, onVisibilityChange]);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }

  /**
   * Put the whole buffer on the clipboard as plain text.
   *
   * navigator.clipboard is unavailable on insecure origins — which includes
   * http://<host>:3000 when that host is not localhost — so a failure here is a
   * real possibility rather than a theoretical one. CopyButton has already shown
   * its "Copied" feedback by the time this runs and offers no way to retract it,
   * so the fallback selects the text instead, leaving the operator one Cmd-C
   * away rather than believing a copy happened that did not.
   */
  async function copyAll() {
    const text = lines.map((l) => l.text).join('\n');
    try {
      await navigator.clipboard.writeText(text);
    } catch (_) {
      const el = scrollRef.current;
      if (!el) return;
      const range = document.createRange();
      range.selectNodeContents(el);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }
  }

  /**
   * Save the whole buffer as a .txt file.
   *
   * Same reason as copy — the point of keeping a log is to attach it to a bug
   * report — but a download survives a clipboard that is unavailable on insecure
   * origins, and produces a file that can be attached directly.
   */
  function downloadLog() {
    const text = lines.map((l) => l.text).join('\n');
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    const stamp = startedAt ? new Date(startedAt).toISOString().replace(/[:.]/g, '-') : 'log';
    anchor.download = `carbon-monitor-review-${stamp}.txt`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  /**
   * Discard the buffer on the server, then locally.
   *
   * The cursor goes back to 0 with the lines. Leaving it where it was would
   * leave the next poll asking for output after a sequence number the emptied
   * buffer no longer holds — which `read` reports as `dropped`, so the operator
   * would clear the log and immediately be told earlier output was discarded.
   * They know: they asked for it.
   *
   * Ordered server-then-client so a rejected request leaves the log intact
   * rather than blanking a view whose contents are still on the server and about
   * to reappear on the next poll.
   *
   * Usable mid-run — the server documents the operation as safe during capture,
   * and mid-run is when a wall of scrollback is most in the way. The 2s poll is
   * fenced off by `genRef` so a response already on the wire cannot put the
   * cleared lines back.
   */
  async function clearAll() {
    setClearing(true);
    setClearError(null);
    try {
      await api.clearReviewLogs();
      genRef.current += 1;
      sinceRef.current = 0;
      setLines([]);
      setDropped(false);
      pinnedRef.current = true;
    } catch (err) {
      setClearError(err.message);
    } finally {
      setClearing(false);
    }
  }

  if (!visible) return null;

  return (
    // A Tile, because this is now a full-width panel of its own rather than a
    // strip at the foot of the Reviews tile. Full width is not decoration: stack
    // frames and absolute paths are the reason to read a log at all, and in a
    // half-width column every one of them wraps.
    <Tile className="cm-log">
      <div className="cm-log__header">
        {/*
          The AI marker sits inline beside the title, NOT in the Tile's corner
          decorator slot: this panel already owns its top-right corner for the
          copy / download / clear toolbar, and a corner decorator overlaps it.
          Inline still marks the output as AI-generated per Carbon for AI, and
          matches how the "AI" label sits beside the Reviews heading. h2, not a
          styled span: this panel is a section of the page in its own right, and
          the page's only h1 is "Operations".
        */}
        <div className="cm-log__heading">
          <h2 className="cm-log__title">Review output</h2>
          <AboutAi />
        </div>

        <div className="cm-log__actions">
          {/*
            No run spinner here: the per-PR progress list below already shows a
            "Reviewing" spinner on the active PR, and two spinners for one running
            state read as two things happening. The toolbar keeps only its
            copy / download / clear controls.
          */}
          {/*
            Carbon's CopyButton, which carries its own icon and the "Copied!"
            feedback tooltip — so no @carbon/icons-react import is needed, which
            matters here because this project cannot verify icon export names.

            Copies the FULL buffer, not the visible portion: the reason to copy a
            log is to paste it into a bug report, and a scrolled-out stack trace
            is usually the part that matters.
          */}
          <CopyButton
            align="left"
            iconDescription={`Copy ${lines.length} lines of review output`}
            feedback="Copied"
            onClick={copyAll}
            disabled={lines.length === 0}
          />

          {/*
            Save the buffer as a .txt file — sits between Copy and Clear. Icon
            only, matching Copy; the tooltip `label` is also its accessible name.
          */}
          <IconButton
            label="Download log"
            kind="ghost"
            size="sm"
            align="bottom"
            onClick={downloadLog}
            disabled={lines.length === 0}
          >
            <Download />
          </IconButton>

          {/*
            Ghost and small: clearing is housekeeping, and reading the output —
            or copying it into a bug report — is what an operator is here for.
            Text-labelled rather than an icon, since @carbon/icons-react is off
            limits in this project and CopyButton's icon is its own.

            Disabled only when there is nothing to clear, so it never appears to
            do something and then does nothing.
          */}
          <Button
            kind="ghost"
            size="sm"
            onClick={clearAll}
            disabled={clearing || lines.length === 0}
          >
            {clearing ? 'Clearing…' : 'Clear'}
          </Button>
        </div>
      </div>

      {/*
        The run's PRs and where the agent is in each — reconstructed from the log
        (see parsePrProgress). This is what makes a 10-PR run legible: you watch
        each PR move queued → reviewing → reviewed rather than staring at one flat
        "Running…". The active PR gets a spinner; the rest a status indicator.
      */}
      {prProgress.length > 0 && (
        <ol className="cm-pr-progress" aria-label="Per-pull-request review progress">
          {prProgress.map((pr) => {
            const meta = PR_STATUS[pr.status] || PR_STATUS['not-started'];
            return (
              <li className="cm-pr-progress__row" key={pr.number}>
                {pr.status === 'in-progress' ? (
                  <InlineLoading
                    className="cm-pr-progress__spinner"
                    status="active"
                    description={meta.label}
                  />
                ) : (
                  <IconIndicator kind={meta.kind} label={meta.label} size={16} />
                )}
                {owner && repo ? (
                  <Link
                    href={`https://github.com/${owner}/${repo}/pull/${pr.number}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    size="sm"
                  >
                    #{pr.number}
                  </Link>
                ) : (
                  <span className="cm-pr-progress__num">#{pr.number}</span>
                )}
                {pr.title && <span className="cm-pr-progress__title">{pr.title}</span>}
              </li>
            );
          })}
        </ol>
      )}

      {clearError && (
        <p className="cm-log__notice cm-log__notice--error" role="status">
          Could not clear the log: {clearError}
        </p>
      )}

      {dropped && (
        <p className="cm-log__notice">
          Earlier output was discarded — this run produced more than the buffer holds.
        </p>
      )}

      {/*
        role="log" with aria-live="polite" announces new lines without stealing
        focus. aria-atomic="false" keeps it to the additions rather than
        re-reading the whole buffer on every poll.

        aria-describedby points to the hint span below, which is a sibling
        rather than a child — placing it inside role="log" would have it
        announced as log output on every live-region update.
      */}
      <span id="cm-log-scroll-hint" className="cds--visually-hidden">
        Scrollable region. Use arrow keys or scroll to read. Tab to exit.
      </span>
      <div
        className="cm-log__body"
        ref={scrollRef}
        onScroll={onScroll}
        role="log"
        aria-live="polite"
        aria-atomic="false"
        aria-label="Review output"
        aria-describedby="cm-log-scroll-hint"
        tabIndex={0}
      >
        {lines.length === 0 ? (
          <div className="cm-log__line cm-log__line--muted">Waiting for output…</div>
        ) : (
          lines.map((line) => (
            <div
              key={line.seq}
              className={`cm-log__line${line.stream === 'stderr' ? ' cm-log__line--err' : ''}`}
            >
              {line.text}
            </div>
          ))
        )}
      </div>
    </Tile>
  );
}

export default ReviewLog;
