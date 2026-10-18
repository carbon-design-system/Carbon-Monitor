/**
 * Tests for Bobcoins balance + ledger (src/api/bobCredits.js, src/api/creditLedger.js)
 *
 * The gateway is stubbed rather than called: the point of these tests is that
 * every failure mode degrades into a labelled `{available:false, reason}` instead
 * of an exception, and that cannot be exercised against a live endpoint.
 *
 * Covers:
 *  1. No BOB_API_KEY reports 'no-api-key' rather than attempting a call
 *  2. An object profile yields usage, limit, remaining and percentage
 *  3. An array profile picks the active entry, not blindly the first
 *  4. A profiles-wrapper object is resolved via activeProfileId
 *  5. 401 reports 'unauthorized'
 *  6. 402 reports 'budget-exceeded' — Bob's own budget-exhausted signal
 *  7. A network failure or timeout reports 'unreachable'
 *  8. Malformed JSON reports 'bad-response'
 *  9. An unexpected status is labelled with the status code
 * 10. The API key never appears in the returned balance
 * 11. The auth header uses Bob's `apikey` scheme with instance/team headers
 * 12. A second call inside the TTL is served from cache; force bypasses it
 * 13. computeSpend returns the usage delta
 * 14. computeSpend returns null on a mid-run budget reset or missing balance
 * 15. record + readRecent round-trips an entry, newest first
 * 16. The ledger prunes to CREDIT_LEDGER_MAX, keeping the newest entries
 * 17. A corrupt or truncated line is skipped, not fatal
 * 18. record does not throw when the ledger cannot be written
 * 19. summary computes totals, average, and 24h/7d windows
 * 20. summary counts uncosted reviews but excludes them from the average
 * 21. buildCumulative runs oldest-first regardless of input order
 * 22. An array carrying no billing fields is bad-response, not a null balance
 * 23. An unparseable timeout/TTL falls back instead of disabling the feature
 * 24. Concurrent polls share one gateway call; force always takes its own
 * 25. The abort timer still covers the body read, not just the headers
 * 26. computeSpend nulls a positive delta that spans a budget reset
 * 27. Appending after a truncated line does not destroy the new record
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

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

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

/**
 * Sandbox every path the modules derive.
 *
 * creditLedger falls back to ~/.config/carbon-monitor/ when MCP_STATE_PATH is
 * unset, so without this the tests would append to the developer's real ledger.
 */
const sandbox = fs.mkdtempSync(
  path.join(os.tmpdir(), 'carbon-monitor-credits-')
);
const originalHome = process.env.HOME;
process.env.HOME = sandbox;
process.env.CREDIT_LEDGER_PATH = path.join(sandbox, 'ledger.jsonl');
process.env.BOB_GATEWAY_BASE_URL = 'https://gateway.test';

const bobCredits = require('../src/api/bobCredits');
const creditLedger = require('../src/api/creditLedger');

const ledgerPath = process.env.CREDIT_LEDGER_PATH;
const realFetch = global.fetch;

/** Replace global fetch and capture what the module sent. */
function stubFetch(handler) {
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    const result = await handler(url, options);
    if (result instanceof Error) throw result;
    return result;
  };
  return calls;
}

/** Minimal Response stand-in — the module only reads status, ok and json(). */
function jsonResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => {
      if (body === '__invalid__') throw new Error('Unexpected token');
      return body;
    },
  };
}

/** Every gateway call must start from a known-empty cache. */
async function balanceFor(status, body) {
  bobCredits.resetCache();
  const calls = stubFetch(() => jsonResponse(status, body));
  const balance = await bobCredits.getBalance();
  return { balance, calls };
}

function resetLedger() {
  fs.rmSync(ledgerPath, { force: true });
  fs.rmSync(`${ledgerPath}.tmp`, { force: true });
}

