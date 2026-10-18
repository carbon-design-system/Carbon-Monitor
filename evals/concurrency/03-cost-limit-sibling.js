// One PR hits the cost limit; its sibling still posts. Full assertions are in
// tests/concurrency.test.js.
const assert = require('assert');
const { runBatch } = require('../../tests/fixtures/concurrencyHarness');

(async () => {
  const r = await runBatch({
    prNumbers: [1, 2],
    concurrency: 2,
    fixtures: {
      1: { source: 'review-cost-limit', sleepMs: 100 },
      2: { sleepMs: 300 },
    },
  });
  assert.strictEqual(r.labels(1).length, 0);
  assert.strictEqual(r.labels(2).length, 1);
  assert.strictEqual(r.comments(2).length, 1);
  console.log(
    r.digest.results
      .map((x) => `#${x.prNumber} ${x.failed ? 'failed' : 'ok'}`)
      .join(', ')
  );
  await r.cleanup();
  console.log('ok');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
