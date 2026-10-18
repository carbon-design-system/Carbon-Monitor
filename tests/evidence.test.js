/**
 * Skill evidence passed to the parser, and the call sites that pass it.
 */

'use strict';

const fs = require('fs');
const path = require('path');
// index.js reads the PR target from the environment when it loads.
delete process.env.GITHUB_AI_AGENT_PR_NUMBER;

const { parseReviewOutput } = require('../src/reviewParser');
const { summarizeToolCalls } = require('../src/agentRunner');
const {
  resolveSpend,
  tokensFromStats,
  reviewTextFor,
  skillReadsFor,
  addSpend,
} = require('../src/index');

let passed = 0;
let failed = 0;

function test(description, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${description}`);
  } catch (err) {
    failed++;
    console.log(`  ❌ ${description}`);
    console.log(`     ${err.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const review = {
  summaryMarkdown: 'One Carbon Button finding.',
  findings: [
    {
      severity: 'major',
      file: 'packages/react/src/components/Button/Button.js',
      line: 12,
      title: 'Carbon Button icon-only variant needs iconDescription',
      body: 'The Carbon Button used here is icon-only and has no iconDescription, so it has no accessible name for assistive technology.',
      carbonVerified: true,
      verificationSource: 'carbon-builder',
      mcpEvidence:
        'docs_search: Button with hasIconOnly requires the iconDescription prop',
    },
  ],
  recommendation: 'request-changes',
};
const fixtureText = [
  '## Step 1',
  'Button.js:12 — icon-only Button — Category 1 — pending',
  'BEGIN_REVIEW_JSON',
  JSON.stringify(review, null, 2),
  'END_REVIEW_JSON',
].join('\n');

console.log(
  '\n── parseReviewOutput skillReads ───────────────────────────────'
);

test('the carbon-builder finding survives when a skill invocation was observed', () => {
  const parsed = parseReviewOutput(fixtureText, {
    skillReads: ['use_skill:carbon-builder'],
  });
  assert(parsed, 'expected a parsed review');
  assert(
    parsed.findings.length === 1,
    `expected 1 finding, got ${parsed.findings.length}`
  );
});

test('the same finding is filtered when no skill evidence was observed', () => {
  const parsed = parseReviewOutput(fixtureText, { skillReads: [] });
  assert(parsed, 'expected a parsed review');
  assert(
    parsed.findings.length === 0,
    `expected the finding filtered, got ${parsed.findings.length}`
  );
});

test('without options the transcript regex still decides (no reads, filtered)', () => {
  const parsed = parseReviewOutput(fixtureText);
  assert(parsed && parsed.findings.length === 0, 'expected the old behaviour');
});

console.log(
  '\n── evidence, cost and token helpers ───────────────────────────'
);

function quietly(fn) {
  const log = console.log;
  const warn = console.warn;
  const lines = [];
  console.log = (...a) => lines.push(a.join(' '));
  console.warn = (...a) => lines.push(a.join(' '));
  try {
    return { value: fn(), lines };
  } finally {
    console.log = log;
    console.warn = warn;
  }
}

test('a use_skill call is the skill evidence for a stream-json run', () => {
  const run = {
    format: 'stream-json',
    toolCalls: [
      { name: 'use_skill', params: { skill_name: 'carbon-builder' } },
    ],
  };
  const reads = skillReadsFor(run, '', summarizeToolCalls(run.toolCalls));
  assert(reads.length === 1 && reads[0] === 'use_skill:carbon-builder');
});

test('a stream-json run with no skill evidence anywhere yields none', () => {
  const run = { format: 'stream-json', toolCalls: [] };
  const { value, lines } = quietly(() =>
    skillReadsFor(run, 'plain text', summarizeToolCalls([]))
  );
  assert(value.length === 0 && lines.length === 0);
});

test('an unrecognised tool-call shape is caught by the raw fallback, with a warning', () => {
  const run = {
    format: 'stream-json',
    toolCalls: [
      {
        name: 'read_file',
        params: { target: '.bob/skills/carbon-builder/SKILL.md' },
      },
    ],
  };
  const raw = quietly(() =>
    skillReadsFor(run, '', summarizeToolCalls(run.toolCalls))
  );
  assert(raw.value.length === 0, 'no recognised path key, so no raw match');

  const odd = {
    format: 'stream-json',
    toolCalls: [{ name: 'use_skill', params: { name: 'carbon-builder' } }],
  };
  const hit = quietly(() =>
    skillReadsFor(odd, '', summarizeToolCalls(odd.toolCalls))
  );
  assert(hit.value[0] === 'use_skill:carbon-builder', 'raw use_skill match');
  assert(hit.lines.length === 1 && /not from tool events/.test(hit.lines[0]));
});

test('the text fallback finds skill reads in a stream-json run, with a warning', () => {
  const run = { format: 'stream-json', toolCalls: [] };
  const text = '[using tool read_file: .bob/skills/carbon-builder/SKILL.md]';
  const hit = quietly(() => skillReadsFor(run, text, summarizeToolCalls([])));
  assert(hit.value.length === 1);
  assert(hit.lines.length === 1 && /not from tool events/.test(hit.lines[0]));
});

test('a run without events falls back to the transcript regex', () => {
  const run = { format: 'pretty', toolCalls: [] };
  const text = '[using tool read_file: .bob/skills/carbon-builder/SKILL.md]';
  assert(skillReadsFor(run, text, summarizeToolCalls([])).length === 1);
});

test('lastMessage is appended when only it carries the marker', () => {
  const withMarker = {
    text: 'SKIP a.js — fixture',
    lastMessage: fixtureText,
  };
  const text = reviewTextFor(withMarker);
  assert(text.includes('SKIP a.js') && text.includes('BEGIN_REVIEW_JSON'));
  const parsed = parseReviewOutput(text, {
    skillReads: ['use_skill:carbon-builder'],
  });
  assert(parsed && parsed.hasCatalogue, 'earlier catalogue must survive');
  const plain = { text: fixtureText, lastMessage: 'done' };
  assert(reviewTextFor(plain) === fixtureText);
  assert(reviewTextFor({ text: 'x', lastMessage: null }) === 'x');
});

test('the retry source follows the runs that reported a spend', () => {
  const bob = (n) => ({ coinsSpent: n, source: 'bob-result' });
  const delta = (n) => ({ coinsSpent: n, source: 'balance-delta' });
  const none = { coinsSpent: null, source: 'unknown' };

  const retryOnly = addSpend(none, bob(0.5));
  assert(retryOnly.coinsSpent === 0.5 && retryOnly.source === 'bob-result');

  const both = addSpend(bob(0.1), bob(0.2));
  assert(both.coinsSpent === 0.3 && both.source === 'bob-result');

  const mixed = addSpend(bob(0.1), delta(0.2));
  assert(mixed.source === 'balance-delta');

  const firstOnly = addSpend(bob(0.1), none);
  assert(firstOnly.coinsSpent === 0.1 && firstOnly.source === 'bob-result');
});

test('cost comes from the result record, else the balance delta', () => {
  const quiet = (args) => quietly(() => resolveSpend(args));
  const result = quiet({
    stats: { session_costs: 0.42 },
    delta: 0.415,
    tracked: true,
  });
  assert(
    result.value.coinsSpent === 0.42 && result.value.source === 'bob-result'
  );
  assert(result.lines.length === 1 && !/mismatch/.test(result.lines[0]));

  const mismatch = quiet({
    stats: { session_costs: 0.42 },
    delta: 1,
    tracked: true,
  });
  assert(mismatch.lines.length === 1);
  assert(
    mismatch.lines[0].includes('result=0.42 delta=1 (mismatch)'),
    mismatch.lines[0]
  );

  const delta = quiet({ stats: null, delta: 0.5, tracked: true });
  assert(
    delta.value.coinsSpent === 0.5 && delta.value.source === 'balance-delta'
  );

  const none = quiet({ stats: null, delta: null, tracked: false });
  assert(
    none.value.coinsSpent === null && none.value.ledgerSource === 'unknown'
  );
});

test('tokens come from stats only when input and output are numbers', () => {
  const t = tokensFromStats({
    input_tokens: 10,
    output_tokens: 5,
    total_tokens: 15,
    cache_read_tokens: 3,
  });
  assert(t.source === 'bob' && t.total === 15 && t.cacheRead === 3);
  assert(t.cacheWrite === null);
  assert(tokensFromStats(null) === null);
  assert(tokensFromStats({ total_tokens: 9 }) === null);
});

console.log(
  '\n── index.js call sites ────────────────────────────────────────'
);

const source = fs.readFileSync(
  path.resolve(__dirname, '../src/index.js'),
  'utf8'
);
const calls = [...source.matchAll(/parseReviewOutput\(/g)];

test('index.js has the first-run and retry parse sites', () => {
  assert(calls.length === 2, `expected 2 call sites, found ${calls.length}`);
});

test('every parseReviewOutput call passes a skillReads option', () => {
  for (const call of calls) {
    const args = source.slice(call.index, call.index + 160);
    assert(/skillReads/.test(args), `call without skillReads: ${args}`);
  }
});

test('the retry parse uses the retry run, not the first run', () => {
  assert(
    /parseReviewOutput\(retryOutput,\s*\{\s*skillReads: retrySkillReads/.test(
      source
    ),
    'retry parse should pass the retry run evidence'
  );
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
