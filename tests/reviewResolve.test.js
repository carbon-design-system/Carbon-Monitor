/**
 * Tests for POST /api/review/resolve and the target handling of
 * POST /api/review/trigger (src/api/server.js)
 *
 * A small GitHub stand-in answers the PR lookups and reviewPRs is replaced by a
 * recorder, so nothing here reaches a real network or starts a real review.
 * The pinned-target cases (GITHUB_AI_AGENT_PR_NUMBER) need a fresh process,
 * because index.js reads that variable once, so the file runs itself again.
 *
 * Covers:
 *  1. resolve: unique, collision, not found, merged versus open, order, validation
 *  2. resolve: GitHub 500 is a 502, a missing token a 503, no lock is taken
 *  3. trigger with prs: 202 shape, status shape, 409 busy shape with keys
 *  4. trigger with prNumbers: resolved before the lock, 422 ambiguous and not-found
 *  5. the per-repo cap after resolution and deduplication, and the aggregate cap
 *  6. duplicate refs from mixed input, notes from the open-PR tiebreak
 *  7. resolutionNotes validation (400 before anything starts)
 *  8. /api/config and /api/review/logs?repo=
 *  9. an explicit repo#number or bare-number target pinned in the environment
 */

'use strict';

const assert = require('assert');
const http = require('http');
const { Readable } = require('stream');
const { execFileSync } = require('child_process');

const pinnedArg = process.argv.find((a) => a.startsWith('--pinned='));
const PINNED = pinnedArg ? pinnedArg.slice('--pinned='.length) : null;

for (const k of [
  'GITHUB_AI_AGENT_REPO',
  'GITHUB_AI_AGENT_OWNER',
  'GITHUB_AI_AGENT_PR_NUMBER',
  'SLACK_WEBHOOK_URL',
  'GITHUB_AI_AGENT_CLI',
]) {
  delete process.env[k];
}
Object.assign(process.env, {
  GITHUB_AI_AGENT_REPOS: 'carbon,carbon-ai-chat',
  GITHUB_AI_AGENT_MAX_PRS: '2',
  GITHUB_AI_AGENT_TOKEN: 'test-token',
  API_SECRET: 'supersecret',
  API_ENABLE_AUTH: 'true',
  AUTH_REQUIRED: 'true',
  CONSOLE_USERNAME: 'operator',
  CONSOLE_PASSWORD: 'correct-horse-battery',
  SESSION_SECRET: 'test-session-secret',
});
if (PINNED === 'ref')
  process.env.GITHUB_AI_AGENT_PR_NUMBER = 'carbon-ai-chat#7';
if (PINNED === 'bare') process.env.GITHUB_AI_AGENT_PR_NUMBER = '11';

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

// ── A GitHub stand-in ─────────────────────────────────────────────────────────
// PRs by `repo#number`; anything else is a 404, and `broken` keys answer 500.
const MERGED_AT = '2019-01-01T00:00:00Z';
const PRS = {
  'carbon#1': {},
  'carbon#2': {},
  'carbon#3': {},
  'carbon#11': {},
  'carbon#21': {},
  'carbon-ai-chat#21': {},
  'carbon-ai-chat#5': {},
  'carbon-ai-chat#6': {},
  'carbon-ai-chat#7': {},
  'carbon#31': { state: 'closed', merged_at: MERGED_AT },
  'carbon-ai-chat#31': {},
  'carbon#41': { state: 'closed', merged_at: null },
  'carbon-ai-chat#41': {},
};
const BROKEN = new Set(['carbon#500']);
let lookups = 0;

