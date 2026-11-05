/**
 * Slack Digest Notifier
 *
 * Posts a summary digest to a Slack channel via Incoming Webhook after each
 * scheduled review run completes. No-ops silently when SLACK_WEBHOOK_URL is
 * not set so existing environments are unaffected.
 *
 * The webhook URL is a bearer credential — it is never logged under any
 * circumstance, including error paths.
 */

'use strict';

const https = require('https');
const { escapeAtSign } = require('./textUtils');

// ── Module-level initialisation ───────────────────────────────────────────────

const _rawUrl = process.env.SLACK_WEBHOOK_URL || '';

/**
 * Whether this module will actually attempt to post.
 * False when the env var is absent or fails the format guard.
 */
let _enabled = false;

if (_rawUrl) {
  if (_rawUrl.startsWith('https://hooks.slack.com/')) {
    _enabled = true;
  } else {
    // Warn once at startup. The URL value is never interpolated into the message.
    console.warn(
      '[slack] SLACK_WEBHOOK_URL does not look like a Slack incoming webhook ' +
        '(expected https://hooks.slack.com/…) — Slack notifications disabled.'
    );
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Strip common Markdown syntax that renders poorly in Slack plain-text fields.
 * Slack's own mrkdwn handles *bold* natively so that passes through unchanged.
 *
 * @param {string} text
 * @returns {string}
 */
function stripMarkdown(text) {
  if (!text) return '';
  return text
    .replace(/^#{1,6}\s+/gm, '') // ## headings
    .replace(/\*\*(.*?)\*\*/g, '$1') // **bold**
    .replace(/__(.*?)__/g, '$1') // __bold__
    .replace(/_(.*?)_/g, '$1') // _italic_
    .replace(/^---+$/gm, '') // horizontal rules
    .replace(/^[-*]\s+/gm, '• ') // bullet lists → •
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // [text](url) → text
    .replace(/`([^`]+)`/g, '$1') // inline code
    .trim();
}

/**
 * Truncate text to maxLen characters at a word boundary, appending '…'.
 * If the text fits within maxLen no ellipsis is added.
 *
 * @param {string} text
 * @param {number} maxLen
 * @returns {string}
 */
function truncateAtWord(text, maxLen) {
  if (!text) return '';
  if (text.length <= maxLen) return text;
  const cut = text.slice(0, maxLen);
  // Walk back to the last whitespace so we don't cut mid-word
  const trimmed = cut.replace(/\s+\S*$/, '');
  return (trimmed || cut) + '…';
}

/**
 * Map a recommendation string to a Slack-safe flag emoji and label.
 *
 * @param {string} recommendation - 'consider-revising' | 'suggested-improvements' | 'looks-good'
 * @returns {{ emoji: string, label: string }}
 */
function flagFor(recommendation) {
  switch (recommendation) {
    case 'consider-revising':
      return { emoji: '🔴', label: 'Significant revision suggested' };
    case 'suggested-improvements':
      return { emoji: '🟡', label: 'Minor rework suggested' };
    case 'looks-good':
      return { emoji: '🟢', label: 'Looks good' };
    default:
      return { emoji: '⚪', label: recommendation || 'Unknown' };
  }
}

/**
 * Format a UTC ISO timestamp for display in US Eastern time.
 *
 * @param {number|string} ts - epoch ms or ISO string
 * @returns {string} e.g. "Jul 28, 2025 at 2:05 PM ET"
 */
function formatEasternTime(ts) {
  const date = new Date(ts);
  try {
    return (
      date.toLocaleString('en-US', {
        timeZone: 'America/New_York',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      }) + ' ET'
    );
  } catch {
    // Fallback for environments without full ICU
    return date.toISOString();
  }
}

// ── Low-token alert Block Kit builder ────────────────────────────────────────

// What a human does about a low balance, keyed by the unit the agent spends in.
const LOW_CREDIT_ACTION = {
  bobcoins:
    'increase your Bobcoins token limit, or disable scheduled ' +
    'reviews in the Carbon Monitor Settings panel. ',
  usd:
    'raise CLAUDE_MONTHLY_BUDGET_USD, or disable scheduled ' +
    'reviews in the Carbon Monitor Settings panel. ',
};

/**
 * Build the Slack Block Kit payload for a low-token auto-pause alert.
 *
 * Used for both the initial auto-pause notification and daily reminders.
 * When `percentRemaining` is null (manually paused or balance unavailable),
 * the percentage line is omitted entirely — never prints "null%".
 *
 * @param {Object}       opts
 * @param {number|null}  opts.percentRemaining - Current % of budget remaining, or null
 * @param {number}       opts.threshold        - The agent's low-water mark (e.g. BOB_CREDITS_LOW_PCT)
 * @param {string}       opts.repo             - "owner/repo"
 * @param {boolean}      opts.isReminder       - true on daily reminders after initial pause
 * @param {string}       [opts.agent]          - Agent id naming the unit and the remedy; defaults to the configured agent
 * @returns {Object} Slack API blocks payload
 */
function buildLowTokenPayload({
  percentRemaining,
  threshold,
  repo,
  isReminder,
  agent,
}) {
  const agents = require('./agents');
  const adapter = agents.resolve(agent || undefined);
  const blocks = [];

  // ── Header ──────────────────────────────────────────────────────────────────
  const headerText = isReminder
    ? '⚠️  Carbon Monitor — Scheduled Reviews Paused'
    : '⚠️  Carbon Monitor — Scheduled Review Paused';

  blocks.push({
    type: 'header',
    text: {
      type: 'plain_text',
      text: headerText,
      emoji: true,
    },
  });

  // ── Status section ──────────────────────────────────────────────────────────
  // Build the detail lines, omitting the percentage line when unavailable.
  const detailLines = [`*Repo:* ${repo}`];
  const unit = adapter.creditLabel;
  // A metered threshold is always known; an unmetered agent's reminder has none.
  const limit = threshold == null ? '' : ` (threshold: ${threshold}%)`;
  if (percentRemaining !== null && percentRemaining !== undefined) {
    detailLines.push(`*${unit} remaining:* ${percentRemaining}%${limit}`);
  } else {
    detailLines.push(`*${unit} remaining:* below threshold${limit}`);
  }
  if (isReminder) {
    detailLines.push(
      '_This is a daily reminder — the schedule remains paused._'
    );
  }

  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: detailLines.join('\n'),
    },
  });

  blocks.push({ type: 'divider' });

  // ── Action required section ─────────────────────────────────────────────────
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text:
        `*Action required:* ${LOW_CREDIT_ACTION[adapter.costUnit] || LOW_CREDIT_ACTION.bobcoins}` +
        'Scheduled reviews will remain paused until a human resumes them.',
    },
  });

  return { blocks };
}

// ── Run-failure Block Kit builder ────────────────────────────────────────────

/**
 * Build the Slack Block Kit payload for a run that could not start because of
 * its configuration. Says nothing about the balance or the schedule: neither is
 * the cause, and neither is changed.
 *
 * @param {Object}   opts
 * @param {number}   opts.startedAt - epoch ms when the run was attempted
 * @param {string[]} opts.repos     - "owner/repo" for every configured repository
 * @param {string}   opts.error     - The configuration error
 * @returns {Object} Slack API blocks payload
 */
function buildRunFailurePayload({ startedAt, repos, error }) {
  return {
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: '⚠️  Carbon Monitor — Review Run Could Not Start',
          emoji: true,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: [
            `*Repos:* ${repos.join(', ')}`,
            `*Run attempted:* ${formatEasternTime(startedAt)}`,
            `*Configuration error:* _${escapeAtSign(truncateAtWord(error || 'Unknown error', 500))}_`,
          ].join('\n'),
        },
      },
      { type: 'divider' },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*Action required:* No pull requests were reviewed. Correct the configuration, then start a review from the console.',
        },
      },
    ],
  };
}

// ── Block Kit builder ─────────────────────────────────────────────────────────

// Slack rejects a message with more blocks than this.
const MAX_BLOCKS = 50;

const shortName = (full) => String(full).split('/').pop();

/** One section for one PR result. */
function resultBlock(result) {
  if (result.failed) {
    // Failed PR — review could not complete
    return {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `⚠️  *PR #${result.prNumber}* — review failed\n_${escapeAtSign(result.error || 'Unknown error')}_`,
      },
    };
  }
  if (result.skipped) {
    // Skipped PR: left unreviewed on purpose (a low balance, or no file fits the diff budget)
    return {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `⏭️  *<${result.prUrl}|PR #${result.prNumber}>* — Skipped\n_${escapeAtSign(result.reason || 'Skipped before the review started')}_`,
      },
    };
  }
  const { emoji, label } = flagFor(result.recommendation);
  const issueWord = result.findingsCount === 1 ? 'issue' : 'issues';
  const rawSummary = truncateAtWord(stripMarkdown(result.summary), 150);
  // Ensure backtick spans are balanced after truncation — if an odd number
  // of backticks remain the last span was cut mid-token; close it.
  const summary = escapeAtSign(
    rawSummary.split('`').length % 2 === 0 ? rawSummary + '`' : rawSummary
  );

  const cov = result.coverage;
  const partial = cov?.partial
    ? ` · partial review: ${cov.files_reviewed} of ${cov.files_total} files`
    : '';

  return {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: [
        `${emoji}  *<${result.prUrl}|PR #${result.prNumber}>* — ${label}`,
        `${result.findingsCount} ${issueWord} found${partial}`,
        summary ? `_${summary}_` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    },
  };
}

