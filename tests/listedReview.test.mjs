// The console's "Review listed PRs" decisions and its health-tile spans, fed
// with what src/prResolver.js really returns. Plain Node: exits non-zero on failure.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  parsePrNumbers,
  planAfterLookup,
  planBeforeLookup,
  refsAfterChoice,
  targetPrText,
} from '../client/src/utils/listedReview.js';
import { healthTileSpans } from '../client/src/utils/tileSpans.js';

const require = createRequire(import.meta.url);
const { resolveNumbers } = require('../src/prResolver.js');

const repos = ['carbon', 'carbon-ai-chat'];
let failures = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL ${name}\n${err.stack}`);
  }
}

// A GitHub with `prs[repo][number] = { state, merged_at }`; anything else is 404.
function fakeClient(prs) {
  return {
    async fetchSinglePR({ repo, pullNumber }) {
      const pr = prs[repo]?.[pullNumber];
      if (!pr) throw Object.assign(new Error('Not Found'), { status: 404 });
      return {
        number: pullNumber,
        title: `${repo} ${pullNumber}`,
        user: { login: 'dev' },
        created_at: '2026-10-01T00:00:00Z',
        html_url: `https://github.com/o/${repo}/pull/${pullNumber}`,
        draft: false,
        merged_at: null,
        ...pr,
      };
    },
  };
}
const OPEN = { state: 'open' };
const MERGED = { state: 'closed', merged_at: '2019-01-01T00:00:00Z' };
const github = fakeClient({
  carbon: { 22971: OPEN, 1204: OPEN, 777: MERGED, 5: OPEN },
  'carbon-ai-chat': { 718: OPEN, 1204: OPEN, 777: OPEN, 6: OPEN },
});

// The click as Console.jsx runs it, with the lookup answered by the resolver.
async function click(field, { running = false, repoList = repos } = {}) {
  const parsed = parsePrNumbers(field, 40, repoList);
  assert.equal(parsed.error, null, parsed.error);
  const lookups = [];
  let plan = planBeforeLookup({
    running,
    entries: parsed.entries,
    numbers: parsed.numbers,
    repos: repoList,
  });
  if (plan.kind === 'resolve') {
    lookups.push(plan.numbers);
    const results = await resolveNumbers({
      client: github,
      owner: 'o',
      repos: repoList,
      numbers: plan.numbers,
    });
    plan = planAfterLookup({
      entries: parsed.entries,
      results,
      repos: repoList,
    });
  }
  return { plan, lookups, entries: parsed.entries };
}

const ref = (repo, number) => ({ repo, number });

await test('AC-1/A4: with one repository nothing is looked up and numbers go out as refs', async () => {
  const { plan, lookups } = await click('22971, 99999', {
    repoList: ['carbon'],
  });
  assert.deepEqual(lookups, []);
  assert.equal(plan.kind, 'trigger');
  assert.deepEqual(plan.request, {
    prs: [ref('carbon', 22971), ref('carbon', 99999)],
  });
});

await test('A5: a running review opens the busy dialog before any lookup', async () => {
  const { plan, lookups } = await click('22971', { running: true });
  assert.equal(plan.kind, 'busy');
  assert.deepEqual(lookups, []);
});

await test('the configuration not loaded yet starts nothing', () => {
  const plan = planBeforeLookup({
    running: false,
    entries: [ref(null, 1)],
    numbers: [1],
    repos: [],
  });
  assert.equal(plan.kind, 'not-loaded');
});

await test('AC-6: numbers found in one repository each start with no dialog', async () => {
  const { plan, lookups } = await click('22971, 718');
  assert.deepEqual(lookups, [[22971, 718]]);
  assert.equal(plan.kind, 'trigger');
  assert.deepEqual(plan.request.prs, [
    ref('carbon', 22971),
    ref('carbon-ai-chat', 718),
  ]);
  assert.deepEqual(plan.request.resolutionNotes, []);
});

await test('AC-7: a number open in both repositories asks, and nothing is sent yet', async () => {
  const { plan } = await click('22971, 1204, 718');
  assert.equal(plan.kind, 'collision');
  const { collision } = plan;
  assert.deepEqual(
    collision.groups.map((g) => [g.number, g.matches.map((m) => m.repo)]),
    [[1204, ['carbon', 'carbon-ai-chat']]]
  );
  assert.equal(collision.others, 2);
  assert.equal(collision.total, 3);
  // Confirming sends the choice with the resolved ones, in the order typed.
  assert.deepEqual(refsAfterChoice(collision, { 1204: 'carbon-ai-chat' }), [
    ref('carbon', 22971),
    ref('carbon-ai-chat', 1204),
    ref('carbon-ai-chat', 718),
  ]);
});

await test('AC-7: only true collisions are asked about; two give two groups', async () => {
  const { plan } = await click('1204, 777, 1204');
  // 777 is merged in carbon and open in caic, so only 1204 collides here.
  assert.equal(plan.kind, 'collision');
  assert.deepEqual(
    plan.collision.groups.map((g) => g.number),
    [1204]
  );
  const github2 = fakeClient({
    carbon: { 1: OPEN, 2: OPEN },
    'carbon-ai-chat': { 1: OPEN, 2: OPEN },
  });
  const results = await resolveNumbers({
    client: github2,
    owner: 'o',
    repos,
    numbers: [1, 2],
  });
  const p = planAfterLookup({
    entries: [ref(null, 1), ref(null, 2)],
    results,
    repos,
  });
  assert.equal(p.kind, 'collision');
  assert.deepEqual(
    p.collision.groups.map((g) => g.number),
    [1, 2]
  );
  assert.equal(p.collision.others, 0);
});