function startGithub() {
  const server = http.createServer((req, res) => {
    lookups++;
    const m = /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/.exec(req.url);
    const key = m && `${m[2]}#${m[3]}`;
    res.setHeader('content-type', 'application/json');
    if (key && BROKEN.has(key)) {
      res.writeHead(500);
      return res.end(JSON.stringify({ message: 'Server Error' }));
    }
    if (!key || !PRS[key]) {
      res.writeHead(404);
      return res.end(JSON.stringify({ message: 'Not Found' }));
    }
    res.writeHead(200);
    res.end(
      JSON.stringify({
        number: Number(m[3]),
        title: `PR ${key}`,
        user: { login: 'tester' },
        created_at: '2026-10-01T00:00:00Z',
        state: 'open',
        merged_at: null,
        draft: false,
        html_url: `https://github.com/o/${m[2]}/pull/${m[3]}`,
        ...PRS[key],
      })
    );
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => {
          server.closeAllConnections();
          return new Promise((r) => server.close(r));
        },
      })
    )
  );
}

// ── Load the server with a recorder in place of reviewPRs ─────────────────────
// Both are replaced before server.js destructures them. Retries would turn the
// GitHub 500 into a 14-second wait.
const githubClient = require('../src/githubClient');
const createOctokit = githubClient.createOctokit;
githubClient.createOctokit = (opts) =>
  createOctokit({
    ...opts,
    retry: { enabled: false },
    throttle: { enabled: false },
  });

const index = require('../src/index');
const reviewCalls = [];
let hold = null;
index.reviewPRs = (opts) => {
  reviewCalls.push(opts);
  return hold ? hold.promise : Promise.resolve();
};

const { handleRequest } = require('../src/api/server');
const reviewLog = require('../src/api/reviewLog');

function fakeRes() {
  return {
    statusCode: null,
    body: '',
    headersSent: false,
    setHeader() {},
    writeHead(status) {
      this.statusCode = status;
      this.headersSent = true;
    },
    end(chunk) {
      if (chunk) this.body += chunk;
    },
  };
}

// `body` is JSON-encoded unless it is already a string (to send malformed JSON).
async function call(method, url, body) {
  const res = fakeRes();
  const req = Readable.from(
    body === undefined
      ? []
      : [typeof body === 'string' ? body : JSON.stringify(body)]
  );
  Object.assign(req, {
    method,
    url,
    headers: { host: 'localhost', authorization: 'Bearer supersecret' },
  });
  await handleRequest(req, res);
  return {
    status: res.statusCode,
    body: res.body ? JSON.parse(res.body) : null,
  };
}
const post = (url, body) => call('POST', url, body);
const tick = () => new Promise((r) => setImmediate(r));

function startHold() {
  hold = {};
  hold.promise = new Promise((resolve) => {
    hold.release = resolve;
  });
}
async function endHold() {
  const { release } = hold;
  hold = null;
  release();
  for (let i = 0; i < 20; i++) {
    await tick();
    if (!(await call('GET', '/api/review/status')).body.running) return;
  }
  throw new Error('the review never finished');
}

const ref = (repo, number) => ({ repo, number });
const C = 'carbon';
const A = 'carbon-ai-chat';