function countsText(results) {
  const reviewed = results.filter((r) => !r.failed && !r.skipped).length;
  const failed = results.filter((r) => r.failed).length;
  const skipped = results.filter((r) => r.skipped).length;
  const parts = [];
  if (reviewed > 0) parts.push(`${reviewed} reviewed`);
  if (failed > 0) parts.push(`${failed} failed`);
  if (skipped > 0) parts.push(`${skipped} skipped`);
  return parts;
}

/**
 * One group per configured repo in `repos` order, then one per repo name found
 * only in the results, so a result is never dropped.
 */
function groupResults(repos, results) {
  const groups = repos.map((full) => ({
    name: shortName(full),
    heading: full,
    results: [],
  }));
  const extra = new Map();
  for (const result of results) {
    const key = result.repo ? shortName(result.repo) : null;
    let group = groups.find((g) => g.name === key);
    // Results without a repo belong to the only configured repo, if there is one.
    if (!group && key === null && groups.length === 1) group = groups[0];
    if (!group) {
      const name = key || 'unknown repository';
      if (!extra.has(name)) {
        extra.set(name, { name, heading: name, results: [] });
      }
      group = extra.get(name);
    }
    group.results.push(result);
  }
  return [...groups, ...extra.values()];
}

/**
 * Build the combined Slack Block Kit digest for a completed review run: every
 * repository in one message, which may exceed Slack's block limit. Use
 * buildPayloads for what is sent.
 *
 * @param {Object} opts
 * @param {number}   opts.startedAt  - epoch ms when the run kicked off
 * @param {string[]} opts.repos      - "owner/repo" for every configured repository, in batch order
 * @param {Array}    opts.results    - per-PR result objects (see postRunDigest), each with `repo` (short name)
 * @param {number}   [opts.maxPRs]   - selection cap (MAX_PRS_PER_REPO); shown as "Criteria" when paired with daysBack
 * @param {number}   [opts.daysBack] - age window in days (N_DAYS_SINCE_PR_CREATED); shown as "Criteria" when paired with maxPRs
 * @returns {Object} - Slack API blocks payload
 */
