'use strict';

/**
 * esNames.js — Elasticsearch index/alias/template name builder.
 *
 * Every name is derived from ES_INDEX_PREFIX (default empty, giving today's
 * literal names). A non-empty prefix changes every name to a disjoint
 * namespace so two deployments sharing one cluster never mix data.
 *
 * Design rule: an empty prefix must produce the exact same strings that were
 * hardcoded before this module existed (AC-5). Each name is a pure function of
 * the prefix alone — no side effects, no I/O.
 */

/** @returns {string} The active prefix, trimmed. Empty string for core. */
function prefix() {
  return (process.env.ES_INDEX_PREFIX || '').trim();
}

/**
 * The write index for the current UTC month.
 * Core (empty prefix): `carbon-monitor-events-YYYY.MM`
 * Caic prefix:         `carbon-monitor-caic-events-YYYY.MM`
 *
 * @param {Date} [now] - Override for testing.
 * @returns {string}
 */
function eventsIndex(now = new Date()) {
  const p = prefix();
  const base = p ? `${p}-events` : 'carbon-monitor-events';
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${base}-${yyyy}.${mm}`;
}

/**
 * The wildcard pattern used when reading events (search/query).
 * Core:  `carbon-monitor-events-*`
 * Caic:  `carbon-monitor-caic-events-*`
 *
 * @returns {string}
 */
function eventsWildcard() {
  const p = prefix();
  return p ? `${p}-events-*` : 'carbon-monitor-events-*';
}

/**
 * The ILM alias (write alias for the events index).
 * Core:  `carbon-monitor-events`
 * Caic:  `carbon-monitor-caic-events`
 *
 * @returns {string}
 */
function eventsAlias() {
  const p = prefix();
  return p ? `${p}-events` : 'carbon-monitor-events';
}

/**
 * The index template name.
 * Core:  `carbon-monitor-events-template`
 * Caic:  `carbon-monitor-caic-events-template`
 *
 * @returns {string}
 */
function eventsTemplate() {
  return `${eventsAlias()}-template`;
}

/**
 * The ILM policy name.
 * Core:  `carbon-monitor-events-ilm`
 * Caic:  `carbon-monitor-caic-events-ilm`
 *
 * @returns {string}
 */
function eventsIlm() {
  return `${eventsAlias()}-ilm`;
}

/**
 * The schedule state index.
 * Core:  `carbon-monitor-schedule`
 * Caic:  `carbon-monitor-caic-schedule`
 *
 * @returns {string}
 */
function scheduleIndex() {
  const p = prefix();
  return p ? `${p}-schedule` : 'carbon-monitor-schedule';
}

/**
 * The MCP state index default (overridden by MCP_STATE_INDEX env var).
 * Core:  `carbon-monitor-mcp-state`
 * Caic:  `carbon-monitor-caic-mcp-state`
 *
 * @returns {string}
 */
function mcpStateIndexDefault() {
  const p = prefix();
  return p ? `${p}-mcp-state` : 'carbon-monitor-mcp-state';
}

module.exports = {
  eventsIndex,
  eventsWildcard,
  eventsAlias,
  eventsTemplate,
  eventsIlm,
  scheduleIndex,
  mcpStateIndexDefault,
};
