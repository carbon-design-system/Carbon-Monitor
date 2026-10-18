/**
 * Tests for month-to-date spend (src/api/spend.js) and Claude's budget status
 *
 * Elasticsearch is a stub; the ledger is a scratch file.
 *
 * Covers:
 *  1. Elasticsearch is queried with the agent, both event types and the UTC month
 *  2. The larger of the Elasticsearch and ledger figures wins; either answers alone
 *  3. A ledger fallback counts this month, this unit and nothing else
 *  4. Claude's credits use that figure and its own low-water mark
 *  5. An unmetered Claude asks nobody anything
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-spend-'));
process.env.CREDIT_LEDGER_PATH = path.join(sandbox, 'ledger.jsonl');
process.env.BOB_CREDITS_LOW_PCT = '99';
delete process.env.CLAUDE_BUDGET_LOW_PCT;

const esClient = require('../src/observability/esClient');
const agents = require('../src/agents');
const constants = require('../src/constants');
const spend = require('../src/api/spend');

const claude = agents.get('claude');
const bob = agents.get('bob');

let searches = [];
let esResult = null;
esClient.esCall = async (fn) => {
  if (esResult instanceof Error) throw esResult;
  if (esResult === null) return null;
  return fn({
    search: async (request) => {
      searches.push(request);
      return esResult;
    },
  });
};

const now = new Date();
const thisMonth = now.toISOString();
const lastMonth = new Date(
  Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 20)
).toISOString();
const monthStart = new Date(
  Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
).toISOString();

function seedLedger(rows) {
  fs.writeFileSync(
    process.env.CREDIT_LEDGER_PATH,
    rows.map((r) => JSON.stringify(r)).join('\n') + '\nnot json\n'
  );
}

let passed = 0;
let failed = 0;
async function test(description, fn) {
  try {
    await fn();
    console.log(`  ✅ ${description}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ ${description}`);
    console.error(`     ${err.message}`);
    failed++;
  }
}

async function main() {
  console.log('\n💲 Month-to-date spend tests\n');

  await test('Elasticsearch answers, filtered to the agent, the event and the UTC month', async () => {
    searches = [];
    esResult = { aggregations: { spent: { value: 3.2500004 } } };
    const result = await spend.monthToDate(claude);
    assert.deepStrictEqual(result, {
      spent: 3.25,
      source: 'elasticsearch',
      since: monthStart,
    });
    const [query] = searches;
    assert.strictEqual(query.index, 'carbon-monitor-events-*');
    assert.strictEqual(query.size, 0);
    assert.deepStrictEqual(query.query.bool.filter, [
      {
        terms: { event_type: ['pr_review_completed', 'agent_limit_reached'] },
      },
      { term: { agent: 'claude' } },
      { range: { timestamp: { gte: monthStart } } },
    ]);
    assert.deepStrictEqual(query.aggs, {
      spent: { sum: { field: 'payload.coinsSpent' } },
    });
  });

  await test('the larger of the Elasticsearch and ledger figures wins, either alone answers', async () => {
    seedLedger([{ at: thisMonth, coinsSpent: 7, costUnit: 'usd' }]);
    esResult = { aggregations: { spent: { value: 3 } } };
    let result = await spend.monthToDate(claude);
    assert.deepStrictEqual([result.spent, result.source], [7, 'ledger']);

    esResult = { aggregations: { spent: { value: 8.5 } } };
    result = await spend.monthToDate(claude);
    assert.deepStrictEqual(
      [result.spent, result.source],
      [8.5, 'elasticsearch']
    );

    // A fresh container: the ledger is empty, Elasticsearch has the month.
    seedLedger([]);
    result = await spend.monthToDate(claude);
    assert.deepStrictEqual(
      [result.spent, result.source],
      [8.5, 'elasticsearch']
    );

    // A month with no events and no ledger rows is a real zero.
    esResult = { aggregations: { spent: { value: 0 } } };
    result = await spend.monthToDate(claude);
    assert.strictEqual(result.spent, 0);
  });

  await test('the query sums completed reviews and runs stopped at their cap', async () => {
    searches = [];
    esResult = { aggregations: { spent: { value: 1 } } };
    await spend.monthToDate(claude);
    const types = searches[0].query.bool.filter.find((f) => f.terms).terms
      .event_type;
    assert.deepStrictEqual(types, [
      'pr_review_completed',
      'agent_limit_reached',
    ]);
  });

  await test('the ledger answers when Elasticsearch is off, throws or gives no figure', async () => {
    seedLedger([
      { at: thisMonth, coinsSpent: 4, costUnit: 'usd' },
      { at: thisMonth, coinsSpent: 5.5, source: 'claude-result' },
      {
        at: thisMonth,
        coinsSpent: 50,
        costUnit: 'bobcoins',
        source: 'bob-result',
      },
      { at: thisMonth, coinsSpent: null, costUnit: 'usd' },
      { at: lastMonth, coinsSpent: 100, costUnit: 'usd' },
    ]);
    for (const down of [null, new Error('boom'), { hits: {} }]) {
      esResult = down;
      const result = await spend.monthToDate(claude);
      assert.deepStrictEqual(
        [result.spent, result.source],
        [9.5, 'ledger'],
        String(down)
      );
    }
    esResult = null;
    const bobSide = await spend.monthToDate(bob);
    assert.strictEqual(bobSide.spent, 50, 'the same ledger read for Bob');
  });

  await test('Claude credits use the Elasticsearch figure and the Claude low-water mark', async () => {
    constants.CLAUDE_MONTHLY_BUDGET_USD = 10;
    seedLedger([]);
    try {
      esResult = { aggregations: { spent: { value: 9.5 } } };
      const low = await claude.credits();
      assert.deepStrictEqual(
        [
          low.available,
          low.spent,
          low.percentRemaining,
          low.low,
          low.threshold,
        ],
        [true, 9.5, 5, true, 10]
      );
      assert.strictEqual(
        low.summary,
        'Claude budget at 5% (below 10% threshold)'
      );

      // BOB_CREDITS_LOW_PCT=99 would make 40% low if Claude read it.
      esResult = { aggregations: { spent: { value: 6 } } };
      const fine = await claude.credits();
      assert.deepStrictEqual([fine.percentRemaining, fine.low], [40, false]);

      constants.CLAUDE_BUDGET_LOW_PCT = 50;
      const strict = await claude.credits();
      assert.deepStrictEqual([strict.low, strict.threshold], [true, 50]);
      assert.strictEqual(
        strict.summary,
        'Claude budget at 40% (below 50% threshold)'
      );
    } finally {
      constants.CLAUDE_MONTHLY_BUDGET_USD = 0;
      constants.CLAUDE_BUDGET_LOW_PCT = 10;
    }
  });

  await test('Claude credits fall back to the ledger and report a failure as a reason', async () => {
    constants.CLAUDE_MONTHLY_BUDGET_USD = 20;
    seedLedger([
      { at: thisMonth, coinsSpent: 4, costUnit: 'usd' },
      { at: thisMonth, coinsSpent: 5.5, source: 'claude-result' },
    ]);
    try {
      esResult = null;
      const viaLedger = await claude.credits();
      assert.deepStrictEqual(
        [viaLedger.spent, viaLedger.percentRemaining],
        [9.5, 52.5]
      );
    } finally {
      constants.CLAUDE_MONTHLY_BUDGET_USD = 0;
    }
  });

  await test('an unmetered Claude queries nothing', async () => {
    searches = [];
    esResult = { aggregations: { spent: { value: 1 } } };
    const result = await claude.credits();
    assert.deepStrictEqual(result, {
      available: false,
      low: false,
      reason: 'not-metered',
    });
    assert.strictEqual(searches.length, 0);
  });

  fs.rmSync(sandbox, { recursive: true, force: true });
  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
