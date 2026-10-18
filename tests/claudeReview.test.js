/**
 * Offline tests for whole reviews run by Claude, using the fake claude and the
 * mock GitHub server (tests/fixtures/concurrencyHarness.js). Its own process:
 * the agent is chosen when the modules load.
 *
 *  1. A review posts one comment and one label, records its USD cost under
 *     claude-result, and leaves a Claude bundle (no .env, no .bob)
 *  2. A parse-failure retry is billed and recorded, not only the first run
 *  3. A budget stop still records the spend and posts nothing
 *  4. A scheduled run is not metered by default and skips at a low monthly budget
 */

process.env.GITHUB_AI_AGENT_CLI = 'claude';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
// Captured before the event service loads; it keeps the reference it finds.
const indexed = [];
require('../src/observability/esClient').esCall = async (fn) =>
  fn({ index: async (doc) => indexed.push(doc.document) });
const { runBatch } = require('./fixtures/concurrencyHarness');
const constants = require('../src/constants');

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

const has = (lines, re) => lines.some((l) => re.test(l.text));

async function main() {
  console.log('\nClaude review tests\n');

  const batch = await runBatch({
    prNumbers: [1, 2, 3],
    concurrency: 1,
    agent: 'claude',
    fixtures: {
      1: {},
      2: { emptyFirstRuns: 1 },
      3: { source: 'review-budget' },
    },
  });

  await test('a review posts one comment and one label, and the failing one posts none', () => {
    for (const pr of [1, 2]) {
      assert.strictEqual(batch.comments(pr).length, 1, `comments on #${pr}`);
      assert.strictEqual(batch.labels(pr).length, 1, `labels on #${pr}`);
    }
    assert.strictEqual(batch.comments(3).length, 0);
    assert.strictEqual(batch.labels(3).length, 0);
    assert.strictEqual(batch.claudeRuns.length, 4, 'one, two (retry), one');
  });

  await test('the ledger holds the result record in USD under claude-result', () => {
    const first = batch.ledger.filter((e) => e.prNumber === 1);
    assert.strictEqual(first.length, 1);
    assert.strictEqual(first[0].coinsSpent, 0.1834);
    assert.strictEqual(first[0].source, 'claude-result');
    assert.strictEqual(first[0].taskId, 'sess-1');
    assert.strictEqual(first[0].remainingAfter, null);
    assert.strictEqual(first[0].toolCalls, 5);
    assert.deepStrictEqual(first[0].tokens, {
      input: 54220,
      output: 2210,
      cacheRead: 38500,
      cacheWrite: 14200,
      total: 56430,
    });
  });

  await test('the ledger, the event and the comment all name Claude and its unit', () => {
    for (const row of batch.ledger) {
      assert.strictEqual(row.costUnit, 'usd', `unit of #${row.prNumber}`);
    }
    const done = indexed.filter((d) => d.event_type === 'pr_review_completed');
    assert.strictEqual(done.length, 2);
    for (const doc of done) {
      assert.strictEqual(doc.agent, 'claude');
      assert.strictEqual(doc.payload.cost_unit, 'usd');
      assert.strictEqual(doc.payload.token_source, 'claude');
      assert.strictEqual(doc.payload.coins_source, 'claude-result');
    }
    const body = batch.comments(1)[0].body.body;
    assert.ok(body.includes('Reviewed by: Claude · Commit: sha1'), body);
    assert.ok(body.includes('\n- Agent: Claude\n'));
    assert.ok(!/IBM Bob|Reviewed by: claude/.test(body));
    assert.ok(body.includes('**Token Usage:**'), 'exact, not estimated');
    assert.ok(!body.includes('Estimated Token Usage'));
  });

  await test('the retry is billed and recorded as well as the first run', () => {
    const second = batch.ledger.filter((e) => e.prNumber === 2);
    assert.deepStrictEqual(
      second.map((e) => [e.taskId, e.coinsSpent, e.source]),
      [
        ['sess-empty', 0.05, 'claude-result'],
        ['sess-2', 0.1834, 'claude-result'],
      ]
    );
    assert.ok(has(batch.lines, /retrying claude review once/));
    assert.ok(has(batch.lines, /Claude cost \(retry\): 0\.1834 usd/));
    assert.ok(has(batch.lines, /Retry succeeded/));
  });

  await test('a budget stop is recorded and reported as a failure', () => {
    const third = batch.ledger.filter((e) => e.prNumber === 3);
    assert.strictEqual(third.length, 1);
    assert.strictEqual(third[0].coinsSpent, 5.12);
    assert.strictEqual(third[0].source, 'claude-result');
    const outcome = batch.digest.results.find((r) => r.prNumber === 3);
    assert.strictEqual(outcome.failed, true);
    assert.ok(/claude exited with code 1/.test(outcome.error));
  });

  await test('no Bobcoins accounting is logged for Claude', () => {
    assert.ok(has(batch.lines, /Bobcoins accounting skipped — 'claude'/));
    assert.ok(!has(batch.lines, /Bobcoins spent|Bobcoins:|mismatch/));
  });

  await test('the skill and MCP evidence come from the Claude tool calls', () => {
    assert.ok(has(batch.lines, /invoked it via the Skill tool/));
    assert.ok(has(batch.lines, /Carbon MCP calls: docs_search=1 code_audit=1/));
    assert.ok(has(batch.lines, /claude session: model=claude-sonnet-5-5/));
  });

  await test('the prompt sent to Claude names Claude tools and paths, not Bob', () => {
    for (const run of batch.claudeRuns) {
      const { prompt } = run;
      assert.ok(prompt.includes('.claude/skills/carbon-builder/'));
      assert.ok(!/attempt_completion|\.bob\/skills|read_file/.test(prompt));
    }
  });

  await test('the bundle is a Claude bundle: CLAUDE.md, skill, 0600 MCP file, no .env', () => {
    const { dir, env } = batch.bundles[1];
    assert.ok(
      fs
        .readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8')
        .includes('Carbon PR Review Agent Rules')
    );
    assert.ok(
      fs.existsSync(path.join(dir, '.claude/skills/carbon-builder/SKILL.md'))
    );
    assert.deepStrictEqual(
      JSON.parse(
        fs.readFileSync(path.join(dir, '.claude/settings.json'), 'utf8')
      ),
      { permissions: { blockReadsOutsideWorkingDirectories: true } }
    );
    assert.ok(!fs.existsSync(path.join(dir, '.env')));
    assert.ok(!fs.existsSync(path.join(dir, '.bob')));
    const mcpFile = path.join(dir, 'claude-config', 'claude-mcp.json');
    assert.strictEqual(fs.statSync(mcpFile).mode & 0o777, 0o600);
    const server = JSON.parse(fs.readFileSync(mcpFile, 'utf8')).mcpServers[
      'carbon-mcp'
    ];
    assert.strictEqual(server.type, 'http');
    assert.strictEqual(server.headers.Authorization, 'Bearer test');
    assert.strictEqual(
      fs.realpathSync(env.home),
      fs.realpathSync(path.join(dir, 'claude-config'))
    );
  });
  await batch.cleanup();

  // A throwing result source makes the accounting block fail, first run and retry.
  const claude = require('../src/agents').get('claude');
  Object.defineProperty(claude, 'resultSource', {
    configurable: true,
    get() {
      throw new Error('boom');
    },
  });
  let broken;
  try {
    broken = await runBatch({
      prNumbers: [2],
      concurrency: 1,
      agent: 'claude',
      fixtures: { 2: { emptyFirstRuns: 1 } },
    });
  } finally {
    Object.defineProperty(claude, 'resultSource', {
      value: 'claude-result',
      configurable: true,
      writable: true,
    });
  }
  await test('an accounting failure names Spend, not Bobcoins, for Claude', () => {
    assert.ok(has(broken.lines, /Spend accounting failed: boom/));
    assert.ok(has(broken.lines, /Spend accounting failed \(retry\): boom/));
    assert.ok(!has(broken.lines, /Bobcoins accounting failed/));
  });
  await broken.cleanup();

  const now = new Date().toISOString();
  const seeded = [{ at: now, coinsSpent: 9.5, source: 'claude-result' }];
  const scheduled = {
    prNumbers: [1],
    concurrency: 1,
    agent: 'claude',
    fixtures: { 1: {} },
    ledgerSeed: seeded,
  };

  const unmetered = await runBatch(scheduled);
  await test('a scheduled run is not metered by default, however much was spent', () => {
    assert.strictEqual(unmetered.claudeRuns.length, 1);
    assert.strictEqual(unmetered.comments(1).length, 1);
  });
  await unmetered.cleanup();

  constants.CLAUDE_MONTHLY_BUDGET_USD = 10;
  const budgeted = await runBatch(scheduled);
  constants.CLAUDE_MONTHLY_BUDGET_USD = 0;
  await test('a scheduled run skips the review when the monthly budget is nearly spent', () => {
    assert.strictEqual(budgeted.claudeRuns.length, 0);
    assert.strictEqual(budgeted.comments(1).length, 0);
    assert.deepStrictEqual(budgeted.digest.results, [
      {
        prNumber: 1,
        prUrl: 'https://github.com/mock/mock/pull/1',
        skipped: true,
        reason: 'Claude budget at 5% (below 10% threshold)',
      },
    ]);
    assert.ok(has(budgeted.lines, /PR #1 skipped — Claude budget at 5%/));
  });
  await budgeted.cleanup();

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