async function main() {
  const github = await startGithub();
  process.env.GITHUB_API_BASE_URL = github.url;

  try {
    if (PINNED) return await pinnedCases();

    console.log('\n🔎 /api/review/resolve and trigger targets\n');
    await resolveCases();
    await triggerCases();
    await numberCases();
    await capCases();
    await noteCases();
    await configAndLogCases();

    console.log('\n  Pinned target (fresh processes):');
    for (const mode of ['ref', 'bare']) {
      await test(`GITHUB_AI_AGENT_PR_NUMBER pinned as ${mode}`, () => {
        execFileSync(process.execPath, [__filename, `--pinned=${mode}`], {
          stdio: 'pipe',
          env: process.env,
        });
      });
    }
  } finally {
    await github.close();
  }

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

async function pinnedCases() {
  await test(`a target pinned as ${PINNED} is reviewed when the body names none`, async () => {
    const r = await post('/api/review/trigger', {});
    assert.strictEqual(r.status, 202, JSON.stringify(r.body));
    assert.strictEqual(r.body.mode, 'explicit');
    const expected = PINNED === 'ref' ? ref(A, 7) : ref(C, 11);
    assert.deepStrictEqual(r.body.prs, [expected]);
    assert.deepStrictEqual(reviewCalls[0].prs, [expected]);
    await tick();
    const status = (await call('GET', '/api/review/status')).body;
    assert.deepStrictEqual(status.prs, [expected]);
  });

  await test('a body that names PRs outranks the pinned target', async () => {
    await tick();
    const r = await post('/api/review/trigger', { prs: [ref(C, 1)] });
    assert.deepStrictEqual(r.body.prs, [ref(C, 1)]);
  });
  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

async function resolveCases() {
  const resolve = (prNumbers) => post('/api/review/resolve', { prNumbers });

  await test('a number found in one repo is unique, with mergedAt on the match', async () => {
    const r = await resolve([11]);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.success, true);
    const [one] = r.body.results;
    assert.strictEqual(one.number, 11);
    assert.deepStrictEqual(one.choice, ref(C, 11));
    assert.strictEqual(one.resolution, 'unique');
    assert.strictEqual(one.matches.length, 1);
    assert.deepStrictEqual(Object.keys(one.matches[0]).sort(), [
      'author',
      'createdAt',
      'draft',
      'mergedAt',
      'number',
      'repo',
      'state',
      'title',
      'url',
    ]);
    assert.strictEqual(one.matches[0].mergedAt, null);
  });

  await test('open in both repos is a collision with no choice, matches in repo order', async () => {
    const [one] = (await resolve([21])).body.results;
    assert.strictEqual(one.choice, null);
    assert.strictEqual(one.resolution, 'ambiguous');
    assert.deepStrictEqual(
      one.matches.map((m) => m.repo),
      [C, A]
    );
  });

  await test('a number in neither repo is not-found', async () => {
    const [one] = (await resolve([99])).body.results;
    assert.deepStrictEqual(
      { choice: one.choice, matches: one.matches, resolution: one.resolution },
      { choice: null, matches: [], resolution: 'not-found' }
    );
  });

  await test('merged in one repo and open in the other resolves to the open one', async () => {
    const [merged, closed] = (await resolve([31, 41])).body.results;
    assert.strictEqual(merged.resolution, 'only-open');
    assert.deepStrictEqual(merged.choice, ref(A, 31));
    const loser = merged.matches.find((m) => m.repo === C);
    assert.strictEqual(loser.state, 'closed');
    assert.strictEqual(loser.mergedAt, MERGED_AT);
    assert.strictEqual(closed.matches.find((m) => m.repo === C).mergedAt, null);
  });

  await test('results follow the order the numbers were given, from an array or a string', async () => {
    const numbers = (r) => r.body.results.map((x) => x.number);
    assert.deepStrictEqual(numbers(await resolve([5, 11, 99])), [5, 11, 99]);
    const fromString = await resolve('99, 11');
    assert.strictEqual(fromString.status, 200);
    assert.deepStrictEqual(numbers(fromString), [99, 11]);
  });

  await test('bad input is a 400: empty, malformed, not an object, over the aggregate cap', async () => {
    for (const body of [
      {},
      { prNumbers: [] },
      { prNumbers: [0] },
      { prNumbers: ['x'] },
      { prNumbers: [1, 2, 3, 5, 6] }, // 2 per repo x 2 repos = 4
      [],
      null,
      'not json',
    ]) {
      const before = lookups;
      const r = await post('/api/review/resolve', body);
      assert.strictEqual(r.status, 400, JSON.stringify(body));
      assert.ok(r.body.error, JSON.stringify(body));
      assert.strictEqual(lookups, before, 'no lookup for a bad request');
    }
  });

  await test('four numbers across two repos fit the aggregate cap', async () => {
    const r = await resolve([1, 2, 5, 6]);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.results.length, 4);
  });

  await test('a GitHub failure other than 404 is a 502', async () => {
    const r = await resolve([11, 500]);
    assert.strictEqual(r.status, 502);
    assert.ok(/GitHub lookup failed/.test(r.body.error), r.body.error);
  });

  await test('without a GitHub token the route is a 503, not a 502', async () => {
    const token = process.env.GITHUB_AI_AGENT_TOKEN;
    delete process.env.GITHUB_AI_AGENT_TOKEN;
    try {
      const r = await resolve([11]);
      assert.strictEqual(r.status, 503);
    } finally {
      process.env.GITHUB_AI_AGENT_TOKEN = token;
    }
  });

  await test('resolve does not take the review lock and works while a review runs', async () => {
    startHold();
    const started = await post('/api/review/trigger', { prs: [ref(C, 1)] });
    assert.strictEqual(started.status, 202);
    const r = await resolve([11]);
    assert.strictEqual(r.status, 200);
    const status = (await call('GET', '/api/review/status')).body;
    assert.strictEqual(status.running, true);
    await endHold();
    const after = (await call('GET', '/api/review/status')).body;
    assert.strictEqual(after.running, false);
  });
}

