// REVIEW_CONCURRENCY=1 read from the environment: today's sequential loop.
const assert = require('assert');
const { runBatch } = require('../../tests/fixtures/concurrencyHarness');

(async () => {
  const r = await runBatch({
    prNumbers: [1, 2, 3, 4],
    concurrency: 1,
    envOnly: true,
    fixtures: Object.fromEntries(
      [1, 2, 3, 4].map((n) => [n, { sleepMs: 200 }])
    ),
  });
  assert.strictEqual(r.maxInFlight, 1, 'never two in flight');
  const runs = [...r.bobRuns].sort((a, b) => a.startedAt - b.startedAt);
  assert.deepStrictEqual(
    runs.map((x) => x.pr),
    [1, 2, 3, 4],
    'list order'
  );
  runs.forEach((run, i) => {
    if (i)
      assert(
        run.startedAt >= runs[i - 1].endedAt,
        `#${run.pr} waits for #${runs[i - 1].pr}`
      );
  });
  assert.deepStrictEqual(
    r.snapshots
      .map((s) => s.concurrency)
      .filter((v, i, a) => a.indexOf(v) === i),
    [1]
  );
  const started = r.lines
    .filter((l) => /Reviewing PR #/.test(l.text))
    .map((l) => [l.worker, l.pr]);
  assert.deepStrictEqual(
    started,
    [
      [1, 1],
      [1, 2],
      [1, 3],
      [1, 4],
    ],
    'one worker, list order'
  );
  console.log(
    'starts',
    runs.map((x) => `#${x.pr}@${x.startedAt - r.startedAt}ms`).join(' ')
  );
  await r.cleanup();
  console.log('ok');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