async function main() {
  console.log('\n🪙 Bobcoins balance + ledger tests\n');

  process.env.BOB_API_KEY = 'test-api-key-do-not-log';

  // ── Balance ───────────────────────────────────────────────────────────────

  await test('reports no-api-key without calling the gateway', async () => {
    delete process.env.BOB_API_KEY;
    bobCredits.resetCache();
    const calls = stubFetch(() => jsonResponse(200, {}));

    const balance = await bobCredits.getBalance();
    assert(balance.available === false, 'should not be available');
    assert(
      balance.reason === 'no-api-key',
      `unexpected reason: ${balance.reason}`
    );
    assert(
      calls.length === 0,
      'must not call a billing endpoint with no credential'
    );

    process.env.BOB_API_KEY = 'test-api-key-do-not-log';
  });

  await test('an object profile yields usage, limit, remaining and percentage', async () => {
    const { balance } = await balanceFor(200, {
      usage: 250,
      budget_limit: 1000,
      plan: 'ibm_bob_enterprise',
      plan_name: 'Enterprise',
      refresh_at: 1767225600,
    });

    assert(balance.available === true, `expected available: ${balance.reason}`);
    assert(balance.usage === 250, `unexpected usage: ${balance.usage}`);
    assert(
      balance.budgetLimit === 1000,
      `unexpected limit: ${balance.budgetLimit}`
    );
    assert(
      balance.remaining === 750,
      `remaining must be limit − usage, got ${balance.remaining}`
    );
    assert(
      balance.percentRemaining === 75,
      `unexpected percent: ${balance.percentRemaining}`
    );
    assert(
      balance.planName === 'Enterprise',
      `unexpected plan name: ${balance.planName}`
    );
    assert(balance.isTrial === false, 'enterprise is not a trial');
    assert(
      balance.refreshAt === new Date(1767225600 * 1000).toISOString(),
      `refresh_at should normalise to ISO, got ${balance.refreshAt}`
    );
  });

  await test('an array profile picks the active entry, not the first', async () => {
    const { balance } = await balanceFor(200, [
      { usage: 10, budget_limit: 100, plan: 'ibm_bob_trial', is_active: false },
      {
        usage: 40,
        budget_limit: 500,
        plan: 'ibm_bob_enterprise',
        is_active: true,
      },
    ]);

    assert(balance.available === true, `expected available: ${balance.reason}`);
    assert(
      balance.budgetLimit === 500,
      `must report the active profile's budget, got ${balance.budgetLimit}`
    );
    assert(
      balance.remaining === 460,
      `unexpected remaining: ${balance.remaining}`
    );
  });

  // ── The shape the live gateway actually returns ──────────────────────────
  // Captured from api.us-east.bob.ibm.com/admin/v1/profile, identifiers replaced. The billing
  // figures live on a TEAM nested inside an INSTANCE, not on the profile root —
  // parsing only the root reported `available` with a null budget, which is what
  // left the console showing no balance against a perfectly valid API key.

  /** A response in the real gateway shape. */
  const liveShape = (teams, instanceOverrides = {}) => ({
    user_id: 'monitor@example.com',
    instances: [
      {
        subscription_id: 'sub-1',
        instance_id: 'inst-1',
        instance_name: 'IBM Internal',
        region: 'global',
        region_domain: 'us-east.bob.ibm.com',
        refresh_at: 1788220800,
        expires_at: null,
        plan_id: 'ibm_bob_internal',
        plan_name: 'IBM internal version',
        role: 'bob-user',
        is_internal: true,
        teams,
        ...instanceOverrides,
      },
    ],
  });

  await test('reads usage and budget from instances[].teams[] (live shape)', async () => {
    const { balance } = await balanceFor(
      200,
      liveShape([
        { id: 'team-1', name: 'default', usage: 1.480782, budget_limit: 100 },
      ])
    );

    assert(balance.available === true, `expected available: ${balance.reason}`);
    assert(balance.usage === 1.480782, `unexpected usage: ${balance.usage}`);
    assert(
      balance.budgetLimit === 100,
      `unexpected budget: ${balance.budgetLimit}`
    );
    assert(
      balance.remaining === 98.519218,
      `unexpected remaining: ${balance.remaining}`
    );
    assert(
      balance.percentRemaining === 98.52,
      `unexpected pct: ${balance.percentRemaining}`
    );
    assert(
      balance.planName === 'IBM internal version',
      `unexpected plan: ${balance.planName}`
    );
    assert(
      balance.refreshAt === new Date(1788220800 * 1000).toISOString(),
      `refresh_at should normalise from unix seconds, got ${balance.refreshAt}`
    );
  });

  await test('BOB_TEAM_ID selects among several teams', async () => {
    const saved = process.env.BOB_TEAM_ID;
    process.env.BOB_TEAM_ID = 'team-b';
    try {
      const { balance } = await balanceFor(
        200,
        liveShape([
          { id: 'team-a', name: 'default', usage: 5, budget_limit: 50 },
          { id: 'team-b', name: 'other', usage: 10, budget_limit: 200 },
        ])
      );
      assert(
        balance.budgetLimit === 200,
        `must honour BOB_TEAM_ID, got ${balance.budgetLimit}`
      );
      assert(
        balance.remaining === 190,
        `unexpected remaining: ${balance.remaining}`
      );
    } finally {
      if (saved === undefined) delete process.env.BOB_TEAM_ID;
      else process.env.BOB_TEAM_ID = saved;
    }
  });

  await test('an instance whose teams carry no billing is bad-response', async () => {
    // Not `available` with nulls: a green tile over an unread balance is worse
    // than an honest failure, because nothing downstream can tell the difference.
    const { balance } = await balanceFor(
      200,
      liveShape([{ id: 't', name: 'default' }])
    );
    assert(
      balance.available === false,
      'must not report a balance it never read'
    );
    assert(
      balance.reason === 'bad-response',
      `unexpected reason: ${balance.reason}`
    );
  });

  await test('a profiles wrapper is resolved via activeProfileId', async () => {
    const { balance } = await balanceFor(200, {
      activeProfileId: 'p2',
      profiles: [
        { id: 'p1', usage: 1, budget_limit: 10, plan: 'ibm_bob_trial' },
        { id: 'p2', usage: 5, budget_limit: 20, plan: 'ibm_bob_trial' },
      ],
    });

    assert(
      balance.budgetLimit === 20,
      `wrong profile selected: ${balance.budgetLimit}`
    );
    assert(
      balance.isTrial === true,
      'ibm_bob_trial should be flagged as a trial'
    );
    assert(
      balance.planName === 'trial',
      `plan name should drop the prefix: ${balance.planName}`
    );
  });

  await test('401 reports unauthorized', async () => {
    const { balance } = await balanceFor(401, { error: 'unauthorized' });
    assert(balance.available === false, 'should not be available');
    assert(
      balance.reason === 'unauthorized',
      `unexpected reason: ${balance.reason}`
    );
  });

  await test('402 reports budget-exceeded', async () => {
    const { balance } = await balanceFor(402, { error: 'budget' });
    assert(
      balance.reason === 'budget-exceeded',
      `402 is Bob's budget-exhausted signal, got ${balance.reason}`
    );
  });

  await test('a network failure reports unreachable', async () => {
    bobCredits.resetCache();
    stubFetch(() => new Error('getaddrinfo ENOTFOUND gateway.test'));

    const balance = await bobCredits.getBalance();
    assert(balance.available === false, 'should not be available');
    assert(
      balance.reason === 'unreachable',
      `unexpected reason: ${balance.reason}`
    );
  });

  await test('an aborted request reports unreachable rather than throwing', async () => {
    bobCredits.resetCache();
    stubFetch(() => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      return err;
    });

    const balance = await bobCredits.getBalance();
    assert(
      balance.reason === 'unreachable',
      `unexpected reason: ${balance.reason}`
    );
  });

  await test('malformed JSON reports bad-response', async () => {
    const { balance } = await balanceFor(200, '__invalid__');
    assert(
      balance.reason === 'bad-response',
      `unexpected reason: ${balance.reason}`
    );
  });

  await test('an unexpected status is labelled with its code', async () => {
    const { balance } = await balanceFor(503, {});
    assert(
      balance.reason === 'http-503',
      `unexpected reason: ${balance.reason}`
    );
  });

  await test('the API key never appears in the returned balance', async () => {
    const { balance } = await balanceFor(200, {
      usage: 1,
      budget_limit: 2,
      plan: 'ibm_bob_trial',
    });
    assert(
      !JSON.stringify(balance).includes('test-api-key-do-not-log'),
      'the balance is served straight to HTTP clients and must carry no credential'
    );
  });

  await test('sends the apikey scheme plus instance and team headers', async () => {
    process.env.BOB_INSTANCE_ID = 'instance-9';
    process.env.BOB_TEAM_ID = 'team-9';

    const { calls } = await balanceFor(200, { usage: 0, budget_limit: 1 });
    const { url, options } = calls[0];

    assert(
      url === 'https://gateway.test/admin/v1/profile',
      `unexpected URL: ${url}`
    );
    assert(
      options.headers.Authorization === 'apikey test-api-key-do-not-log',
      `Bob expects the apikey scheme, got: ${options.headers.Authorization}`
    );
    assert(
      options.headers['x-instance-id'] === 'instance-9',
      'instance header missing'
    );
    assert(options.headers['x-team-id'] === 'team-9', 'team header missing');

    delete process.env.BOB_INSTANCE_ID;
    delete process.env.BOB_TEAM_ID;
  });

  await test('an array of non-billing objects is bad-response, not an empty balance', async () => {
    // Bob's UserProfileService profiles can hold connection config with no
    // budget fields at all. Accepting one would report available:true with every
    // figure null — a green health tile for a balance that was never read.
    const { balance } = await balanceFor(200, {
      activeProfileId: 'p1',
      profiles: [{ id: 'p1', name: 'default', region: 'us-east' }],
    });

    assert(
      balance.available === false,
      'a profile with no billing fields is not a balance'
    );
    assert(
      balance.reason === 'bad-response',
      `unexpected reason: ${balance.reason}`
    );
  });

  await test('an unparseable timeout falls back instead of aborting every call', async () => {
    // setTimeout(fn, NaN) is clamped to ~0ms, so an unvalidated 'BOB_CREDITS_
    // TIMEOUT_MS=10s' would abort every request before it could complete.
    process.env.BOB_CREDITS_TIMEOUT_MS = '10s';
    const { balance } = await balanceFor(200, { usage: 5, budget_limit: 50 });

    assert(
      balance.available === true,
      `a typo must not disable the gateway: ${balance.reason}`
    );
    assert(balance.usage === 5, `unexpected usage: ${balance.usage}`);

    delete process.env.BOB_CREDITS_TIMEOUT_MS;
  });

  await test('an unparseable TTL falls back instead of disabling the cache', async () => {
    process.env.BOB_CREDITS_TTL_MS = '60s';
    bobCredits.resetCache();
    let served = 0;
    stubFetch(() => {
      served++;
      return jsonResponse(200, { usage: served, budget_limit: 100 });
    });

    await bobCredits.getBalance();
    await bobCredits.getBalance();
    assert(
      served === 1,
      `NaN would make every poll refetch; gateway saw ${served} calls`
    );

    delete process.env.BOB_CREDITS_TTL_MS;
  });

  await test('concurrent polls share one gateway call, but force takes its own', async () => {
    bobCredits.resetCache();
    let served = 0;
    stubFetch(async () => {
      served++;
      // Hold the response open so the second caller arrives mid-flight.
      await new Promise((resolve) => setTimeout(resolve, 20));
      return jsonResponse(200, { usage: served, budget_limit: 100 });
    });

    const [a, b] = await Promise.all([
      bobCredits.getBalance(),
      bobCredits.getBalance(),
    ]);
    assert(
      served === 1,
      `N open tabs must not drive N gateway calls, got ${served}`
    );
    assert(a.usage === b.usage, 'both callers should receive the same balance');

    // The review loop's "after" snapshot must observe spend that landed during
    // the run, so it can never be answered by a request that predates it.
    bobCredits.resetCache();
    served = 0;
    const forced = Promise.all([
      bobCredits.getBalance({ force: true }),
      bobCredits.getBalance({ force: true }),
    ]);
    await forced;
    assert(
      served === 2,
      `forced snapshots must each reach the gateway, got ${served}`
    );
  });

  await test('the abort timer still covers the body read, not just the headers', async () => {
    // The defect this guards: clearing the timer when the fetch promise settles
    // disarms it at the HEADERS, leaving res.json() to stream an unbounded body.
    process.env.BOB_CREDITS_TIMEOUT_MS = '60';
    bobCredits.resetCache();

    stubFetch((url, options) => ({
      status: 200,
      ok: true,
      // Headers arrive; the body never does.
      json: () =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    }));

    const startedAt = Date.now();
    const balance = await bobCredits.getBalance();
    const elapsed = Date.now() - startedAt;

    assert(
      elapsed < 5000,
      `a stalled body must be cut off, waited ${elapsed}ms`
    );
    assert(
      balance.reason === 'unreachable',
      `a stalled body should read as unreachable, got ${balance.reason}`
    );

    delete process.env.BOB_CREDITS_TIMEOUT_MS;
  });

  await test('caches within the TTL, and force bypasses the cache', async () => {
    bobCredits.resetCache();
    let served = 0;
    stubFetch(() => {
      served++;
      return jsonResponse(200, { usage: served, budget_limit: 100 });
    });

    const first = await bobCredits.getBalance();
    const second = await bobCredits.getBalance();
    assert(
      served === 1,
      `the UI polls every 30s; a second read must not refetch (${served})`
    );
    assert(
      second.usage === first.usage,
      'the cached value should be returned unchanged'
    );

    const forced = await bobCredits.getBalance({ force: true });
    assert(served === 2, 'force must reach the gateway');
    assert(
      forced.usage === 2,
      `force should return the fresh value, got ${forced.usage}`
    );
  });

  // ── Spend attribution ─────────────────────────────────────────────────────

  await test('computeSpend returns the usage delta', () => {
    const before = { available: true, usage: 100 };
    const after = { available: true, usage: 103.5 };
    assert(
      bobCredits.computeSpend(before, after) === 3.5,
      'spend is usage_after − usage_before'
    );
  });

  await test('computeSpend returns null when the delta cannot be trusted', () => {
    const ok = { available: true, usage: 100 };

    // refresh_at passed mid-review, so usage reset — the difference is nonsense.
    assert(
      bobCredits.computeSpend(
        { available: true, usage: 900 },
        { available: true, usage: 4 }
      ) === null,
      'a negative delta must be reported as unknown, not as negative spend'
    );
    assert(
      bobCredits.computeSpend(null, ok) === null,
      'a missing snapshot yields null'
    );
    assert(
      bobCredits.computeSpend(
        { available: false, reason: 'unreachable', usage: null },
        ok
      ) === null,
      'an unavailable snapshot yields null'
    );
    assert(
      bobCredits.computeSpend({ available: true, usage: null }, ok) === null,
      'a profile without usage yields null'
    );
  });

  await test('computeSpend nulls a positive delta that spans a budget reset', () => {
    // The silent half of a mid-run reset: an account that had spent 0.4 this
    // month resets to 0, the run's own 3.0 lands on top, and the delta reads a
    // perfectly plausible 2.6 — under-reporting by the whole pre-reset month.
    // A negative delta never appears, so the sign cannot catch this.
    const before = {
      available: true,
      usage: 0.4,
      refreshAt: '2026-08-01T00:00:00.000Z',
      fetchedAt: '2026-07-31T23:57:00.000Z',
    };
    const after = {
      available: true,
      usage: 3,
      refreshAt: '2026-09-01T00:00:00.000Z',
      fetchedAt: '2026-08-01T00:03:00.000Z',
    };

    assert(
      bobCredits.computeSpend(before, after) === null,
      'a delta spanning a budget reset must be reported as unknown, not as fact'
    );

    // A gateway that has not yet advanced refresh_at is caught by the reset
    // instant having passed between the two reads.
    assert(
      bobCredits.computeSpend(before, {
        ...after,
        refreshAt: before.refreshAt,
      }) === null,
      'a reset instant that has already passed must also null the delta'
    );

    // The ordinary case is untouched: the reset is still in the future.
    const spend = bobCredits.computeSpend(
      { ...before, refreshAt: '2026-09-01T00:00:00.000Z' },
      { ...after, fetchedAt: '2026-08-01T00:03:00.000Z' }
    );
    assert(
      spend === 2.6,
      `a within-period delta must still be reported, got ${spend}`
    );
  });

  // ── Ledger ────────────────────────────────────────────────────────────────

  await test('record + readRecent round-trips an entry, newest first', async () => {
    resetLedger();

    await creditLedger.record({
      at: '2026-08-01T00:00:00.000Z',
      prNumber: 1,
      repo: 'carbon-design-system/carbon',
      correlationId: 'c-1',
      coinsSpent: 2,
      remainingAfter: 98,
      durationMs: 1000,
      source: 'balance-delta',
    });
    await creditLedger.record({
      at: '2026-08-02T00:00:00.000Z',
      prNumber: 2,
      repo: 'carbon-design-system/carbon',
      correlationId: 'c-2',
      coinsSpent: 3,
      remainingAfter: 95,
      durationMs: 2000,
      source: 'balance-delta',
    });

    const entries = await creditLedger.readRecent(10);
    assert(entries.length === 2, `expected 2 entries, got ${entries.length}`);
    assert(entries[0].prNumber === 2, 'the newest entry should come first');
    assert(
      entries[0].coinsSpent === 3,
      `unexpected spend: ${entries[0].coinsSpent}`
    );
    assert(entries[1].prNumber === 1, 'the older entry should come second');
  });

  await test('prunes to CREDIT_LEDGER_MAX, keeping the newest entries', async () => {
    resetLedger();
    process.env.CREDIT_LEDGER_MAX = '5';

    for (let i = 1; i <= 8; i++) {
      await creditLedger.record({
        at: new Date(Date.UTC(2026, 0, i)).toISOString(),
        prNumber: i,
        coinsSpent: 1,
      });
    }

    const all = await creditLedger.readAll();
    assert(
      all.length === 5,
      `an unbounded ledger fills the disk; got ${all.length} lines`
    );
    assert(
      all[0].prNumber === 4,
      `oldest retained should be #4, got #${all[0].prNumber}`
    );
    assert(
      all[4].prNumber === 8,
      `newest retained should be #8, got #${all[4].prNumber}`
    );
    assert(
      !fs.existsSync(`${ledgerPath}.tmp`),
      'the pruning temp file must be renamed away, not left behind'
    );

    delete process.env.CREDIT_LEDGER_MAX;
  });

  await test('skips a corrupt or truncated line instead of failing the read', async () => {
    resetLedger();
    fs.writeFileSync(
      ledgerPath,
      [
        JSON.stringify({
          at: '2026-08-01T00:00:00.000Z',
          prNumber: 1,
          coinsSpent: 1,
        }),
        '{"at":"2026-08-02T00:00:00.000Z","prNum', // killed mid-append
        'not json at all',
        JSON.stringify({
          at: '2026-08-03T00:00:00.000Z',
          prNumber: 3,
          coinsSpent: 2,
        }),
        '',
      ].join('\n')
    );

    const entries = await creditLedger.readAll();
    assert(
      entries.length === 2,
      `expected the 2 intact lines, got ${entries.length}`
    );
    assert(
      entries[0].prNumber === 1 && entries[1].prNumber === 3,
      'wrong entries survived'
    );
  });

  await test('appending after a truncated line does not destroy the new record', async () => {
    resetLedger();
    // Exactly what a container killed mid-append leaves: a final line with no
    // terminating newline. A bare append would glue the next entry onto it and
    // lose BOTH — the half-written record and the good one that followed.
    fs.writeFileSync(
      ledgerPath,
      `${JSON.stringify({ at: '2026-08-01T00:00:00.000Z', prNumber: 1, coinsSpent: 1 })}\n` +
        '{"at":"2026-08-02T00:00:00.000Z","prNum'
    );

    await creditLedger.record({
      at: '2026-08-03T00:00:00.000Z',
      prNumber: 3,
      coinsSpent: 2,
    });

    const entries = await creditLedger.readAll();
    assert(
      entries.length === 2,
      `the crash must cost one record, not two; got ${entries.length}`
    );
    assert(entries[0].prNumber === 1, 'the intact history should survive');
    assert(
      entries[1].prNumber === 3,
      'the entry written after the crash must be readable'
    );
    assert(
      entries[1].coinsSpent === 2,
      `unexpected spend: ${entries[1].coinsSpent}`
    );
  });

  await test('record keeps task id, tokens and tool calls, and nulls them when absent', async () => {
    resetLedger();
    await creditLedger.record({
      prNumber: 1,
      coinsSpent: 1,
      taskId: 'task-abc',
      tokens: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, total: 15 },
      toolCalls: 7,
    });
    await creditLedger.record({ prNumber: 2, coinsSpent: 1 });

    const [full, partial] = await creditLedger.readAll();
    assert(full.taskId === 'task-abc', 'taskId should pass through');
    assert(full.tokens.cacheRead === 2 && full.tokens.total === 15);
    assert(full.toolCalls === 7, 'toolCalls should pass through');
    assert(
      partial.taskId === null &&
        partial.tokens === null &&
        partial.toolCalls === null,
      'absent fields should default to null'
    );
  });

  await test('record does not throw when the ledger cannot be written', async () => {
    const original = process.env.CREDIT_LEDGER_PATH;
    // A file standing where the directory should be: mkdir fails, so the whole
    // write path fails — exactly what a read-only mount looks like.
    const blocker = path.join(sandbox, 'blocked');
    fs.writeFileSync(blocker, 'not a directory');
    process.env.CREDIT_LEDGER_PATH = path.join(blocker, 'ledger.jsonl');

    const ok = await creditLedger.record({ prNumber: 1, coinsSpent: 1 });
    assert(ok === false, 'a failed write should report false, not throw');

    process.env.CREDIT_LEDGER_PATH = original;
  });

  await test('summary computes totals, average and the 24h/7d windows', async () => {
    resetLedger();
    const now = Date.now();
    const hoursAgo = (h) => new Date(now - h * 3600 * 1000).toISOString();

    await creditLedger.record({ at: hoursAgo(1), prNumber: 1, coinsSpent: 2 });
    await creditLedger.record({ at: hoursAgo(48), prNumber: 2, coinsSpent: 3 });
    await creditLedger.record({
      at: hoursAgo(24 * 30),
      prNumber: 3,
      coinsSpent: 5,
    });

    const s = await creditLedger.summary();
    assert(s.totalSpent === 10, `unexpected total: ${s.totalSpent}`);
    assert(s.reviewCount === 3, `unexpected count: ${s.reviewCount}`);
    // Rounded to 6dp on the way out, so compare within that tolerance.
    assert(
      Math.abs(s.averagePerReview - 10 / 3) < 1e-6,
      `unexpected average: ${s.averagePerReview}`
    );
    assert(
      s.last24hSpent === 2,
      `only the 1h-old entry is inside 24h, got ${s.last24hSpent}`
    );
    assert(
      s.last7dSpent === 5,
      `the 1h and 48h entries are inside 7d, got ${s.last7dSpent}`
    );
    assert(s.firstRecordedAt < s.lastRecordedAt, 'first should precede last');
  });

  await test('summary counts uncosted reviews but excludes them from the average', async () => {
    resetLedger();
    await creditLedger.record({
      at: new Date().toISOString(),
      prNumber: 1,
      coinsSpent: 4,
    });
    // Balance lookup failed for this one — the review happened, its cost is unknown.
    await creditLedger.record({
      at: new Date().toISOString(),
      prNumber: 2,
      coinsSpent: null,
    });

    const s = await creditLedger.summary();
    assert(
      s.reviewCount === 2,
      `both reviews should be counted, got ${s.reviewCount}`
    );
    assert(
      s.totalSpent === 4,
      `an unknown cost must add nothing, got ${s.totalSpent}`
    );
    assert(
      s.averagePerReview === 4,
      `the average must divide by known costs only, got ${s.averagePerReview}`
    );
  });

  await test('summary of an absent ledger is empty, not an error', async () => {
    resetLedger();
    const s = await creditLedger.summary();
    assert(
      s.reviewCount === 0 && s.totalSpent === 0,
      'a fresh container starts empty'
    );
    assert(s.averagePerReview === null, 'no reviews means no average');
    assert(
      s.firstRecordedAt === null && s.lastRecordedAt === null,
      'no timestamps yet'
    );
  });

  await test('buildCumulative runs oldest-first regardless of input order', () => {
    // readRecent returns newest first; the chart must still read forwards.
    const series = creditLedger.buildCumulative([
      { at: '2026-08-03T00:00:00.000Z', coinsSpent: 3, remainingAfter: 90 },
      { at: '2026-08-02T00:00:00.000Z', coinsSpent: null, remainingAfter: 93 },
      { at: '2026-08-01T00:00:00.000Z', coinsSpent: 2, remainingAfter: 98 },
    ]);

    assert(series.length === 3, `expected 3 points, got ${series.length}`);
    assert(
      series[0].at === '2026-08-01T00:00:00.000Z',
      'the series must start oldest'
    );
    assert(
      series[0].cumulativeSpent === 2,
      `unexpected running total: ${series[0].cumulativeSpent}`
    );
    assert(
      series[1].spent === 0 && series[1].cumulativeSpent === 2,
      'an unknown cost contributes zero rather than breaking the line'
    );
    assert(
      series[2].cumulativeSpent === 5,
      `unexpected final total: ${series[2].cumulativeSpent}`
    );
    assert(
      series[2].remaining === 90,
      `remaining should carry through: ${series[2].remaining}`
    );
  });

  await test('a row without a unit is Bobcoins; a recorded unit is kept', async () => {
    resetLedger();
    await creditLedger.record({ prNumber: 1, coinsSpent: 2 });
    await creditLedger.record({
      prNumber: 2,
      coinsSpent: 0.5,
      costUnit: 'usd',
    });
    const rows = await creditLedger.readRecent(10);
    const byPr = Object.fromEntries(rows.map((r) => [r.prNumber, r.costUnit]));
    assert(byPr[1] === 'bobcoins', `default unit, got ${byPr[1]}`);
    assert(byPr[2] === 'usd', `recorded unit, got ${byPr[2]}`);
  });

  await test('summary, readRecent and buildCumulative count only the asked unit', async () => {
    resetLedger();
    const at = new Date().toISOString();
    await creditLedger.record({ at, prNumber: 1, coinsSpent: 2 });
    await creditLedger.record({
      at,
      prNumber: 2,
      coinsSpent: 0.5,
      costUnit: 'usd',
    });
    await creditLedger.record({
      at,
      prNumber: 3,
      coinsSpent: 0.25,
      costUnit: 'usd',
    });

    // The default unit is the configured agent's, bob in the test environment.
    const bob = await creditLedger.summary();
    assert(bob.totalSpent === 2 && bob.reviewCount === 1, JSON.stringify(bob));
    const usd = await creditLedger.summary({ unit: 'usd' });
    assert(
      usd.totalSpent === 0.75 && usd.reviewCount === 2,
      JSON.stringify(usd)
    );
    assert(usd.averagePerReview === 0.375, `average ${usd.averagePerReview}`);

    const recent = await creditLedger.readRecent(1, { unit: 'usd' });
    assert(recent.length === 1 && recent[0].prNumber === 3, 'newest usd row');
    assert(
      (await creditLedger.readRecent(10)).length === 3,
      'no unit: all rows'
    );

    const all = await creditLedger.readAll();
    const series = creditLedger.buildCumulative(all, { unit: 'usd' });
    assert(series.length === 2, `usd points: ${series.length}`);
    assert(series[1].cumulativeSpent === 0.75, 'dollars add up on their own');
    assert(creditLedger.buildCumulative(all).length === 1, 'default is bob');
  });

  // Restore the environment and remove the scratch directory.
  global.fetch = realFetch;
  process.env.HOME = originalHome;
  fs.rmSync(sandbox, { recursive: true, force: true });

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