function buildPayload({ startedAt, repos, results, maxPRs, daysBack }) {
  const groups = groupResults(repos, results);
  return {
    blocks: assemble(
      { startedAt, repos, results, maxPRs, daysBack },
      groups.map((g) => ({
        group: g,
        items: g.results,
      })),
      null
    ),
  };
}

/**
 * Blocks for one message: header, intro, then each part's repo heading and
 * results, and a footer with totals for the whole run.
 *
 * @param {Array<{ group: Object, items: Array }>} parts - the results to show, per group
 * @param {{ n: number, of: number }|null} part - part number when the digest is split
 */
function assemble(
  { startedAt, repos, results, maxPRs, daysBack },
  parts,
  part
) {
  const blocks = [];
  const partLabel = part ? ` (part ${part.n} of ${part.of})` : '';

  blocks.push({
    type: 'header',
    text: {
      type: 'plain_text',
      text: `📋  Carbon Monitor — Review Digest${partLabel}`,
      emoji: true,
    },
  });

  // Criteria only renders when both config values are supplied — callers that
  // omit them (e.g. unit tests) still get a valid intro section rather than an
  // "undefined most recent PRs" line.
  const introLines = [
    `*Repos:* ${repos.map(shortName).join(', ')}`,
    `*Run started:* ${formatEasternTime(startedAt)}`,
  ];
  if (Number.isFinite(maxPRs) && Number.isFinite(daysBack)) {
    introLines.push(
      `*Criteria:* up to ${maxPRs} most recent PRs per repository, opened within the last ${daysBack} days`
    );
  }
  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: introLines.join('\n') },
  });

  for (const { group, items } of parts) {
    blocks.push({ type: 'divider' });
    const heading = [`*${group.heading}*`, ...countsText(group.results)];
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: heading.join(' · ') },
    });
    if (group.results.length === 0) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: '_No eligible PRs._' },
      });
    }
    for (const result of items) blocks.push(resultBlock(result));
  }

  // ── Footer ───────────────────────────────────────────────────────────────────
  const reviewedCount = results.filter((r) => !r.failed && !r.skipped).length;
  const failedCount = results.filter((r) => r.failed).length;
  const skippedCount = results.filter((r) => r.skipped).length;
  const footer = [];
  if (reviewedCount > 0)
    footer.push(
      `${reviewedCount} PR${reviewedCount !== 1 ? 's' : ''} reviewed`
    );
  if (failedCount > 0) footer.push(`${failedCount} failed`);
  if (skippedCount > 0) footer.push(`${skippedCount} skipped`);
  if (footer.length === 0) footer.push('Run complete');
  const baseUrl = (process.env.BASE_URL || '').trim();
  if (baseUrl) footer.push(`<${baseUrl}|⚙️ Configure schedule>`);

  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: footer.join(' · ') }],
  });

  return blocks;
}

