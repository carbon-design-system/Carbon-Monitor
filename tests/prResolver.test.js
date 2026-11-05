'use strict';

// resolveNumbers (src/prResolver.js), offline against a fake client.

const assert = require('assert');
const { resolveNumbers } = require('../src/prResolver');

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

const OWNER = 'carbon-design-system';
const REPOS = ['carbon', 'carbon-ai-chat'];

const httpError = (status) =>
  Object.assign(new Error(`HTTP ${status}`), { status });

function pr(number, overrides = {}) {
  return {
    number,
    title: `PR ${number}`,
    user: { login: 'octocat' },
    created_at: '2026-10-01T00:00:00Z',
    state: 'open',
    merged_at: null,
    draft: false,
    html_url: `https://github.com/x/y/pull/${number}`,
    ...overrides,
  };
}

// table: { 'repo#number': pr object | Error }; anything absent is a 404.
function fakeClient(table, { delay = 0 } = {}) {
  const calls = [];
  const state = { inFlight: 0, maxInFlight: 0 };
  return {
    calls,
    state,
    async fetchSinglePR({ owner, repo, pullNumber }) {
      calls.push({ owner, repo, pullNumber });
      state.inFlight++;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      try {
        await new Promise((r) => setTimeout(r, delay));
        const hit = table[`${repo}#${pullNumber}`];
        if (hit instanceof Error) throw hit;
        if (!hit) throw httpError(404);
        return hit;
      } finally {
        state.inFlight--;
      }
    },
  };
}

const resolve = (client, numbers) =>
  resolveNumbers({ client, owner: OWNER, repos: REPOS, numbers });

