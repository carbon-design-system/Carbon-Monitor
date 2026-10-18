/**
 * Event Service — append-only event log to Elasticsearch
 *
 * Writes structured documents to a time-partitioned index:
 *   carbon-monitor-events-YYYY.MM
 *
 * Architecture matches carbon-migrate/agent-dispatcher/src/services/eventService.js:
 *   - Every document has a unique event_id (crypto.randomUUID)
 *   - level is resolved automatically from event_type — no need to pass it
 *   - Error details are scrubbed before writing to ES (no stack traces or
 *     internal paths in the data store — those stay in console logs only)
 *   - If ES is absent or the circuit breaker is OPEN, events are console-only.
 *     The review run is never blocked.
 *
 * Event types tracked:
 *   run_started         — reviewPRs() invocation began
 *   run_completed       — all PRs in a run processed
 *   run_failed          — fatal error aborted the entire run
 *   pr_review_started   — per-PR processing began
 *   pr_review_completed — review posted, label added
 *   pr_review_failed    — per-PR catch block fired
 *   agent_timeout       — agent process killed by timeout
 *   agent_limit_reached — agent stopped at its cost or turn cap
 *   parse_failed        — parseReviewOutput returned null
 */

'use strict';

const { randomUUID } = require('crypto');
const { esCall } = require('./esClient');

// ── Level resolution (mirrors Carbon Migrate ERROR_EVENT_TYPES / WARN_EVENT_TYPES)
const ERROR_EVENTS = new Set([
  'run_failed',
  'pr_review_failed',
  'agent_timeout',
  'agent_limit_reached',
  'parse_failed',
]);
const WARN_EVENTS = new Set(['skill_unavailable', 'inline_post_failed']);

function resolveLevel(event_type) {
  if (ERROR_EVENTS.has(event_type)) return 'error';
  if (WARN_EVENTS.has(event_type)) return 'warn';
  return 'info';
}

// ── Index name ────────────────────────────────────────────────────────────────
function currentIndex() {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `carbon-monitor-events-${yyyy}.${mm}`;
}

// ── Payload scrubbing ─────────────────────────────────────────────────────────
// Strip raw error strings and stack traces before writing to ES.
// Errors are already fully visible in the console log; storing them in ES
// risks leaking internal paths or implementation details into the data store.
function scrubPayload(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const out = { ...payload };
  if (typeof out.error === 'string') {
    // Keep only the first sentence of the message — drop stack/path detail
    out.error = out.error.split('\n')[0].substring(0, 200);
  }
  return out;
}

/**
 * Emit a structured event.
 *
 * @param {Object} opts
 * @param {string}  opts.event_type      — see catalogue above
 * @param {string}  opts.correlation_id  — UUID for the current reviewPRs() run
 * @param {string}  [opts.repo]          — "owner/repo"
 * @param {number}  [opts.pr_number]
 * @param {string}  [opts.agent]         — an id from src/agents
 * @param {string}  [opts.commit_sha]
 * @param {Object}  [opts.payload]       — event-specific fields
 */
async function emitEvent({
  event_type,
  correlation_id,
  repo = '',
  pr_number = null,
  agent = '',
  commit_sha = '',
  payload = {},
}) {
  const level = resolveLevel(event_type);
  const timestamp = new Date().toISOString();
  const event_id = randomUUID(); // unique per document — enables deduplication in Kibana

  const doc = {
    doc_type: 'carbon_monitor_event',
    event_id,
    event_type,
    level,
    timestamp,
    correlation_id,
    repo,
    pr_number,
    agent,
    commit_sha,
    payload, // full payload goes to console
  };

  // Console: one compact line per event. The full document (including raw
  // error text) goes to Elasticsearch; the terminal line is for operators
  // watching live logs. Key fields only — nothing that needs a JSON parser.
  const label = `[metrics:${event_type}]`;
  const parts = [`correlationId=${correlation_id}`];
  if (repo) parts.push(`repo=${repo}`);
  if (pr_number) parts.push(`pr=${pr_number}`);
  if (agent) parts.push(`agent=${agent}`);
  // Surface the most useful payload fields when present.
  if (payload.recommendation)
    parts.push(`recommendation=${payload.recommendation}`);
  if (payload.findings_total != null)
    parts.push(`findings=${payload.findings_total}`);
  if (payload.token_total != null)
    parts.push(`tokens=${payload.token_total.toLocaleString()}`);
  if (payload.duration_ms != null)
    parts.push(`duration=${Math.round(payload.duration_ms / 1000)}s`);
  if (payload.prs_reviewed != null)
    parts.push(`prsReviewed=${payload.prs_reviewed}`);
  if (payload.error)
    parts.push(`error=${payload.error.split('\n')[0].substring(0, 120)}`);
  const summary = parts.join(' ');
  if (level === 'error') console.error(`${label} ${summary}`);
  else if (level === 'warn') console.warn(`${label} ${summary}`);
  else console.log(`${label} ${summary}`);

  // ES receives a scrubbed copy — no raw stack traces or internal paths
  const esDoc = { ...doc, payload: scrubPayload(payload) };

  await esCall((client) =>
    client.index({ index: currentIndex(), document: esDoc })
  );
}

module.exports = { emitEvent };