async function triggerCases() {
  await test('an auto trigger returns 202 with mode auto, no prs, and the per-repo cap', async () => {
    const before = reviewCalls.length;
    const r = await post('/api/review/trigger', {});
    assert.strictEqual(r.status, 202, JSON.stringify(r.body));
    assert.strictEqual(r.body.success, true);
    assert.strictEqual(r.body.mode, 'auto');
    assert.strictEqual(r.body.prs, null);
    assert.strictEqual(r.body.maxPRs, 2);
    assert.ok(Number.isFinite(r.body.daysBack));
    assert.ok(!('prNumbers' in r.body));
    assert.strictEqual(reviewCalls.length, before + 1);
    assert.strictEqual(reviewCalls[before].prs, null);
    await tick();
  });

  await test('prs: 202 names the refs, status carries prs and keyed progress, a second trigger is a 409 with keys', async () => {
    startHold();
    const prs = [ref(C, 1), ref(A, 5)];
    const before = reviewCalls.length;
    const r = await post('/api/review/trigger', { prs });
    assert.strictEqual(r.status, 202, JSON.stringify(r.body));
    assert.strictEqual(r.body.mode, 'explicit');
    assert.deepStrictEqual(r.body.prs, prs);
    assert.strictEqual(r.body.maxPRs, 2);
    assert.strictEqual(r.body.daysBack, undefined);
    assert.ok(r.body.message.includes('carbon#1, carbon-ai-chat#5'));
    assert.deepStrictEqual(reviewCalls[before].prs, prs);
    assert.ok(!('prNumbers' in reviewCalls[before]));
    assert.deepStrictEqual(reviewCalls[before].resolutionNotes, []);

    const status = (await call('GET', '/api/review/status')).body;
    assert.strictEqual(status.running, true);
    assert.strictEqual(status.mode, 'explicit');
    assert.deepStrictEqual(status.prs, prs);
    assert.deepStrictEqual(status.queued, ['carbon#1', 'carbon-ai-chat#5']);
    assert.ok(!('prNumbers' in status));

    const busy = await post('/api/review/trigger', { prs: [ref(C, 2)] });
    assert.strictEqual(busy.status, 409);
    assert.strictEqual(busy.body.success, false);
    assert.deepStrictEqual(busy.body.prs, prs);
    assert.strictEqual(busy.body.mode, 'explicit');
    assert.ok(busy.body.startedAt);
    assert.ok(
      busy.body.message.includes('carbon#1, carbon-ai-chat#5'),
      busy.body.message
    );
    assert.ok(!('prNumbers' in busy.body));
    assert.strictEqual(reviewCalls.length, before + 1, 'busy starts nothing');
    await endHold();
  });

  await test('invalid prs are a 400 and start nothing', async () => {
    const before = reviewCalls.length;
    for (const prs of [
      'carbon#1',
      [1],
      [{ repo: 'nope', number: 1 }],
      [{ repo: C, number: 0 }],
      [{ repo: C, number: '1' }],
      [null],
    ]) {
      const r = await post('/api/review/trigger', { prs });
      assert.strictEqual(r.status, 400, JSON.stringify(prs));
    }
    for (const body of [[], null, 7, 'x{']) {
      const r = await post('/api/review/trigger', body);
      assert.strictEqual(r.status, 400, JSON.stringify(body));
    }
    assert.strictEqual(reviewCalls.length, before);
    assert.strictEqual(
      (await call('GET', '/api/review/status')).body.running,
      false
    );
  });
}

