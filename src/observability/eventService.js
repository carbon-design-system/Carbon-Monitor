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
 *   parse_failed        — parseReviewOutput returned null
 *   catalogue_missing   — review.hasCatalogue === false
 *   skill_unavailable   — no carbon-builder skill read_file calls in output
 *   inline_post_failed  — one or more inline comments failed to post
 */

'use strict';

const { randomUUID } = require('crypto');
const { esCall } = require('./esClient');

// ── Level resolution (mirrors Carbon Migrate ERROR_EVENT_TYPES / WARN_EVENT_TYPES)
const ERROR_EVENTS = new Set([
  'run_failed',
  'pr_review_failed',
  'agent_timeout',
  'parse_failed',
]);
const WARN_EVENTS = new Set([
  'catalogue_missing',
  'skill_unavailable',
  'inline_post_failed',
]);

function resolveLevel(event_type) {
  if (ERROR_EVENTS.has(event_type)) return 'error';
  if (WARN_EVENTS.has(event_type))  return 'warn';
  return 'info';
}

// ── Index name ────────────────────────────────────────────────────────────────
function currentIndex() {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm   = String(now.getUTCMonth() + 1).padStart(2, '0');
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
 * @param {string}  [opts.agent]         — bob | claude | codex
 * @param {string}  [opts.commit_sha]
 * @param {Object}  [opts.payload]       — event-specific fields
 */
async function emitEvent({
  event_type,
  correlation_id,
  repo       = '',
  pr_number  = null,
  agent      = '',
  commit_sha = '',
  payload    = {},
}) {
  const level     = resolveLevel(event_type);
  const timestamp = new Date().toISOString();
  const event_id  = randomUUID(); // unique per document — enables deduplication in Kibana

  const doc = {
    doc_type:       'carbon_monitor_event',
    event_id,
    event_type,
    level,
    timestamp,
    correlation_id,
    repo,
    pr_number,
    agent,
    commit_sha,
    payload,  // full payload goes to console
  };

  // Console always receives the full payload (including raw error text)
  const label = `[metrics:${event_type}]`;
  if      (level === 'error') console.error(label, JSON.stringify(doc));
  else if (level === 'warn')  console.warn(label,  JSON.stringify(doc));
  else                        console.log(label,   JSON.stringify(doc));

  // ES receives a scrubbed copy — no raw stack traces or internal paths
  const esDoc = { ...doc, payload: scrubPayload(payload) };

  await esCall(
    (client) => client.index({ index: currentIndex(), document: esDoc }),
  );
}

module.exports = { emitEvent };

// Made with Bob
