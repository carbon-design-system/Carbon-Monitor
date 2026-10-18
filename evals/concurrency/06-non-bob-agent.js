// REVIEW_CONCURRENCY=2 with a non-Bob agent: reviews run one at a time, with one
// log line saying why. Needs the agent to be set before the modules load, hence
// its own process.
const assert = require('assert');
const { runBatch } = require('../../tests/fixtures/concurrencyHarness');

(async () => {
  const r = await runBatch({
    prNumbers: [1, 2],
    concurrency: 2,
    agent: 'claude',
    fixtures: { 1: {}, 2: {} },
  });
  assert.strictEqual(r.maxInFlight, 1, 'one at a time');
  assert(
    r.lines.some((l) => /REVIEW_CONCURRENCY=2 ignored/.test(l.text)),
    'the override is logged'
  );
  assert.strictEqual(
    r.lines.filter((l) => /REVIEW_CONCURRENCY=2 ignored/.test(l.text)).length,
    1
  );
  assert(r.snapshots.every((s) => s.concurrency === 1));
  await r.cleanup();
  console.log('ok');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
