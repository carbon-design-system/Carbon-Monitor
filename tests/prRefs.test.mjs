// Client PR-ref helpers. Plain Node, no test runner: exits non-zero on failure.
import assert from 'node:assert/strict';
import {
  PR_REF_RE,
  buildRefs,
  groupByRepo,
  joinList,
  keyOf,
  relativeTime,
  resolutionNotesFor,
  stateSuffix,
  tagTypeFor,
} from '../client/src/utils/prRefs.js';

const repos = ['carbon', 'carbon-ai-chat'];
let failures = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL ${name}\n${err.stack}`);
  }
}

test('keyOf joins repo and number', () => {
  assert.equal(
    keyOf({ repo: 'carbon-ai-chat', number: 1204 }),
    'carbon-ai-chat#1204'
  );
});

test('keyOf tells two repos with the same number apart', () => {
  assert.notEqual(
    keyOf({ repo: 'carbon', number: 1204 }),
    keyOf({ repo: 'carbon-ai-chat', number: 1204 })
  );
});

test('groupByRepo follows the configured order, not the input order', () => {
  const refs = [
    { repo: 'carbon-ai-chat', number: 718 },
    { repo: 'carbon', number: 22971 },
    { repo: 'carbon-ai-chat', number: 1204 },
    { repo: 'carbon', number: 22972 },
  ];
  assert.deepEqual(groupByRepo(refs, repos), [
    { repo: 'carbon', numbers: [22971, 22972] },
    { repo: 'carbon-ai-chat', numbers: [718, 1204] },
  ]);
});

test('groupByRepo drops repos with no refs', () => {
  assert.deepEqual(
    groupByRepo([{ repo: 'carbon-ai-chat', number: 1 }], repos),
    [{ repo: 'carbon-ai-chat', numbers: [1] }]
  );
});

test('groupByRepo keeps a ref whose repo is no longer configured, last', () => {
  assert.deepEqual(
    groupByRepo(
      [
        { repo: 'gone', number: 5 },
        { repo: 'carbon', number: 6 },
      ],
      repos
    ),
    [
      { repo: 'carbon', numbers: [6] },
      { repo: 'gone', numbers: [5] },
    ]
  );
});

test('groupByRepo copes with no refs and no repos', () => {
  assert.deepEqual(groupByRepo([], repos), []);
  assert.deepEqual(groupByRepo(null, repos), []);
  assert.deepEqual(groupByRepo([{ repo: 'carbon', number: 1 }]), [
    { repo: 'carbon', numbers: [1] },
  ]);
});

test('tagTypeFor cycles blue, purple, teal, cyan, magenta by position', () => {
  const six = ['a', 'b', 'c', 'd', 'e', 'f'];
  assert.deepEqual(
    six.map((r) => tagTypeFor(r, six)),
    ['blue', 'purple', 'teal', 'cyan', 'magenta', 'blue']
  );
});

test('tagTypeFor is stable for a repo and gray for an unknown one', () => {
  assert.equal(tagTypeFor('carbon', repos), 'blue');
  assert.equal(tagTypeFor('carbon-ai-chat', repos), 'purple');
  assert.equal(tagTypeFor('other', repos), 'gray');
  assert.equal(tagTypeFor('carbon'), 'gray');
});

test('joinList', () => {
  assert.equal(joinList([]), '');
  assert.equal(joinList(['a']), 'a');
  assert.equal(joinList(['a', 'b']), 'a and b');
  assert.equal(joinList(['a', 'b', 'c']), 'a, b and c');
  assert.equal(joinList(['a', 'b'], 'or'), 'a or b');
});

test('PR_REF_RE accepts a number or repo#number only', () => {
  const m = PR_REF_RE.exec('carbon-ai-chat#1204');
  assert.equal(m[1], 'carbon-ai-chat');
  assert.equal(m[2], '1204');
  assert.equal(PR_REF_RE.exec('1204')[1], undefined);
  for (const bad of [
    '',
    '#12',
    'carbon#',
    'carbon#1.5',
    '-3',
    '1204 ',
    'a b#3',
  ]) {
    assert.equal(PR_REF_RE.test(bad), false, bad);
  }
});

test('stateSuffix reads mergedAt, not state alone', () => {
  assert.equal(stateSuffix({ state: 'open', mergedAt: null }), '');
  assert.equal(
    stateSuffix({ state: 'closed', mergedAt: '2019-01-01T00:00:00Z' }),
    ' · merged'
  );
  assert.equal(stateSuffix({ state: 'closed', mergedAt: null }), ' · closed');
  assert.equal(stateSuffix({ state: 'closed' }), ' · closed');
});

test('relativeTime', () => {
  const now = Date.parse('2026-11-04T12:00:00Z');
  assert.equal(relativeTime('2026-11-01T12:00:00Z', now), '3 days ago');
  assert.equal(relativeTime('2026-11-03T12:00:00Z', now), 'yesterday');
  assert.equal(relativeTime('2026-11-04T09:00:00Z', now), '3 hours ago');
  assert.equal(relativeTime('2024-11-04T12:00:00Z', now), '2 years ago');
  assert.equal(relativeTime('not a date', now), '');
});

const match = (repo, number, state, mergedAt = null) => ({
  repo,
  number,
  state,
  mergedAt,
});

test('resolutionNotesFor notes only-open results, with the closed alternatives', () => {
  const results = [
    {
      number: 1204,
      resolution: 'only-open',
      choice: { repo: 'carbon-ai-chat', number: 1204 },
      matches: [
        match('carbon', 1204, 'closed', '2019-01-01T00:00:00Z'),
        match('carbon-ai-chat', 1204, 'open'),
      ],
    },
    {
      number: 5,
      resolution: 'unique',
      choice: { repo: 'carbon', number: 5 },
      matches: [match('carbon', 5, 'open')],
    },
    {
      number: 9,
      resolution: 'ambiguous',
      choice: null,
      matches: [match('carbon', 9, 'open'), match('carbon-ai-chat', 9, 'open')],
    },
  ];
  assert.deepEqual(resolutionNotesFor(results), [
    {
      repo: 'carbon-ai-chat',
      number: 1204,
      alternatives: [
        { repo: 'carbon', state: 'closed', mergedAt: '2019-01-01T00:00:00Z' },
      ],
    },
  ]);
});

test('resolutionNotesFor sends null mergedAt for an unmerged closed PR', () => {
  const [note] = resolutionNotesFor([
    {
      number: 7,
      resolution: 'only-open',
      choice: { repo: 'carbon', number: 7 },
      matches: [
        match('carbon', 7, 'open'),
        match('carbon-ai-chat', 7, 'closed'),
      ],
    },
  ]);
  assert.deepEqual(note.alternatives, [
    { repo: 'carbon-ai-chat', state: 'closed', mergedAt: null },
  ]);
});

test('buildRefs keeps typed order and takes choices from results or the dialog', () => {
  const entries = [
    { repo: null, number: 718 },
    { repo: 'carbon', number: 22971 },
    { repo: null, number: 1204 },
  ];
  const results = [
    { number: 718, choice: { repo: 'carbon-ai-chat', number: 718 } },
    { number: 1204, choice: null },
  ];
  assert.deepEqual(buildRefs(entries, results, { 1204: 'carbon' }), [
    { repo: 'carbon-ai-chat', number: 718 },
    { repo: 'carbon', number: 22971 },
    { repo: 'carbon', number: 1204 },
  ]);
});

test('buildRefs drops an entry with no repo and dedupes by key', () => {
  const entries = [
    { repo: null, number: 1204 },
    { repo: 'carbon-ai-chat', number: 1204 },
    { repo: null, number: 99 },
  ];
  const results = [
    { number: 1204, choice: { repo: 'carbon-ai-chat', number: 1204 } },
    { number: 99, choice: null },
  ];
  assert.deepEqual(buildRefs(entries, results), [
    { repo: 'carbon-ai-chat', number: 1204 },
  ]);
});

if (failures) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log('\nAll prRefs tests passed');