/**
 * The messages to send for a run: the combined digest when it fits Slack's
 * block limit; otherwise one message per repository, and a repository with
 * too many results is cut into consecutive chunks. Every message repeats the
 * header, intro, repository heading and footer, and names its part.
 *
 * @param {Object} opts - as buildPayload
 * @returns {Object[]} Slack API blocks payloads, each at most 50 blocks
 */
function buildPayloads(opts) {
  const combined = buildPayload(opts);
  if (combined.blocks.length <= MAX_BLOCKS) return [combined];

  const groups = groupResults(opts.repos, opts.results);
  const chunks = [];
  for (const group of groups) {
    // Room left for results once the repeated blocks and the heading are counted.
    const overhead = assemble(opts, [{ group, items: [] }], {
      n: 99,
      of: 99,
    }).length;
    const room = Math.max(1, MAX_BLOCKS - overhead);
    const total = Math.max(1, Math.ceil(group.results.length / room));
    for (let i = 0; i < total; i++) {
      chunks.push({
        group,
        items: group.results.slice(i * room, (i + 1) * room),
      });
    }
  }
  return chunks.map((chunk, i) => ({
    blocks: assemble(opts, [chunk], { n: i + 1, of: chunks.length }),
  }));
}

// ── HTTP POST ─────────────────────────────────────────────────────────────────

/**
 * POST a JSON payload to the Slack webhook URL.
 * Resolves on 2xx, rejects with an Error on non-2xx or network failure.
 * A 10-second hard timeout prevents a hung Slack endpoint from stalling the run.
 *
 * The webhook URL is never included in any thrown error or log message.
 *
 * @param {Object} payload - Slack API blocks payload
 * @returns {Promise<void>}
 */
