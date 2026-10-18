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

// ── Block Kit builder ─────────────────────────────────────────────────────────

/**
 * Build the Slack Block Kit payload for a completed review run.
 *
 * @param {Object} opts
 * @param {number}   opts.startedAt  - epoch ms when the run kicked off
 * @param {string}   opts.repo       - "owner/repo"
 * @param {Array}    opts.results    - per-PR result objects (see postRunDigest)
 * @param {number}   [opts.maxPRs]   - selection cap (MAX_PRS_PER_RUN); shown as "Criteria" when paired with daysBack
 * @param {number}   [opts.daysBack] - age window in days (N_DAYS_SINCE_PR_CREATED); shown as "Criteria" when paired with maxPRs
 * @returns {Object} - Slack API blocks payload
 */
function buildPayload({ startedAt, repo, results, maxPRs, daysBack }) {
  const timeStr = formatEasternTime(startedAt);
  const blocks = [];

  // ── Header ──────────────────────────────────────────────────────────────────
  blocks.push({
    type: 'header',
    text: {
      type: 'plain_text',
      text: '📋  Carbon Monitor — Review Digest',
      emoji: true,
    },
  });

  // Criteria only renders when both config values are supplied — callers that
  // omit them (e.g. unit tests) still get a valid Repo/Run-started section
  // rather than an "undefined most recent PRs" line.
  const introLines = [`*Repo:* ${repo}`, `*Run started:* ${timeStr}`];
  if (Number.isFinite(maxPRs) && Number.isFinite(daysBack)) {
    introLines.push(
      `*Criteria:* ${maxPRs} most recent PRs opened within the last ${daysBack} days`
    );
  }

  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: introLines.join('\n'),
    },
  });

  blocks.push({ type: 'divider' });

  // ── Per-PR results ───────────────────────────────────────────────────────────
  if (results.length === 0) {
    // No-PR-found path — run fired but nothing was eligible
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '_No eligible PRs found for this run._',
      },
    });
  } else {
    for (const result of results) {
      if (result.failed) {
        // Failed PR — review could not complete
        blocks.push({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `⚠️  *PR #${result.prNumber}* — review failed\n_${escapeAtSign(result.error || 'Unknown error')}_`,
          },
        });
      } else if (result.skipped) {
        // Skipped PR: left unreviewed on purpose (a low balance, or no file fits the diff budget)
        blocks.push({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `⏭️  *<${result.prUrl}|PR #${result.prNumber}>* — Skipped\n_${escapeAtSign(result.reason || 'Skipped before the review started')}_`,
          },
        });
      } else {
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

        blocks.push({
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
        });
      }

      blocks.push({ type: 'divider' });
    }
  }

  // ── Footer ───────────────────────────────────────────────────────────────────
  const reviewedCount = results.filter((r) => !r.failed && !r.skipped).length;
  const failedCount = results.filter((r) => r.failed).length;
  const skippedCount = results.filter((r) => r.skipped).length;
  const parts = [];
  if (reviewedCount > 0)
    parts.push(`${reviewedCount} PR${reviewedCount !== 1 ? 's' : ''} reviewed`);
  if (failedCount > 0) parts.push(`${failedCount} failed`);
  if (skippedCount > 0) parts.push(`${skippedCount} skipped`);
  if (parts.length === 0) parts.push('Run complete');
  const baseUrl = (process.env.BASE_URL || '').trim();
  if (baseUrl) parts.push(`<${baseUrl}|⚙️ Configure schedule>`);

  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: parts.join(' · '),
      },
    ],
  });

  return { blocks };
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
 * Post a run digest to Slack. No-ops silently when SLACK_WEBHOOK_URL is unset.
 * Never throws — a Slack failure must never affect review output.
 *
 * @param {Object} opts
 * @param {number}  opts.startedAt     - epoch ms when the run started (from runStartedAt in index.js)
 * @param {string}  opts.repo          - "owner/repo" string
 * @param {Array}   opts.results       - Array of per-PR result objects:
 *   Success shape: { prNumber, prUrl, findingsCount, summary, recommendation, coverage }
 *   Failure shape: { prNumber, failed: true, error }
 *   Skipped shape: { prNumber, prUrl, skipped: true, reason }
 * @param {number}   [opts.maxPRs]     - selection cap (MAX_PRS_PER_RUN), shown in the Criteria line
 * @param {number}   [opts.daysBack]   - age window in days (N_DAYS_SINCE_PR_CREATED), shown in the Criteria line
 * @param {Function} [opts.emitEvent]  - optional emitEvent fn for ES observability
 * @returns {Promise<void>}
 */
async function postRunDigest({
  startedAt,
  repo,
  results,
  maxPRs,
  daysBack,
  emitEvent,
}) {
  if (!_enabled) return;

  const payload = buildPayload({ startedAt, repo, results, maxPRs, daysBack });

  try {
    await postToSlack(payload);
    console.log(`[slack] digest posted — ${results.length} PR(s)`);

    if (emitEvent) {
      await emitEvent({
        event_type: 'slack_digest_sent',
        repo,
        payload: { prs_count: results.length },
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
  postLowTokenAlert,
  // Exported for testing only
  _buildPayload: buildPayload,
  _buildLowTokenPayload: buildLowTokenPayload,
  _stripMarkdown: stripMarkdown,
  _truncateAtWord: truncateAtWord,
  _flagFor: flagFor,
  _isEnabled: () => _enabled,
};
