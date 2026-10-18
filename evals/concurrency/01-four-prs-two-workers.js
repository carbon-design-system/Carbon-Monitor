// Four PRs, two workers, 300 ms fake delays: the headline numbers of the pool.
// The full assertions live in tests/concurrency.test.js; this prints the timings.
const assert = require('assert');
const { runBatch } = require('../../tests/fixtures/concurrencyHarness');

(async () => {
  const t0 = Date.now();
  const r = await runBatch({
    prNumbers: [1, 2, 3, 4],
    concurrency: 2,
    fixtures: Object.fromEntries(
      [1, 2, 3, 4].map((n) => [n, { cost: n / 10, sleepMs: 300 }])
    ),
  });
  const wall = Date.now() - t0;
  const order = r.snapshots.map(
    (s) =>
      `[${s.inFlight.map((f) => `w${f.worker}#${f.pr}`)}] q=${s.queued.length}`
  );
  console.log(order.join('\n'));
  console.log(`max in flight ${r.maxInFlight}, wall ${wall} ms`);
  for (const run of r.bobRuns) {
    console.log(
      `#${run.pr} bob ${run.startedAt - r.startedAt}..${run.endedAt - r.startedAt} ms`
    );
  }
  assert.strictEqual(r.maxInFlight, 2);
  assert.strictEqual(r.ledger.length, 4);
  for (const pr of [1, 2, 3, 4]) {
    assert.strictEqual(r.comments(pr).length, 1);
    assert.strictEqual(r.labels(pr).length, 1);
  }
  await r.cleanup();
  console.log('ok');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
