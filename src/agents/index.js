'use strict';

// The only list of agents. Adding one is a file here and a line below.
const { REVIEW_AGENT } = require('../constants');

const ADAPTERS = [require('./bob'), require('./claude')];
const DEFAULT_ID = 'bob';

function ids() {
  return ADAPTERS.map((a) => a.id);
}

function find(id) {
  return ADAPTERS.find((a) => a.id === id) || null;
}

function get(id = REVIEW_AGENT) {
  const adapter = find(id);
  if (!adapter) {
    throw new Error(
      `Invalid agent type: ${id}. Must be one of: ${ids().join(', ')}`
    );
  }
  return adapter;
}

function current() {
  return get(REVIEW_AGENT);
}

// For status surfaces that must render whatever the environment holds now: the
// named agent (default GITHUB_AI_AGENT_CLI), Bob when unset or unknown.
function resolve(id = process.env.GITHUB_AI_AGENT_CLI) {
  return find(id || DEFAULT_ID) || get(DEFAULT_ID);
}

// An agent that does not isolate its per-user state, or an unknown one, runs alone.
function effectiveConcurrency(adapter, requested) {
  return adapter && adapter.isolated ? requested : 1;
}

module.exports = {
  get,
  find,
  ids,
  current,
  resolve,
  effectiveConcurrency,
  DEFAULT_ID,
};