async function numberCases() {
  const trigger = (body) => post('/api/review/trigger', body);

  await test('prNumbers are resolved before the lock and reviewed as refs', async () => {
    const before = reviewCalls.length;
    const r = await trigger({ prNumbers: [11, 5] });
    assert.strictEqual(r.status, 202, JSON.stringify(r.body));
    assert.deepStrictEqual(r.body.prs, [ref(C, 11), ref(A, 5)]);
    assert.deepStrictEqual(reviewCalls[before].prs, [ref(C, 11), ref(A, 5)]);
    assert.ok(!('prNumbers' in reviewCalls[before]));
    await tick();
  });

  await test('a collision is a 422 ambiguous with the lookup results, and starts nothing', async () => {
    const before = reviewCalls.length;
    const r = await trigger({ prNumbers: [11, 21] });
    assert.strictEqual(r.status, 422);
    assert.strictEqual(r.body.success, false);
    assert.strictEqual(r.body.code, 'ambiguous');
    assert.deepStrictEqual(
      r.body.results.map((x) => [x.number, x.resolution]),
      [
        [11, 'unique'],
        [21, 'ambiguous'],
      ]
    );
    assert.strictEqual(r.body.results[1].matches.length, 2);
    assert.ok(r.body.message.includes('carbon-ai-chat#21'), r.body.message);
    assert.strictEqual(reviewCalls.length, before);
    assert.strictEqual(
      (await call('GET', '/api/review/status')).body.running,
      false
    );
  });

  await test('a number in no repo is a 422 not-found', async () => {
    const r = await trigger({ prNumbers: [99] });
    assert.strictEqual(r.status, 422);
    assert.strictEqual(r.body.code, 'not-found');
    assert.strictEqual(r.body.results[0].resolution, 'not-found');
    // The same words reviewPRs uses for a bare number it cannot place.
    assert.strictEqual(r.body.message, `PR #99 was not found in ${C} or ${A}.`);
  });

  await test('a 422 is reported ahead of a 409: numbers are resolved before the lock is read', async () => {
    startHold();
    await trigger({ prs: [ref(C, 1)] });
    const r = await trigger({ prNumbers: [99] });
    assert.strictEqual(r.status, 422);
    const busy = await trigger({ prNumbers: [11] });
    assert.strictEqual(busy.status, 409, 'a clean request meets the lock');
    await endHold();
  });

  await test('a GitHub 500 while resolving numbers is a 502 and starts nothing', async () => {
    const before = reviewCalls.length;
    const r = await trigger({ prNumbers: [500] });
    assert.strictEqual(r.status, 502);
    assert.strictEqual(reviewCalls.length, before);
  });

  await test('merged in one repo, open in the other: reviewed in the open repo, with a note', async () => {
    const before = reviewCalls.length;
    const r = await trigger({ prNumbers: [31] });
    assert.strictEqual(r.status, 202);
    assert.deepStrictEqual(r.body.prs, [ref(A, 31)]);
    assert.deepStrictEqual(reviewCalls[before].resolutionNotes, [
      {
        repo: A,
        number: 31,
        alternatives: [{ repo: C, state: 'closed', mergedAt: MERGED_AT }],
      },
    ]);
    await tick();
  });
}

