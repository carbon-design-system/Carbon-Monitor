/**
 * Offline tests for reviews in flight (REVIEW_CONCURRENCY), using the fake Bob and
 * a local mock GitHub server (tests/fixtures/concurrencyHarness.js).
 *
 *  1. Four PRs at N=2: one comment and one label each, four ledger entries, never
 *     more than two in flight, queue shrinks, tagged logs, a HOME per review
 *  2. A cost-limit failure on one PR leaves its sibling's review intact
 *  3. A confirmed low balance skips scheduled reviews before they start
 *  4. A moving balance is not read as a review's cost while reviews overlap
 *  5. Five PRs show 2 in flight and 3 queued, and a second trigger gets 409
 *  6. A retry sees a bearer refreshed since the review's HOME was seeded
 *  7. reviewLog tags, filters, forwards tagged lines and settles fragments
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { runBatch, sandbox } = require('./fixtures/concurrencyHarness');

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

const overlap = (a, b) => a.startedAt < b.endedAt && b.startedAt < a.endedAt;

async function main() {
  console.log('\nConcurrent review tests\n');

  const four = await runBatch({
    prNumbers: [1, 2, 3, 4],
    concurrency: 2,
    fixtures: {
      1: { cost: 0.1, sleepMs: 300 },
      2: { cost: 0.2, sleepMs: 300 },
      3: { cost: 0.3, sleepMs: 300 },
      4: { cost: 0.4, sleepMs: 300 },
    },
  });

  await test('every PR gets exactly one summary comment and one label', () => {
    for (const pr of [1, 2, 3, 4]) {
      assert.strictEqual(four.comments(pr).length, 1, `comments on #${pr}`);
      assert.strictEqual(four.labels(pr).length, 1, `labels on #${pr}`);
    }
  });

  await test('four ledger entries with distinct tasks and the fixtures costs', () => {
    assert.strictEqual(four.ledger.length, 4);
    assert.deepStrictEqual(
      four.ledger.map((e) => e.prNumber).sort(),
      [1, 2, 3, 4]
    );
    assert.strictEqual(new Set(four.ledger.map((e) => e.taskId)).size, 4);
    assert.deepStrictEqual(
      four.ledger.map((e) => e.coinsSpent).sort(),
      [0.1, 0.2, 0.3, 0.4]
    );
    // One correlation id per batch, as the Kibana cost-per-run panel expects.
    assert.strictEqual(
      new Set(four.ledger.map((e) => e.correlationId)).size,
      1
    );
  });

  await test('Bob rows carry the Bobcoins unit and the comment names IBM Bob', () => {
    for (const row of four.ledger) {
      assert.strictEqual(row.costUnit, 'bobcoins', `unit of #${row.prNumber}`);
    }
    const body = four.comments(1)[0].body.body;
    assert.ok(body.includes('Reviewed by: IBM Bob · Commit: sha1'), body);
    assert.ok(body.includes('\n- Agent: IBM Bob\n'));
    assert.ok(body.includes('**Token Usage:**'), 'exact tokens, as before');
  });

  await test('two in flight at most, and the queue shrinks 2, 1, 0', () => {
    assert.strictEqual(four.maxInFlight, 2);
    const started = four.snapshots.find((s) => s.inFlight.length === 2);
    assert.deepStrictEqual(
      started.inFlight.map((f) => [f.worker, f.pr]),
      [
        [1, 1],
        [2, 2],
      ]
    );
    assert.deepStrictEqual(started.queued, [3, 4]);
    assert.strictEqual(started.concurrency, 2);
    const queueLengths = four.snapshots.map((s) => s.queued.length);
    for (const n of [2, 1, 0]) assert(queueLengths.includes(n), `queue ${n}`);
    assert(
      queueLengths.every((n, i) => i === 0 || n <= queueLengths[i - 1]),
      'queue never grows'
    );
    const last = four.snapshots[four.snapshots.length - 1];
    assert.deepStrictEqual([last.inFlight, last.queued], [[], []]);
  });

  await test('the first two reviews really overlap; Bob ran four times', () => {
    const run = (pr) => four.bobRuns.find((r) => r.pr === pr);
    assert.strictEqual(four.bobRuns.length, 4);
    assert(overlap(run(1), run(2)), 'PR 1 and 2 overlap');
  });

  await test('every log line carries its review tag or [batch], in per-PR order', () => {
    assert(four.lines.length > 0);
    for (const l of four.lines) {
      if (l.pr === undefined) {
        assert(l.text.startsWith('[batch] '), l.text);
        assert.strictEqual(l.worker, undefined);
      } else {
        assert(l.text.startsWith(`[agent ${l.worker} #${l.pr}] `), l.text);
      }
    }
    for (const pr of [1, 2, 3, 4]) {
      const own = four.lines.filter((l) => l.pr === pr);
      assert.strictEqual(new Set(own.map((l) => l.worker)).size, 1);
      const at = (needle) => own.findIndex((l) => l.text.includes(needle));
      assert(at('Reviewing PR') >= 0, `start line for #${pr}`);
      assert(at('Reviewing PR') < at('Bobcoins spent'), 'start before cost');
      assert(at('Bobcoins spent') < at('review complete'), 'cost before end');
      // The child's progress lines inherit the review context.
      assert(
        own.some((l) => l.text.includes('use_skill')),
        'child stream tagged'
      );
    }
    assert(
      !four.lines.some(
        (l) => l.pr === undefined && l.text.includes('use_skill')
      )
    );
  });

  await test('each review ran with its own HOME holding the seeded ~/.bob', () => {
    const homes = [1, 2, 3, 4].map((pr) => four.bundles[pr].env.home);
    assert.strictEqual(new Set(homes).size, 4);
    for (const pr of [1, 2, 3, 4]) {
      const { dir, env } = four.bundles[pr];
      assert.strictEqual(env.home, path.join(dir, 'home'));
      const bob = path.join(env.home, '.bob');
      for (const f of [
        'settings.json',
        'settings/settings.json',
        'settings/mcp.json',
        'rules/a.md',
        'skills/x/SKILL.md',
      ]) {
        assert(fs.existsSync(path.join(bob, f)), `${f} in #${pr}`);
      }
      assert(fs.lstatSync(path.join(bob, 'skills')).isSymbolicLink());
      const trusted = JSON.parse(
        fs.readFileSync(path.join(bob, 'trustedFolders.json'), 'utf8')
      );
      assert.strictEqual(trusted[dir], true, 'bundle trusted');
      assert.strictEqual(trusted['/workspace'], true, 'original kept');
    }
  });

  await test('the digest keeps the original PR order', () => {
    assert.deepStrictEqual(
      four.digest.results.map((r) => r.prNumber),
      [1, 2, 3, 4]
    );
  });
  await four.cleanup();

  const mixed = await runBatch({
    prNumbers: [1, 2],
    concurrency: 2,
    fixtures: {
      1: { source: 'review-cost-limit', sleepMs: 100 },
      2: { sleepMs: 300 },
    },
  });

  await test('a cost-limit failure leaves the sibling review intact', () => {
    assert.strictEqual(mixed.comments(2).length, 1);
    assert.strictEqual(mixed.labels(2).length, 1);
    assert.strictEqual(mixed.comments(1).length, 0);
    assert.strictEqual(mixed.labels(1).length, 0, 'failed PR is not labelled');
    const byPr = Object.fromEntries(
      mixed.digest.results.map((r) => [r.prNumber, r])
    );
    assert.strictEqual(byPr[1].failed, true);
    assert.strictEqual(byPr[2].failed, undefined);
    assert.strictEqual(byPr[2].findingsCount, 1);
    assert(
      mixed.ledger.some((e) => e.prNumber === 1),
      'failed run is billed'
    );
  });
  await mixed.cleanup();

  const paused = await runBatch({
    prNumbers: [1, 2],
    concurrency: 2,
    fixtures: { 1: {}, 2: {} },
    balance: { available: true, percentRemaining: 5, remaining: 5 },
  });

  await test('a confirmed low balance skips scheduled reviews before they start', () => {
    assert.strictEqual(paused.bobRuns.length, 0);
    assert.strictEqual(paused.writes.length, 0);
    assert.deepStrictEqual(
      paused.digest.results.map((r) => [r.prNumber, r.skipped]),
      [
        [1, true],
        [2, true],
      ]
    );
    assert(/Bobcoins at 5%/.test(paused.digest.results[0].reason));
  });
  await paused.cleanup();

  // A balance that rises by 1 on every read, as it does while any Bob runs.
  const moving = () => {
    let usage = 0;
    return () => ({
      available: true,
      usage: ++usage,
      budgetLimit: 1000,
      remaining: 1000 - usage,
      percentRemaining: 50,
      refreshAt: '2999-01-01T00:00:00Z',
      fetchedAt: new Date().toISOString(),
    });
  };
  const costFixtures = {
    1: { cost: 0.1, sleepMs: 300 },
    2: { cost: null, sleepMs: 300 },
  };
  const overlapping = await runBatch({
    prNumbers: [1, 2],
    concurrency: 2,
    fixtures: costFixtures,
    balance: moving(),
  });
  const sequential = await runBatch({
    prNumbers: [1, 2],
    concurrency: 1,
    fixtures: costFixtures,
    balance: moving(),
  });

  await test('overlapping reviews skip the balance cross-check and report no delta', () => {
    const texts = overlapping.lines.map((l) => l.text);
    assert(!texts.some((t) => t.includes('mismatch')), 'no mismatch logged');
    const byPr = Object.fromEntries(
      overlapping.ledger.map((e) => [e.prNumber, e])
    );
    assert.strictEqual(byPr[1].coinsSpent, 0.1);
    assert.strictEqual(
      byPr[2].coinsSpent,
      null,
      'no cost without a reported one'
    );
    assert.strictEqual(byPr[2].source, 'unknown');
  });

  await test('at N=1 the same balance still serves as cross-check and fallback', () => {
    assert(
      sequential.lines.some((l) => l.text.includes('mismatch')),
      'mismatch logged for the reported 0.1 against a delta of 1'
    );
    const byPr = Object.fromEntries(
      sequential.ledger.map((e) => [e.prNumber, e])
    );
    assert.strictEqual(byPr[1].coinsSpent, 0.1);
    assert.strictEqual(byPr[2].source, 'balance-delta');
    assert(byPr[2].coinsSpent > 0);
  });
  await overlapping.cleanup();
  await sequential.cleanup();

  // The server is loaded inside the sandbox so it shares the patched modules.
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const five = [1, 2, 3, 4, 5];
  const server = await sandbox(
    {
      concurrency: 2,
      fixtures: Object.fromEntries(five.map((n) => [n, { sleepMs: 300 }])),
    },
    async () => {
      const { handleRequest } = require('../src/api/server');
      const call = async (method, url, body) => {
        const chunks =
          body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
        const res = {
          headers: {},
          body: '',
          setHeader(k, v) {
            this.headers[k] = v;
          },
          writeHead(status) {
            this.statusCode = status;
          },
          end(chunk) {
            if (chunk) this.body += chunk;
          },
        };
        await handleRequest(
          {
            method,
            url,
            headers: { host: 'localhost' },
            [Symbol.asyncIterator]: async function* () {
              yield* chunks;
            },
          },
          res
        );
        return {
          status: res.statusCode,
          json: res.body ? JSON.parse(res.body) : null,
        };
      };
      const first = await call('POST', '/api/review/trigger', {
        prNumbers: five,
      });
      const second = await call('POST', '/api/review/trigger', {
        prNumbers: five,
      });
      const seen = [];
      for (let i = 0; i < 200; i++) {
        const { json } = await call('GET', '/api/review/status');
        seen.push(json);
        if (!json.running) break;
        await sleep(25);
      }
      return { first, second, seen };
    }
  );

  await test('five PRs show 2 in flight and 3 queued, never more than 2', () => {
    const { first, seen } = server.value;
    assert.strictEqual(first.status, 202);
    assert.strictEqual(first.json.concurrency, 2);
    assert(
      seen.some((s) => s.inFlight.length === 2 && s.queued.length === 3),
      'a status with 2 in flight and 3 queued'
    );
    assert(
      seen.every((s) => s.inFlight.length <= 2),
      'never above 2'
    );
    const last = seen[seen.length - 1];
    assert.deepStrictEqual(
      [last.running, last.inFlight, last.queued],
      [false, [], []]
    );
    for (const pr of five) assert.strictEqual(server.comments(pr).length, 1);
  });

  await test('a second trigger while the batch runs still gets 409', () => {
    const { second } = server.value;
    assert.strictEqual(second.status, 409);
    assert.strictEqual(second.json.success, false);
    assert.deepStrictEqual(second.json.prNumbers, five);
    assert(/is already running/.test(second.json.message));
    assert(/one review session at a time/.test(second.json.message));
  });
  await server.cleanup();

  await test('a retry copies the current mcp.json into the review HOME', async () => {
    const { seedBobHome, refreshBobMcp } = require('../src/reviewBundle');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-refresh-'));
    const saved = process.env.HOME;
    process.env.HOME = path.join(root, 'real');
    try {
      const mcp = path.join(process.env.HOME, '.bob', 'settings', 'mcp.json');
      fs.mkdirSync(path.dirname(mcp), { recursive: true });
      fs.writeFileSync(mcp, '{"bearer":"old"}');
      const home = await seedBobHome(path.join(root, 'bundle'));
      const copy = path.join(home, '.bob', 'settings', 'mcp.json');
      assert.strictEqual(fs.readFileSync(copy, 'utf8'), '{"bearer":"old"}');
      fs.writeFileSync(mcp, '{"bearer":"new"}');
      assert.strictEqual(fs.readFileSync(copy, 'utf8'), '{"bearer":"old"}');
      await refreshBobMcp(home);
      assert.strictEqual(fs.readFileSync(copy, 'utf8'), '{"bearer":"new"}');
    } finally {
      process.env.HOME = saved;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  const reviewLog = require('../src/api/reviewLog');
  const write = process.stdout.write;
  const real = [];
  const tick = () => new Promise((r) => setImmediate(r));

  await test('reviewLog tags, filters, forwards tagged lines and settles fragments', async () => {
    process.stdout.write = (chunk) => {
      real.push(chunk);
      return true;
    };
    try {
      reviewLog.start('t');
      await Promise.all([
        reviewLog.runWithContext({ worker: 1, pr: 11 }, async () => {
          process.stdout.write('ab');
          await tick();
          process.stdout.write('cd\n');
          process.stdout.write('tail');
        }),
        reviewLog.runWithContext({ worker: 2, pr: 22 }, async () => {
          process.stdout.write('xy\n');
        }),
      ]);
      process.stdout.write('batch line\n');
      reviewLog.stop();
    } finally {
      process.stdout.write = write;
    }
    const all = reviewLog.read(0).lines;
    assert.deepStrictEqual(
      all.map((l) => l.text),
      [
        '[agent 2 #22] xy',
        '[agent 1 #11] abcd',
        '[agent 1 #11] tail',
        '[batch] batch line',
      ]
    );
    assert.deepStrictEqual(
      real.join(''),
      '[agent 2 #22] xy\n[agent 1 #11] abcd\n[agent 1 #11] tail\n[batch] batch line\n'
    );
    assert.deepStrictEqual(
      reviewLog.read(0, 500, { pr: 11 }).lines.map((l) => l.text),
      ['[agent 1 #11] abcd', '[agent 1 #11] tail']
    );
    assert.deepStrictEqual(
      reviewLog.read(0, 500, { worker: 2 }).lines.map((l) => [l.worker, l.pr]),
      [[2, 22]]
    );
  });

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
