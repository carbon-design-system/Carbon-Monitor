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
    .replace(/^#{1,6}\s+/gm, '')       // ## headings
    .replace(/\*\*(.*?)\*\*/g, '$1')   // **bold**
    .replace(/__(.*?)__/g, '$1')       // __bold__
    .replace(/_(.*?)_/g, '$1')         // _italic_
    .replace(/^---+$/gm, '')           // horizontal rules
    .replace(/^[-*]\s+/gm, '• ')       // bullet lists → •
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // [text](url) → text
    .replace(/`([^`]+)`/g, '$1')       // inline code
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
    return date.toLocaleString('en-US', {
      timeZone: 'America/New_York',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }) + ' ET';
  } catch {
    // Fallback for environments without full ICU
    return date.toISOString();
  }
}

// ── Block Kit builder ─────────────────────────────────────────────────────────

/**
 * Build the Slack Block Kit payload for a completed review run.
 *
 * @param {Object} opts
 * @param {number}   opts.startedAt  - epoch ms when the run kicked off
 * @param {string}   opts.repo       - "owner/repo"
 * @param {Array}    opts.results    - per-PR result objects (see postRunDigest)
 * @returns {Object} - Slack API blocks payload
 */
function buildPayload({ startedAt, repo, results }) {
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

  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*Repo:* ${repo}\n*Run started:* ${timeStr}`,
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
            text: `⚠️  *PR #${result.prNumber}* — review failed\n_${result.error || 'Unknown error'}_`,
          },
        });
      } else {
        const { emoji, label } = flagFor(result.recommendation);
        const issueWord = result.findingsCount === 1 ? 'issue' : 'issues';
        const summary = truncateAtWord(stripMarkdown(result.summary), 150);

        blocks.push({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: [
              `${emoji}  *<${result.prUrl}|PR #${result.prNumber}>* — ${label}`,
              `${result.findingsCount} ${issueWord} found`,
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
  const reviewedCount = results.filter((r) => !r.failed).length;
  const failedCount = results.filter((r) => r.failed).length;
  const parts = [];
  if (reviewedCount > 0)
    parts.push(`${reviewedCount} PR${reviewedCount !== 1 ? 's' : ''} reviewed`);
  if (failedCount > 0)
    parts.push(`${failedCount} failed`);

  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: parts.length > 0 ? parts.join(' · ') : 'Run complete',
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
 *   Success shape: { prNumber, prUrl, findingsCount, summary, recommendation }
 *   Failure shape: { prNumber, failed: true, error }
 * @param {Function} [opts.emitEvent]  - optional emitEvent fn for ES observability
 * @returns {Promise<void>}
 */
async function postRunDigest({ startedAt, repo, results, emitEvent }) {
  if (!_enabled) return;

  const payload = buildPayload({ startedAt, repo, results });

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

module.exports = {
  postRunDigest,
  // Exported for testing only
  _buildPayload: buildPayload,
  _stripMarkdown: stripMarkdown,
  _truncateAtWord: truncateAtWord,
  _flagFor: flagFor,
  _isEnabled: () => _enabled,
};

// Made with Bob
