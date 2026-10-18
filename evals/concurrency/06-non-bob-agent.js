// Claude at REVIEW_CONCURRENCY=2: reviews overlap, each in its own
// CLAUDE_CONFIG_DIR, with no collision. Needs the agent to be set before the
// modules load, hence its own process.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { runBatch } = require('../../tests/fixtures/concurrencyHarness');

(async () => {
  const r = await runBatch({
    prNumbers: [1, 2],
    concurrency: 2,
    agent: 'claude',
    fixtures: { 1: { sleepMs: 400 }, 2: { sleepMs: 400 } },
  });
  assert.strictEqual(r.maxInFlight, 2, 'two in flight');
  assert(!r.lines.some((l) => /ignored/.test(l.text)), 'no override is logged');
  assert(r.snapshots.every((s) => s.concurrency === 2));

  assert.strictEqual(r.claudeRuns.length, 2, 'Claude ran twice');
  const [a, b] = r.claudeRuns;
  assert(a.startedAt < b.endedAt && b.startedAt < a.endedAt, 'runs overlap');
  assert.notStrictEqual(a.home, b.home, 'separate CLAUDE_CONFIG_DIR');
  for (const pr of [1, 2]) {
    const { dir, env } = r.bundles[pr];
    assert.strictEqual(
      fs.realpathSync(env.home),
      fs.realpathSync(path.join(dir, 'claude-config'))
    );
    const mcp = path.join(dir, 'claude-config', 'claude-mcp.json');
    assert.strictEqual(fs.statSync(mcp).mode & 0o777, 0o600);
    assert.strictEqual(r.comments(pr).length, 1);
    assert.strictEqual(r.labels(pr).length, 1);
  }
  assert.strictEqual(r.ledger.length, 2);
  assert(r.ledger.every((e) => e.source === 'claude-result'));
  assert(r.ledger.every((e) => e.coinsSpent === 0.1834));
  assert.deepStrictEqual(r.ledger.map((e) => e.taskId).sort(), [
    'sess-1',
    'sess-2',
  ]);
  await r.cleanup();
  console.log('ok');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
