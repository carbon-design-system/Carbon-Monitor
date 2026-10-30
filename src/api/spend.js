'use strict';

// Month-to-date spend of one agent. Elasticsearch survives a new container; the
// ledger also holds reviews that failed. A budget gate may over-estimate and
// never under, so the larger figure wins and either one answers alone.
const esClient = require('../observability/esClient');
const creditLedger = require('./creditLedger');
const esNames = require('../esNames');

const round = (n) => Math.round(n * 1e6) / 1e6;

function monthStart(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

async function fromElasticsearch(adapter, since) {
  // The module object is called so a test can replace esCall.
  const result = await esClient.esCall((client) =>
    client.search({
      index: esNames.eventsWildcard(),
      size: 0,
      query: {
        bool: {
          filter: [
            // A run stopped at its cost cap spent money but never completed.
            {
              terms: {
                event_type: ['pr_review_completed', 'agent_limit_reached'],
              },
            },
            { term: { agent: adapter.id } },
            { range: { timestamp: { gte: since.toISOString() } } },
          ],
        },
      },
      aggs: { spent: { sum: { field: 'payload.coinsSpent' } } },
    })
  );
  const value =
    result && result.aggregations && result.aggregations.spent
      ? result.aggregations.spent.value
      : null;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// An entry written before the unit field existed still counts by its source.
async function fromLedger(adapter, since) {
  const entries = await creditLedger.readAll();
  return entries
    .filter(
      (e) =>
        (e.costUnit === adapter.costUnit ||
          e.source === adapter.resultSource) &&
        typeof e.coinsSpent === 'number' &&
        Date.parse(e.at) >= since.getTime()
    )
    .reduce((sum, e) => sum + e.coinsSpent, 0);
}

/**
 * @param {Object} adapter - an entry of src/agents
 * @returns {Promise<{spent: number, source: 'elasticsearch'|'ledger', since: string}>}
 */
async function monthToDate(adapter) {
  const since = monthStart();
  let es = null;
  try {
    es = await fromElasticsearch(adapter, since);
  } catch (_) {
    es = null;
  }
  const ledger = await fromLedger(adapter, since);
  const useLedger = es === null || ledger > es;
  return {
    spent: round(useLedger ? ledger : es),
    source: useLedger ? 'ledger' : 'elasticsearch',
    since: since.toISOString(),
  };
}

module.exports = { monthToDate, monthStart };
