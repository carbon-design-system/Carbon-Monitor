/**
 * Focused tests for Elasticsearch-backed credit history and summary endpoints.
 *
 * These tests use the real API router with a fake Elasticsearch client. They do
 * not load .env, contact Elasticsearch, or modify the local ledger.
 */

'use strict';

const fs = require('fs');

process.env.API_ENABLE_AUTH = 'false';
process.env.AUTH_REQUIRED = 'false';
process.env.ES_URL = 'https://es.test';
process.env.CREDIT_LEDGER_PATH = `/tmp/carbon-monitor-credits-es-test-${process.pid}.jsonl`;

const esClient = require('../src/observability/esClient');
const creditLedger = require('../src/api/creditLedger');

const calls = [];
let searchResponse = { hits: { hits: [] } };

esClient.esCall = async (fn) => {
  calls.push(true);
  return fn({
    search: async (request) => {
      calls.push(request);
      return searchResponse;
    },
  });
};

let { handleRequest } = require('../src/api/server');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

async function test(description, fn) {
  try {
    await fn();
    console.log(`  ✅ ${description}`);
    passed++;
  } catch (error) {
    console.error(`  ❌ ${description}`);
    console.error(`     ${error.message}`);
    failed++;
  }
}

function fakeResponse() {
  return {
    statusCode: null,
    headersSent: false,
    body: '',
    setHeader() {},
    writeHead(status) {
      this.statusCode = status;
      this.headersSent = true;
    },
    end(body) {
      if (body) this.body += body;
    },
  };
}

async function request(url) {
  const res = fakeResponse();
  await handleRequest({ method: 'GET', url, headers: { host: 'localhost' } }, res);
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}: ${res.body}`);
  return JSON.parse(res.body);
}

function lastSearch() {
  return calls.filter((call) => call && call.index === 'carbon-monitor-events-*').at(-1);
}

function historyHit() {
  return {
    _source: {
      timestamp: '2026-09-10T14:26:51.967Z',
      pr_number: 158,
      repo: 'example-org/example-repo',
      correlation_id: 'test-correlation',
      payload: {
        coinsSpent: 0.219426,
        remainingAfter: 957.41365,
        durationMs: 33293,
      },
    },
  };
}

async function main() {
  console.log('\n🧪 Elasticsearch credit endpoint tests\n');

  await test('history queries the monthly event index pattern with the required filters', async () => {
    calls.length = 0;
    searchResponse = { hits: { hits: [historyHit()] } };
    const body = await request('/api/credits/history?limit=10');
    const query = lastSearch();
    const filters = query.query.bool.filter;

    assert(query.index === 'carbon-monitor-events-*');
    assert(query.size === 10);
    assert(query.sort[0].timestamp.order === 'desc');
    assert(filters.some((filter) => filter.term?.event_type === 'pr_review_completed'));
    assert(filters.some((filter) => filter.range?.timestamp?.gte === 'now-90d'));
    assert(body.entries.length === 1);
  });

  await test('history maps ES fields to the existing ledger entry shape', async () => {
    searchResponse = { hits: { hits: [historyHit()] } };
    const body = await request('/api/credits/history?limit=100');
    assert(JSON.stringify(body.entries[0]) === JSON.stringify({
      at: '2026-09-10T14:26:51.967Z',
      prNumber: 158,
      repo: 'example-org/example-repo',
      correlationId: 'test-correlation',
      coinsSpent: 0.219426,
      remainingAfter: 957.41365,
      durationMs: 33293,
    }));
    assert(body.cumulative.length === 1);
  });

  await test('history caps requested limits at 100', async () => {
    calls.length = 0;
    searchResponse = { hits: { hits: [] } };
    await request('/api/credits/history?limit=500');
    assert(lastSearch().size === 100);
  });

  await test('successful empty ES history does not fall back to the ledger', async () => {
    const original = creditLedger.readRecent;
    let fallbackCalled = false;
    creditLedger.readRecent = async () => {
      fallbackCalled = true;
      return [{ prNumber: 999 }];
    };
    searchResponse = { hits: { hits: [] } };
    const body = await request('/api/credits/history');
    creditLedger.readRecent = original;
    assert(!fallbackCalled);
    assert(body.entries.length === 0);
  });

  await test('missing historical cost fields map to null', async () => {
    searchResponse = {
      hits: {
        hits: [{
          _source: {
            timestamp: '2026-08-11T15:27:27.113Z',
            pr_number: 1,
            repo: 'owner/repo',
            correlation_id: 'old-event',
          },
        }],
      },
    };
    const body = await request('/api/credits/history');
    assert(body.entries[0].coinsSpent === null);
    assert(body.entries[0].remainingAfter === null);
    assert(body.entries[0].durationMs === null);
  });

  await test('summary requests the required aggregations and maps their values', async () => {
    calls.length = 0;
    searchResponse = {
      aggregations: {
        reviewCount: { value: 93 },
        totalSpent: { value: 0.838074 },
        costedCount: { count: { value: 2 } },
        last24h: { spent: { value: 0.838074 } },
        last7d: { spent: { value: 0.838074 } },
        firstRecordedAt: { value: '2026-08-11T15:27:27.113Z' },
        lastRecordedAt: { value: '2026-09-10T14:43:49.437Z' },
      },
    };
    const body = await request('/api/credits');
    const query = lastSearch();
    assert(query.size === 0);
    assert(query.aggs.reviewCount.value_count.field === 'event_id');
    assert(query.aggs.totalSpent.sum.field === 'payload.coinsSpent');
    assert(query.aggs.costedCount.filter.exists.field === 'payload.coinsSpent');
    assert(query.aggs.last24h.filter.range.timestamp.gte === 'now-24h');
    assert(query.aggs.last7d.filter.range.timestamp.gte === 'now-7d');
    assert(query.aggs.firstRecordedAt.min.field === 'timestamp');
    assert(query.aggs.lastRecordedAt.max.field === 'timestamp');
    assert(body.summary.totalSpent === 0.838074);
    assert(body.summary.reviewCount === 93);
    assert(body.summary.averagePerReview === 0.419037);
    assert(body.summary.lastRecordedAt === '2026-09-10T14:43:49.437Z');
  });

  await test('summary cache reuses the result within 60 seconds', async () => {
    delete require.cache[require.resolve('../src/api/server')];
    ({ handleRequest } = require('../src/api/server'));
    calls.length = 0;
    searchResponse = { aggregations: { reviewCount: { value: 7 }, totalSpent: { value: 2 } } };
    await request('/api/credits');
    const afterFirst = calls.length;
    await request('/api/credits');
    assert(afterFirst > 0);
    assert(calls.length === afterFirst);
  });

  await test('completion event source contains all cost fields', async () => {
    const source = fs.readFileSync('src/index.js', 'utf8');
    assert(source.includes("event_type:     'pr_review_completed'"));
    assert(source.includes('            coinsSpent,'));
    assert(source.includes('            remainingAfter:'));
    assert(source.includes('            durationMs:'));
  });

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().finally(() => {
  try { fs.unlinkSync(process.env.CREDIT_LEDGER_PATH); } catch (_) {}
});
