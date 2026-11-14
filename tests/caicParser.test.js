'use strict';
// tests/caicParser.test.js — AC-12, AC-13
//
// AC-12: Given a caic finding with verificationSource: 'not-carbon-specific',
//        when filtered, it is kept. And a Carbon-specific finding with no MCP
//        evidence is still dropped.
// AC-13: Given a caic-style output with no catalogue line, the review is
//        unreliable and the recommendation is 'suggested-improvements'.

const assert = require('assert');
const { parseReviewOutput } = require('../src/reviewParser');

// ── helpers ───────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function test(label, fn) {
  try {
    fn();
    console.log(`  ✅ ${label}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ ${label}`);
    console.error(`     ${err.message}`);
    failed++;
  }
}

// Build a minimal agent output containing a JSON block. The catalogue line is
// optional so we can test both with and without it.
function makeAgentOutput({ hasCatalogue = true, findings = [] } = {}) {
  const catalogueLine = hasCatalogue
    ? 'NO-FINDINGS packages/ai-chat/src/foo.ts — no issues found\n'
    : '';
  const json = JSON.stringify({
    summaryMarkdown: 'This PR adds a new component.',
    findings,
    findingsTable: findings.map((f) => ({
      area: f.carbonVerified ? 'Carbon API' : 'General',
      category: f.carbonVerified ? 'Cat 1' : 'Cat 2',
      severity: f.severity,
      title: f.title,
      file: f.file || 'foo.ts',
    })),
    shouldPostInlineComments: true,
  });

  return `${catalogueLine}BEGIN_REVIEW_JSON\n${json}\nEND_REVIEW_JSON`;
}

// ── AC-12: convention finding with not-carbon-specific is kept ────────────────
console.log(
  '\n── AC-12: not-carbon-specific finding passes the filter ─────────────'
);

test('caic "hardcoded cds--" finding with verificationSource not-carbon-specific is kept', () => {
  const conventionFinding = {
    severity: 'blocking',
    file: 'packages/ai-chat/src/foo.scss',
    line: 10,
    title: 'hardcoded cds-- in SCSS',
    body: 'Replace with #{$prefix}-- to avoid breaking the es-custom build.',
    carbonVerified: false,
    verificationSource: 'not-carbon-specific',
  };

  const output = makeAgentOutput({ findings: [conventionFinding] });
  const review = parseReviewOutput(output, {
    skillReads: [],
    skillDir: '.bob/skills/carbon-builder/',
    readTool: 'read_file',
  });

  assert.ok(review, 'parseReviewOutput must return a result');
  assert.strictEqual(
    review.findings.length,
    1,
    'Convention finding must not be filtered'
  );
  assert.strictEqual(review.findings[0].title, conventionFinding.title);
  assert.strictEqual(
    review.findings[0].verificationSource,
    'not-carbon-specific'
  );
});

test('Carbon-specific finding with no MCP evidence is still dropped (regression guard)', () => {
  const carbonFinding = {
    severity: 'major',
    file: 'packages/ai-chat/src/foo.ts',
    line: 5,
    title: 'wrong cds-button attribute',
    body: 'The attribute foo-bar does not exist on cds-button.',
    carbonVerified: true,
    verificationSource: 'carbon-builder',
    mcpEvidence: 'Verified via code_search', // vague — should be dropped
  };

  const output = makeAgentOutput({ findings: [carbonFinding] });
  const review = parseReviewOutput(output, {
    skillReads: [], // no skill reads → carbon-builder findings dropped
    skillDir: '.bob/skills/carbon-builder/',
    readTool: 'read_file',
  });

  assert.ok(review, 'parseReviewOutput must return a result');
  assert.strictEqual(
    review.findings.length,
    0,
    'Carbon-specific finding with no real MCP evidence should be filtered'
  );
});

test('both a convention finding and a filtered Carbon finding in same output — convention kept', () => {
  const conventionFinding = {
    severity: 'blocking',
    file: 'foo.scss',
    line: 3,
    title: 'hardcoded cds-- class',
    body: 'Use #{$prefix}-- instead.',
    carbonVerified: false,
    verificationSource: 'not-carbon-specific',
  };
  const carbonFinding = {
    severity: 'major',
    file: 'foo.ts',
    line: 1,
    title: 'carbon claim without evidence',
    body: 'Change something.',
    carbonVerified: true,
    verificationSource: 'carbon-builder',
    mcpEvidence: '',
  };

  const output = makeAgentOutput({
    findings: [conventionFinding, carbonFinding],
  });
  const review = parseReviewOutput(output, {
    skillReads: [],
    skillDir: '.bob/skills/carbon-builder/',
    readTool: 'read_file',
  });

  assert.ok(review);
  // Only the convention finding survives
  assert.strictEqual(review.findings.length, 1);
  assert.strictEqual(
    review.findings[0].verificationSource,
    'not-carbon-specific'
  );
});

