// One fixture sleeps past a 1 s timeout: only that child is killed.
const assert = require('assert');
const { runBatch } = require('../../tests/fixtures/concurrencyHarness');

(async () => {
  const r = await runBatch({
    prNumbers: [1, 2],
    concurrency: 2,
    bobTimeoutMs: 1000,
    fixtures: { 1: { sleepMs: 8000 }, 2: { sleepMs: 200 } },
  });
  const byPr = Object.fromEntries(r.digest.results.map((x) => [x.prNumber, x]));
  assert.strictEqual(byPr[1].failed, true);
  assert(/timeout/i.test(byPr[1].error), byPr[1].error);
  assert.strictEqual(byPr[2].failed, undefined);
  assert.strictEqual(r.comments(2).length, 1);
  assert.strictEqual(r.labels(2).length, 1);
  assert.strictEqual(r.labels(1).length, 0);
  // The timed-out child is gone; the sibling exited by itself.
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  // The runner rejects on SIGTERM before the child is reaped, so allow it a moment.
  const deadline = Date.now() + 3000;
  while (alive(r.bundles[1].env.pid) && Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, 50));
  }
  assert(!alive(r.bundles[1].env.pid), 'PR 1 child was killed');
  assert(
    r.bobRuns.every((x) => x.pr !== 1),
    'PR 1 never reached its end'
  );
  assert(
    r.bobRuns.some((x) => x.pr === 2),
    'PR 2 ran to its end'
  );
  console.log(`wall ${Date.now() - r.startedAt} ms`);
  await r.cleanup();
  console.log('ok');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
