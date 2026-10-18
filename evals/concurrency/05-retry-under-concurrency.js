// The first run of PR 1 has no review JSON, the second does (a counter file in its
// HOME decides) while PR 2 runs alongside: the retry parses and the sibling is intact.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { runBatch } = require('../../tests/fixtures/concurrencyHarness');

(async () => {
  const r = await runBatch({
    prNumbers: [1, 2],
    concurrency: 2,
    fixtures: { 1: { emptyFirstRuns: 1, sleepMs: 100 }, 2: { sleepMs: 500 } },
  });
  assert(
    r.lines.some((l) => l.pr === 1 && /Retry succeeded/.test(l.text)),
    'retry parsed'
  );
  assert.strictEqual(
    r.bobRuns.filter((x) => x.pr === 1).length,
    2,
    'two runs of PR 1'
  );
  assert.strictEqual(
    r.ledger.filter((e) => e.prNumber === 1).length,
    2,
    'both runs billed'
  );
  assert.strictEqual(r.comments(1).length, 1);
  assert.strictEqual(r.labels(1).length, 1);
  assert.strictEqual(r.comments(2).length, 1);
  assert.strictEqual(r.labels(2).length, 1);
  const homes = new Set(r.bobRuns.map((x) => `${x.pr}:${x.home}`));
  assert.strictEqual(
    homes.size,
    2,
    'both runs of a PR share its HOME, PRs do not'
  );
  const counter = path.join(r.bundles[1].env.home, 'fake-bob-runs-1');
  assert.strictEqual(fs.readFileSync(counter, 'utf8'), '2');
  await r.cleanup();
  console.log('ok');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