function postToSlack(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const url = new URL(_rawUrl);

    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      // Drain the response body so the socket is released
      res.resume();
      if (res.statusCode >= 200 && res.statusCode < 300) {
        resolve();
      } else {
        reject(new Error(`Slack webhook returned HTTP ${res.statusCode}`));
      }
    });

    // 10-second hard timeout — destroy the socket so no handle is left open
    req.setTimeout(10_000, () => {
      req.destroy(new Error('Slack webhook request timed out after 10s'));
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.write(body);
    req.end();
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Post a run digest to Slack, as one message or as several when it would pass
 * Slack's block limit. No-ops silently when SLACK_WEBHOOK_URL is unset.
 * Never throws — a Slack failure must never affect review output.
 *
 * @param {Object} opts
 * @param {number}   opts.startedAt     - epoch ms when the run started (from runStartedAt in index.js)
 * @param {string[]} opts.repos         - "owner/repo" for every configured repository, in batch order
 * @param {Array}    opts.results       - Array of per-PR result objects, each with `repo` (short name):
 *   Success shape: { prNumber, repo, prUrl, findingsCount, summary, recommendation, coverage }
 *   Failure shape: { prNumber, repo, failed: true, error }
 *   Skipped shape: { prNumber, repo, prUrl, skipped: true, reason }
 * @param {number}   [opts.maxPRs]     - selection cap (MAX_PRS_PER_REPO), shown in the Criteria line
 * @param {number}   [opts.daysBack]   - age window in days (N_DAYS_SINCE_PR_CREATED), shown in the Criteria line
 * @param {Function} [opts.emitEvent]  - optional emitEvent fn for ES observability
 * @returns {Promise<void>}
 */
async function postRunDigest({
  startedAt,
  repos,
  results,
  maxPRs,
  daysBack,
  emitEvent,
}) {
  if (!_enabled) return;

  const repo = repos.join(',');
  const payloads = buildPayloads({
    startedAt,
    repos,
    results,
    maxPRs,
    daysBack,
  });

  try {
    for (const payload of payloads) await postToSlack(payload);
    console.log(
      `[slack] digest posted — ${results.length} PR(s) in ${payloads.length} message(s)`
    );

    if (emitEvent) {
      await emitEvent({
        event_type: 'slack_digest_sent',
        repo,
        payload: { prs_count: results.length, messages: payloads.length },
      }).catch(() => {
        // ES failure must not re-surface here
      });
    }
  } catch (err) {
    // Log the error message only — never the URL
    console.warn(`[slack] digest post failed: ${err.message}`);

    if (emitEvent) {
      await emitEvent({
        event_type: 'slack_digest_failed',
        repo,
        payload: { error: err.message },
      }).catch(() => {});
    }
  }
}

/**
 * Post a run-failure alert to Slack. No-ops silently when SLACK_WEBHOOK_URL is
 * unset. Never throws — a Slack failure must never replace the error that
 * stopped the run.
 *
 * @param {Object}   opts
 * @param {number}   opts.startedAt - epoch ms when the run was attempted
 * @param {string[]} opts.repos     - "owner/repo" for every configured repository
 * @param {string}   opts.error     - The configuration error
 * @returns {Promise<void>}
 */
async function postRunFailure({ startedAt, repos, error }) {
  if (!_enabled) return;

  try {
    await postToSlack(buildRunFailurePayload({ startedAt, repos, error }));
    console.log('[slack] run-failure alert posted');
  } catch (err) {
    // Log the error message only — never the URL
    console.warn(`[slack] run-failure alert post failed: ${err.message}`);
  }
}

/**
 * Post a low-token alert to Slack. Used for both the initial auto-pause
 * notification and daily reminders while the schedule remains paused.
 *
 * No-ops silently when SLACK_WEBHOOK_URL is unset.
 * Never throws — a Slack failure must never block the scheduler tick.
 *
 * @param {Object}       opts
 * @param {number|null}  opts.percentRemaining - Current % remaining, or null if unavailable
 * @param {number}       opts.threshold        - The BOB_CREDITS_LOW_PCT threshold value
 * @param {string}       opts.repo             - "owner/repo" string
 * @param {boolean}      opts.isReminder       - true for daily reminders, false for initial alert
 * @param {string}       [opts.agent]          - Agent id; names the unit and the remedy
 * @param {Function}     [opts.emitEvent]      - optional emitEvent fn for ES observability
 * @returns {Promise<void>}
 */
async function postLowTokenAlert({
  percentRemaining,
  threshold,
  repo,
  isReminder,
  agent,
  emitEvent,
}) {
  if (!_enabled) return;

  const payload = buildLowTokenPayload({
    percentRemaining,
    threshold,
    repo,
    isReminder,
    agent,
  });
  const eventType = isReminder
    ? 'schedule_low_token_reminder'
    : 'schedule_low_token_paused';

  try {
    await postToSlack(payload);
    console.log(
      `[slack] low-token alert posted (${isReminder ? 'reminder' : 'initial'})`
    );

    if (emitEvent) {
      emitEvent({
        event_type: eventType,
        repo,
        payload: { percentRemaining, threshold, isReminder },
      }).catch(() => {
        // ES failure must not re-surface here
      });
    }
  } catch (err) {
    // Log the error message only — never the URL
    console.warn(`[slack] low-token alert post failed: ${err.message}`);

    if (emitEvent) {
      emitEvent({
        event_type: eventType,
        repo,
        payload: {
          error: err.message,
          percentRemaining,
          threshold,
          isReminder,
        },
      }).catch(() => {});
    }
  }
}

module.exports = {
  postRunDigest,
  postRunFailure,
  postLowTokenAlert,
  // Exported for testing only
  _buildPayload: buildPayload,
  _buildPayloads: buildPayloads,
  _buildLowTokenPayload: buildLowTokenPayload,
  _buildRunFailurePayload: buildRunFailurePayload,
  _stripMarkdown: stripMarkdown,
  _truncateAtWord: truncateAtWord,
  _flagFor: flagFor,
  _isEnabled: () => _enabled,
};