await test('AC-8: open in one repository and merged in the other picks the open one, with a note', async () => {
  const { plan } = await click('777');
  assert.equal(plan.kind, 'trigger');
  assert.deepEqual(plan.request.prs, [ref('carbon-ai-chat', 777)]);
  assert.deepEqual(plan.request.resolutionNotes, [
    {
      repo: 'carbon-ai-chat',
      number: 777,
      alternatives: [
        { repo: 'carbon', state: 'closed', mergedAt: '2019-01-01T00:00:00Z' },
      ],
    },
  ]);
});

await test('AC-9: a number found nowhere is named inline and nothing starts', async () => {
  const { plan } = await click('22971, 99999, 88888');
  assert.equal(plan.kind, 'not-found');
  assert.equal(
    plan.message,
    'No pull requests #99999 and #88888 in carbon or carbon-ai-chat.'
  );
  const one = await click('99999');
  assert.equal(
    one.plan.message,
    'No pull request #99999 in carbon or carbon-ai-chat.'
  );
});

await test('A6: typed refs skip the lookup; only bare numbers are looked up', async () => {
  const allRefs = await click('carbon#1204, carbon-ai-chat#1204');
  assert.deepEqual(allRefs.lookups, []);
  assert.deepEqual(allRefs.plan.request.prs, [
    ref('carbon', 1204),
    ref('carbon-ai-chat', 1204),
  ]);
  const mixed = await click('carbon-ai-chat#718, 22971');
  assert.deepEqual(mixed.lookups, [[22971]]);
  assert.deepEqual(mixed.plan.request.prs, [
    ref('carbon-ai-chat', 718),
    ref('carbon', 22971),
  ]);
});

// A bare number is looked up even when a ref for the same number was typed:
// the operator may mean the other repository's PR, and a silent guess could
// post on the wrong one. A choice that lands on the typed ref is sent once.
await test('A6/A15: "1204, carbon-ai-chat#1204" asks about 1204 and dedupes the answer', async () => {
  const { plan, lookups } = await click('1204, carbon-ai-chat#1204');
  assert.deepEqual(lookups, [[1204]]);
  assert.equal(plan.kind, 'collision');
  assert.equal(plan.collision.total, 2);
  assert.deepEqual(refsAfterChoice(plan.collision, { 1204: 'carbon' }), [
    ref('carbon', 1204),
    ref('carbon-ai-chat', 1204),
  ]);
  assert.deepEqual(
    refsAfterChoice(plan.collision, { 1204: 'carbon-ai-chat' }),
    [ref('carbon-ai-chat', 1204)]
  );
});

await test('parsePrNumbers: refs, case, unknown repo, duplicates, cap', () => {
  const p = parsePrNumbers(' 5, Carbon-AI-Chat#6 ,5 ', 40, repos);
  assert.equal(p.error, null);
  assert.deepEqual(p.numbers, [5]);
  assert.deepEqual(p.refs, [ref('carbon-ai-chat', 6)]);
  assert.equal(p.duplicatesDropped, 1);
  assert.match(
    parsePrNumbers('other#5', 40, repos).error,
    /not configured\. The configured repositories are carbon and carbon-ai-chat\./
  );
  assert.match(parsePrNumbers('5,,6', 40, repos).error, /single comma/);
  for (const bad of ['0', '-1', '1.5', 'abc', '#5', 'a/b#5']) {
    assert.match(
      parsePrNumbers(bad, 40, repos).error,
      /is not a pull request number/,
      bad
    );
  }
  // The client cap is per repository times the repositories, counting both kinds.
  assert.equal(parsePrNumbers('1, carbon#2', 2, repos).error, null);
  assert.equal(
    parsePrNumbers('1, carbon#2, 3', 2, repos).error,
    'Up to 2 pull requests per run; 3 given.'
  );
  assert.deepEqual(parsePrNumbers('   ', 2, repos).entries, []);
  // Before /api/config answers, a named repo is not checked.
  assert.deepEqual(parsePrNumbers('x#1', null, []).refs, [ref('x', 1)]);
});

await test('targetPrText shows GITHUB_AI_AGENT_PR_NUMBER as configured', () => {
  assert.equal(targetPrText('1204'), 'PR #1204');
  assert.equal(targetPrText(1204), 'PR #1204');
  assert.equal(targetPrText('carbon-ai-chat#1204'), 'carbon-ai-chat#1204');
});

await test('health tiles fill whole rows at lg, md and sm', () => {
  for (const count of [3, 4, 5, 6]) {
    const spans = Array.from({ length: count }, (_, i) =>
      healthTileSpans(i, count)
    );
    const sum = (k) => spans.reduce((a, s) => a + s[k], 0);
    assert.equal(sum('lg'), 16, `lg, ${count} tiles: one full row`);
    assert.ok(
      spans.every((s) => Math.abs(s.lg - spans[0].lg) <= 1),
      `lg, ${count} tiles: widths within one column`
    );
    assert.equal(sum('md') % 8, 0, `md, ${count} tiles: whole rows`);
    assert.ok(
      spans.every((s) => s.sm === 4),
      `sm, ${count} tiles: stacked`
    );
  }
  assert.deepEqual(
    Array.from({ length: 5 }, (_, i) => healthTileSpans(i, 5).lg),
    [4, 3, 3, 3, 3]
  );
  assert.deepEqual(
    Array.from({ length: 5 }, (_, i) => healthTileSpans(i, 5).md),
    [4, 4, 4, 4, 8]
  );
});

if (failures) {
  console.error(`\n${failures} failed`);
  process.exit(1);
}
console.log('\nall passed');