(async () => {
  console.log(
    '\n── resolveNumbers ─────────────────────────────────────────────'
  );

  await test('found in one repo: unique, choice set, fields mapped', async () => {
    const client = fakeClient({
      'carbon-ai-chat#7': pr(7, { draft: true, title: 'Fix chat' }),
    });
    const [r] = await resolve(client, [7]);
    assert.strictEqual(r.number, 7);
    assert.strictEqual(r.resolution, 'unique');
    assert.deepStrictEqual(r.choice, { repo: 'carbon-ai-chat', number: 7 });
    assert.deepStrictEqual(r.matches, [
      {
        repo: 'carbon-ai-chat',
        number: 7,
        title: 'Fix chat',
        author: 'octocat',
        createdAt: '2026-10-01T00:00:00Z',
        state: 'open',
        mergedAt: null,
        draft: true,
        url: 'https://github.com/x/y/pull/7',
      },
    ]);
    assert.ok(client.calls.every((c) => c.owner === OWNER));
  });

  await test('found in none: not-found, no matches, no choice', async () => {
    const [r] = await resolve(fakeClient({}), [9]);
    assert.strictEqual(r.resolution, 'not-found');
    assert.deepStrictEqual(r.matches, []);
    assert.strictEqual(r.choice, null);
  });

  await test('open in both: ambiguous collision, no choice', async () => {
    const client = fakeClient({
      'carbon#1204': pr(1204),
      'carbon-ai-chat#1204': pr(1204),
    });
    const [r] = await resolve(client, [1204]);
    assert.strictEqual(r.resolution, 'ambiguous');
    assert.strictEqual(r.matches.length, 2);
    assert.strictEqual(r.choice, null);
  });

  await test('open in one, merged in the other: only-open picks the open one', async () => {
    const client = fakeClient({
      'carbon#1204': pr(1204, {
        state: 'closed',
        merged_at: '2019-05-01T00:00:00Z',
      }),
      'carbon-ai-chat#1204': pr(1204),
    });
    const [r] = await resolve(client, [1204]);
    assert.strictEqual(r.resolution, 'only-open');
    assert.deepStrictEqual(r.choice, { repo: 'carbon-ai-chat', number: 1204 });
    assert.strictEqual(r.matches.length, 2);
    assert.strictEqual(r.matches[0].mergedAt, '2019-05-01T00:00:00Z');
  });

  await test('open in one, closed unmerged in the other: only-open, mergedAt null', async () => {
    const client = fakeClient({
      'carbon#5': pr(5, { state: 'closed', merged_at: null }),
      'carbon-ai-chat#5': pr(5),
    });
    const [r] = await resolve(client, [5]);
    assert.strictEqual(r.resolution, 'only-open');
    assert.strictEqual(r.choice.repo, 'carbon-ai-chat');
    const closed = r.matches.find((m) => m.repo === 'carbon');
    assert.strictEqual(closed.state, 'closed');
    assert.strictEqual(closed.mergedAt, null);
  });

  await test('closed in both: ambiguous, merged and unmerged told apart', async () => {
    const client = fakeClient({
      'carbon#8': pr(8, { state: 'closed', merged_at: '2020-01-01T00:00:00Z' }),
      'carbon-ai-chat#8': pr(8, { state: 'closed', merged_at: null }),
    });
    const [r] = await resolve(client, [8]);
    assert.strictEqual(r.resolution, 'ambiguous');
    assert.strictEqual(r.choice, null);
    assert.strictEqual(r.matches[0].mergedAt, '2020-01-01T00:00:00Z');
    assert.strictEqual(r.matches[1].mergedAt, null);
  });

  await test('a single closed match is still unique', async () => {
    const client = fakeClient({
      'carbon#3': pr(3, { state: 'closed', merged_at: '2020-01-01T00:00:00Z' }),
    });
    const [r] = await resolve(client, [3]);
    assert.strictEqual(r.resolution, 'unique');
    assert.deepStrictEqual(r.choice, { repo: 'carbon', number: 3 });
  });

  await test('all four resolution values appear in one call', async () => {
    const client = fakeClient({
      'carbon#1': pr(1),
      'carbon#2': pr(2),
      'carbon-ai-chat#2': pr(2, { state: 'closed' }),
      'carbon#3': pr(3),
      'carbon-ai-chat#3': pr(3),
    });
    const out = await resolve(client, [1, 2, 3, 4]);
    assert.deepStrictEqual(
      out.map((r) => r.resolution),
      ['unique', 'only-open', 'ambiguous', 'not-found']
    );
  });

  await test('matches follow the configured repo order', async () => {
    const client = fakeClient({
      'carbon#3': pr(3),
      'carbon-ai-chat#3': pr(3),
    });
    const [a] = await resolveNumbers({
      client,
      owner: OWNER,
      repos: ['carbon-ai-chat', 'carbon'],
      numbers: [3],
    });
    assert.deepStrictEqual(
      a.matches.map((m) => m.repo),
      ['carbon-ai-chat', 'carbon']
    );
  });

  await test('a 500 from GitHub rethrows', async () => {
    const client = fakeClient({ 'carbon#1': httpError(500) });
    await assert.rejects(
      () => resolve(client, [1]),
      (err) => err.status === 500
    );
  });

  await test('a 500 stops new lookups from starting', async () => {
    const table = {};
    for (let n = 1; n <= 20; n++) table[`carbon#${n}`] = httpError(500);
    const client = fakeClient(table, { delay: 5 });
    await assert.rejects(() =>
      resolve(client, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    );
    assert.ok(
      client.calls.length < 20,
      `expected fewer than 20 calls, got ${client.calls.length}`
    );
  });

  await test('output order matches input order, even when lookups finish out of order', async () => {
    const client = {
      async fetchSinglePR({ repo, pullNumber }) {
        // Earlier numbers answer later.
        await new Promise((r) => setTimeout(r, (10 - pullNumber) * 3));
        if (repo !== 'carbon') throw httpError(404);
        return pr(pullNumber);
      },
    };
    const input = [9, 2, 7, 4, 1];
    const out = await resolve(client, input);
    assert.deepStrictEqual(
      out.map((r) => r.number),
      input
    );
    assert.ok(out.every((r, i) => r.choice.number === input[i]));
  });

  await test('no more than 4 lookups are in flight (20 numbers x 2 repos)', async () => {
    const table = {};
    const numbers = [];
    for (let n = 1; n <= 20; n++) {
      numbers.push(n);
      table[`carbon#${n}`] = pr(n);
    }
    const client = fakeClient(table, { delay: 5 });
    const out = await resolve(client, numbers);
    assert.strictEqual(out.length, 20);
    assert.strictEqual(client.calls.length, 40);
    assert.ok(client.state.maxInFlight <= 4, `max ${client.state.maxInFlight}`);
    assert.ok(client.state.maxInFlight > 1, 'lookups should overlap');
  });

  await test('an empty number list makes no calls', async () => {
    const client = fakeClient({});
    assert.deepStrictEqual(await resolve(client, []), []);
    assert.strictEqual(client.calls.length, 0);
  });

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Passed: ${passed}  Failed: ${failed}`);
  if (failed > 0) process.exit(1);
})();