async function capCases() {
  const trigger = (body) => post('/api/review/trigger', body);
  const notStarted = async (body, pattern) => {
    const before = reviewCalls.length;
    const lookupsBefore = lookups;
    const r = await trigger(body);
    assert.strictEqual(r.status, 400, JSON.stringify(r.body));
    assert.ok(pattern.test(r.body.error), r.body.error);
    assert.strictEqual(reviewCalls.length, before, 'no review started');
    assert.strictEqual(
      (await call('GET', '/api/review/status')).body.running,
      false
    );
    return lookups - lookupsBefore;
  };

  await test('with a cap of 2, four numbers that resolve to 2 + 2 refs are accepted', async () => {
    const before = reviewCalls.length;
    const r = await trigger({ prNumbers: [1, 2, 5, 6] });
    assert.strictEqual(r.status, 202, JSON.stringify(r.body));
    assert.deepStrictEqual(r.body.prs, [
      ref(C, 1),
      ref(C, 2),
      ref(A, 5),
      ref(A, 6),
    ]);
    assert.strictEqual(reviewCalls.length, before + 1);
    await tick();
  });

  await test('three numbers that all resolve to carbon are a 400 naming carbon, before any review', async () => {
    await notStarted(
      { prNumbers: [1, 2, 3] },
      /carbon: 3 requested|for carbon/
    );
  });

  await test('the same cap applies to prs, counted after deduplication', async () => {
    await notStarted({ prs: [ref(C, 1), ref(C, 2), ref(C, 3)] }, /for carbon/);
    const before = reviewCalls.length;
    const r = await trigger({ prs: [ref(C, 1), ref(C, 1), ref(C, 2)] });
    assert.strictEqual(r.status, 202);
    assert.deepStrictEqual(r.body.prs, [ref(C, 1), ref(C, 2)]);
    assert.strictEqual(reviewCalls.length, before + 1);
    await tick();
  });

  await test('more numbers than the aggregate cap is a 400 before any GitHub lookup', async () => {
    const lookupsMade = await notStarted(
      { prNumbers: [1, 2, 3, 5, 6] },
      /Too many PRs/
    );
    assert.strictEqual(lookupsMade, 0);
  });

  await test('a typed ref and a typed number that name one PR are reviewed once', async () => {
    const before = reviewCalls.length;
    const r = await trigger({ prs: [ref(C, 1)], prNumbers: [1, 5] });
    assert.strictEqual(r.status, 202, JSON.stringify(r.body));
    assert.deepStrictEqual(r.body.prs, [ref(C, 1), ref(A, 5)]);
    assert.deepStrictEqual(reviewCalls[before].prs, [ref(C, 1), ref(A, 5)]);
    await tick();
  });

  await test('refs plus resolved numbers are capped together', async () => {
    await notStarted(
      { prs: [ref(C, 1), ref(C, 2)], prNumbers: [3] },
      /for carbon/
    );
  });
}