// ── AC-13: no catalogue line → unreliable ─────────────────────────────────────
console.log(
  '\n── AC-13: no catalogue line → unreliable + suggested-improvements ──'
);

test('output with no catalogue line → hasCatalogue is false', () => {
  const output = makeAgentOutput({ hasCatalogue: false });
  const review = parseReviewOutput(output, {
    skillReads: [],
    skillDir: '.bob/skills/carbon-builder/',
    readTool: 'read_file',
  });
  assert.ok(review, 'parseReviewOutput must return a result');
  assert.strictEqual(
    review.hasCatalogue,
    false,
    'hasCatalogue must be false when no catalogue lines are present'
  );
});

test('output with no catalogue line → recommendation is suggested-improvements', () => {
  const output = makeAgentOutput({ hasCatalogue: false });
  const review = parseReviewOutput(output, {
    skillReads: [],
    skillDir: '.bob/skills/carbon-builder/',
    readTool: 'read_file',
  });
  assert.ok(review);
  assert.strictEqual(
    review.recommendation,
    'suggested-improvements',
    `Expected suggested-improvements, got: ${review.recommendation}`
  );
});

test('output WITH catalogue line → hasCatalogue is true', () => {
  const output = makeAgentOutput({ hasCatalogue: true });
  const review = parseReviewOutput(output, {
    skillReads: [],
    skillDir: '.bob/skills/carbon-builder/',
    readTool: 'read_file',
  });
  assert.ok(review);
  assert.strictEqual(review.hasCatalogue, true);
});

// ── Rubric wording needs no parser change ─────────────────────────────────────
console.log(
  '\n── Rubric: orientation body, Not verified, nits and minor parse as before ──'
);

const PARSE_OPTS = {
  skillReads: [],
  skillDir: '.bob/skills/carbon-builder/',
  readTool: 'read_file',
};

function convention(severity, title, body) {
  return {
    severity,
    file: 'packages/ai-chat/src/foo.ts',
    line: 12,
    title,
    body,
    carbonVerified: false,
    verificationSource: 'not-carbon-specific',
  };
}

const ORIENTED_BODY =
  '**Context:** this early return is the already-closed guard, and the listener it skips was registered above. The early return skips teardown, so the listener leaks on every close. Call `dispose()` before returning.';

test('a body in orientation, defect, cost, fix order reaches the review verbatim', () => {
  const output = makeAgentOutput({
    findings: [convention('blocking', 'Listener leaks', ORIENTED_BODY)],
  });
  const review = parseReviewOutput(output, PARSE_OPTS);
  assert.strictEqual(review.findings.length, 1);
  assert.strictEqual(review.findings[0].body, ORIENTED_BODY);
});

test('a summary ending in Not verified is kept verbatim', () => {
  const summary =
    'This PR adds a queue. Not verified: the retry branch of the upload queue.';
  const json = JSON.stringify({
    summaryMarkdown: summary,
    findings: [],
    findingsTable: [],
    shouldPostInlineComments: true,
  });
  const review = parseReviewOutput(
    `NO-FINDINGS foo.ts \u2014 fine\nBEGIN_REVIEW_JSON\n${json}\nEND_REVIEW_JSON`,
    PARSE_OPTS
  );
  assert.strictEqual(review.summaryMarkdown, summary);
});

test('a blocking finding keeps its fix lines for the SPEC', () => {
  const finding = convention('blocking', 'Listener leaks', ORIENTED_BODY);
  finding.fix = ['  this.dispose();', '  return;'];
  const review = parseReviewOutput(
    makeAgentOutput({ findings: [finding] }),
    PARSE_OPTS
  );
  assert.deepStrictEqual(review.findings[0].fix, [
    '  this.dispose();',
    '  return;',
  ]);
});

test('nits only is Looks Good; the nit is kept for the collapsed list', () => {
  const output = makeAgentOutput({
    findings: [convention('nit', 'Comment restates the code', 'Delete it.')],
  });
  const review = parseReviewOutput(output, PARSE_OPTS);
  assert.strictEqual(review.recommendation, 'looks-good');
  assert.strictEqual(review.findings[0].severity, 'nit');
});

test('a minor finding is accepted and asks for Suggested Improvements', () => {
  const output = makeAgentOutput({
    findings: [convention('minor', 'Fragile ordering', ORIENTED_BODY)],
  });
  const review = parseReviewOutput(output, PARSE_OPTS);
  assert.strictEqual(review.findings.length, 1);
  assert.strictEqual(review.recommendation, 'suggested-improvements');
});

// ── summary ───────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}  Failed: ${failed}`);
if (failed > 0) process.exit(1);