async function noteCases() {
  const trigger = (body) => post('/api/review/trigger', body);
  const prs = [ref(A, 31), ref(C, 1)];
  const good = {
    repo: A,
    number: 31,
    alternatives: [{ repo: C, state: 'closed', mergedAt: MERGED_AT }],
  };
  const withAlt = (alt) => [{ ...good, alternatives: [alt] }];

  await test('valid notes are accepted and passed to reviewPRs as given', async () => {
    const before = reviewCalls.length;
    const notes = [
      good,
      {
        repo: C,
        number: 1,
        alternatives: [{ repo: A, state: 'closed', mergedAt: null }],
      },
    ];
    const r = await trigger({
      prs,
      resolutionNotes: notes.map((n) => ({ ...n, extra: 'ignored' })),
    });
    assert.strictEqual(r.status, 202, JSON.stringify(r.body));
    assert.deepStrictEqual(reviewCalls[before].resolutionNotes, notes);
    await tick();
  });

  await test('absent or null notes are fine', async () => {
    for (const resolutionNotes of [undefined, null, []]) {
      const r = await trigger({ prs, resolutionNotes });
      assert.strictEqual(r.status, 202);
      await tick();
    }
  });

  const malformed = {
    'not an array': { resolutionNotes: 'x' },
    'a note that is not an object': { resolutionNotes: [1] },
    'an unconfigured repo': { resolutionNotes: [{ ...good, repo: 'nope' }] },
    'a zero number': { resolutionNotes: [{ ...good, number: 0 }] },
    'a string number': { resolutionNotes: [{ ...good, number: '31' }] },
    'a ref that is not in prs': { resolutionNotes: [{ ...good, number: 32 }] },
    'two notes for one ref': { resolutionNotes: [good, good] },
    'no alternatives': { resolutionNotes: [{ ...good, alternatives: [] }] },
    'alternatives not an array': {
      resolutionNotes: [{ ...good, alternatives: 'x' }],
    },
    'an alternative that is not an object': {
      resolutionNotes: [{ ...good, alternatives: [null] }],
    },
    'an alternative in the chosen repo': {
      resolutionNotes: withAlt({ repo: A, state: 'closed', mergedAt: null }),
    },
    'an alternative in an unconfigured repo': {
      resolutionNotes: withAlt({
        repo: 'nope',
        state: 'closed',
        mergedAt: null,
      }),
    },
    'two alternatives in one repo': {
      resolutionNotes: [
        {
          ...good,
          alternatives: [
            { repo: C, state: 'closed', mergedAt: null },
            { repo: C, state: 'closed', mergedAt: null },
          ],
        },
      ],
    },
    'an open alternative': {
      resolutionNotes: withAlt({ repo: C, state: 'open', mergedAt: null }),
    },
    'a mergedAt that is not a timestamp': {
      resolutionNotes: withAlt({ repo: C, state: 'closed', mergedAt: 'ten' }),
    },
    'a mergedAt that is a number': {
      resolutionNotes: withAlt({ repo: C, state: 'closed', mergedAt: 5 }),
    },
    'a missing mergedAt': {
      resolutionNotes: withAlt({ repo: C, state: 'closed' }),
    },
  };
  for (const [name, extra] of Object.entries(malformed)) {
    await test(`resolutionNotes with ${name} is a 400 and starts nothing`, async () => {
      const before = reviewCalls.length;
      const r = await trigger({ prs, ...extra });
      assert.strictEqual(r.status, 400, JSON.stringify(r.body));
      assert.ok(/resolutionNotes/.test(r.body.error), r.body.error);
      assert.strictEqual(reviewCalls.length, before);
      assert.strictEqual(
        (await call('GET', '/api/review/status')).body.running,
        false
      );
    });
  }

  await test('notes sent with prNumbers only are refused: they name no chosen ref', async () => {
    const r = await trigger({ prNumbers: [31], resolutionNotes: [good] });
    assert.strictEqual(r.status, 400);
  });

  await test('a bad note is refused before the lock: it is a 400 even while a review runs', async () => {
    startHold();
    await trigger({ prs: [ref(C, 1)] });
    const r = await trigger({ prs, resolutionNotes: 'x' });
    assert.strictEqual(r.status, 400);
    await endHold();
  });
}

async function configAndLogCases() {
  await test('/api/config lists repos in batch order, keeps owner, drops repo, and maxPRs is per repo', async () => {
    const { body } = await call('GET', '/api/config');
    assert.deepStrictEqual(body.config.repos, [C, A]);
    assert.strictEqual(body.config.owner, 'carbon-design-system');
    assert.ok(!('repo' in body.config));
    assert.strictEqual(body.config.maxPRs, 2);
  });

  await test('/api/review/logs?repo= separates two reviews with the same number', async () => {
    const real = process.stdout.write;
    process.stdout.write = () => true;
    try {
      reviewLog.start('logs');
      await Promise.all([
        reviewLog.runWithContext({ worker: 1, repo: C, pr: 1204 }, async () => {
          process.stdout.write('from carbon\n');
        }),
        reviewLog.runWithContext({ worker: 2, repo: A, pr: 1204 }, async () => {
          process.stdout.write('from caic\n');
        }),
      ]);
    } finally {
      reviewLog.stop();
      process.stdout.write = real;
    }
    const texts = async (query) =>
      (await call('GET', `/api/review/logs?${query}`)).body.lines
        .map((l) => l.text)
        .sort();
    assert.deepStrictEqual(await texts('repo=carbon&pr=1204'), [
      '[agent 1 carbon#1204] from carbon',
    ]);
    assert.deepStrictEqual(await texts('repo=carbon-ai-chat&pr=1204'), [
      '[agent 2 carbon-ai-chat#1204] from caic',
    ]);
    assert.strictEqual((await texts('pr=1204')).length, 2, 'pr alone: both');
    assert.strictEqual((await texts('repo=carbon')).length, 1);
    assert.strictEqual((await texts('repo=carbon&pr=2')).length, 0);
  });
}

main();
