'use strict';
// tests/caicSummary.test.js — AC-10, AC-11
//
// AC-10: caic review with no Cat 1 finding → summary starts "[AI agent review - CAIC]"
//        and has no "Carbon verification:" line.
// AC-11: caic review with a Cat 1 finding → "Carbon verification:" line IS present.

const assert = require('assert');
const {
  formatSummaryComment,
  formatLooksGoodComment,
} = require('../src/reviewPrompt');
const profiles = require('../src/profiles');

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

// Minimal stub review objects
function reviewWithNoFindings() {
  return { findings: [] };
}

function reviewWithCat1Finding() {
  return {
    findings: [
      {
        severity: 'major',
        carbonVerified: true,
        verificationSource: 'carbon-builder',
        title: 'wrong attribute',
      },
    ],
  };
}

function reviewWithOnlyCat2Findings() {
  return {
    findings: [
      {
        severity: 'blocking',
        carbonVerified: false,
        verificationSource: 'not-carbon-specific',
        title: 'hardcoded cds--',
      },
    ],
  };
}

const CAIC_HEADER = 'AI agent review - CAIC';
const CORE_HEADER = 'AI agent review \u2014 Carbon grounded';
const VERIFICATION_LINE = 'Carbon verification:';

// Shared summary args
function makeSummaryArgs(overrides = {}) {
  return {
    agent: 'bob',
    agentName: 'IBM Bob',
    summaryMarkdown: 'This PR adds a new Lit component.',
    prNumber: 42,
    commitSha: 'abc1234',
    recommendation: 'suggested-improvements',
    recommendationRationale: 'One major finding.',
    ...overrides,
  };
}

// ── AC-10: no Cat 1 → no Carbon verification line ────────────────────────────
console.log(
  '\n── AC-10: caic no Cat 1 → header is CAIC, no Carbon verification ────'
);

test('formatSummaryComment with caic headerLabel starts [AI agent review - CAIC]', () => {
  const comment = formatSummaryComment({
    ...makeSummaryArgs(),
    headerLabel: CAIC_HEADER,
    showCarbonVerification: false,
  });
  assert.ok(
    comment.startsWith(`[${CAIC_HEADER}]`),
    `Expected start "[${CAIC_HEADER}]", got: ${comment.slice(0, 60)}`
  );
});

test('formatSummaryComment with showCarbonVerification=false has no Carbon verification line', () => {
  const comment = formatSummaryComment({
    ...makeSummaryArgs(),
    headerLabel: CAIC_HEADER,
    showCarbonVerification: false,
  });
  assert.ok(
    !comment.includes(VERIFICATION_LINE),
    'Should not contain "Carbon verification:" when showCarbonVerification=false'
  );
});

test('profile.showCarbonVerification(reviewWithNoFindings()) returns false', () => {
  const profile = profiles.forRepo('carbon-ai-chat');
  const result = profile.showCarbonVerification(reviewWithNoFindings());
  assert.strictEqual(result, false);
});

test('profile.showCarbonVerification(reviewWithOnlyCat2Findings()) returns false', () => {
  const profile = profiles.forRepo('carbon-ai-chat');
  const result = profile.showCarbonVerification(reviewWithOnlyCat2Findings());
  assert.strictEqual(result, false);
});

// ── AC-11: Cat 1 finding → Carbon verification line present ──────────────────
console.log(
  '\n── AC-11: caic with Cat 1 → Carbon verification line is present ─────'
);

test('formatSummaryComment with showCarbonVerification=true has Carbon verification line', () => {
  const comment = formatSummaryComment({
    ...makeSummaryArgs(),
    headerLabel: CAIC_HEADER,
    showCarbonVerification: true,
  });
  assert.ok(
    comment.includes(VERIFICATION_LINE),
    'Should contain "Carbon verification:" when showCarbonVerification=true'
  );
});

test('profile.showCarbonVerification(reviewWithCat1Finding()) returns true', () => {
  const profile = profiles.forRepo('carbon-ai-chat');
  const result = profile.showCarbonVerification(reviewWithCat1Finding());
  assert.strictEqual(result, true);
});

// ── AC-4 guard: core path byte-identical ─────────────────────────────────────
console.log(
  '\n── AC-4 guard: core formatSummaryComment is unchanged ────────────────'
);

test('core formatSummaryComment (no headerLabel) still starts [AI agent review \u2014 Carbon grounded]', () => {
  const comment = formatSummaryComment(makeSummaryArgs());
  assert.ok(
    comment.startsWith(`[${CORE_HEADER}]`),
    `Expected core header, got: ${comment.slice(0, 80)}`
  );
});

test('core formatSummaryComment (no showCarbonVerification override) includes Carbon verification line', () => {
  const comment = formatSummaryComment(makeSummaryArgs());
  assert.ok(
    comment.includes(VERIFICATION_LINE),
    'Core summary should always include "Carbon verification:" by default'
  );
});

test('formatLooksGoodComment with caic headerLabel starts [AI agent review - CAIC]', () => {
  const comment = formatLooksGoodComment({
    agent: 'bob',
    agentName: 'IBM Bob',
    summaryMarkdown: 'Clean PR.',
    commitSha: 'abc1234',
    headerLabel: CAIC_HEADER,
  });
  assert.ok(
    comment.startsWith(`[${CAIC_HEADER}]`),
    `Expected caic header in looks-good comment`
  );
});

// ── Not verified: one optional sentence, layout unchanged ────────────────────
console.log(
  '\n── Not verified: the summary layout does not change ─────────────────'
);

const NOT_VERIFIED = 'Not verified: the retry branch of the upload queue.';
const BASE_SUMMARY = 'This PR adds a new Lit component.';
const NIT = {
  severity: 'nit',
  title: 'Rename the story',
  file: 'src/a.stories.js',
  line: 40,
};

function headingsOf(comment) {
  return comment.split('\n').filter((l) => /^(#{1,3} |<summary>)/.test(l));
}

test('a summary given without Not verified has no such sentence', () => {
  const comment = formatSummaryComment({
    ...makeSummaryArgs({ summaryMarkdown: BASE_SUMMARY }),
    headerLabel: CAIC_HEADER,
    showCarbonVerification: false,
  });
  assert.ok(!comment.includes('Not verified'));
});

test('the Not verified sentence appears once, in the Summary section, and nothing else moves', () => {
  const args = {
    ...makeSummaryArgs({ summaryMarkdown: BASE_SUMMARY }),
    headerLabel: CAIC_HEADER,
    showCarbonVerification: false,
    nitFindings: [NIT],
  };
  const without = formatSummaryComment(args);
  const withIt = formatSummaryComment({
    ...args,
    summaryMarkdown: `${BASE_SUMMARY} ${NOT_VERIFIED}`,
  });
  assert.strictEqual(withIt.split(NOT_VERIFIED).length, 2, 'exactly once');
  assert.strictEqual(
    withIt.replace(` ${NOT_VERIFIED}`, ''),
    without,
    'the only difference is the sentence'
  );
  assert.ok(
    withIt.indexOf('## Summary') < withIt.indexOf(NOT_VERIFIED) &&
      withIt.indexOf(NOT_VERIFIED) < withIt.indexOf('optional nit'),
    'after the Summary heading, before the nit list'
  );
  assert.deepStrictEqual(headingsOf(withIt), headingsOf(without));
});

test('the Looks Good comment takes the sentence the same way', () => {
  const args = {
    agent: 'bob',
    agentName: 'IBM Bob',
    summaryMarkdown: 'Clean PR.',
    commitSha: 'abc1234',
    headerLabel: CAIC_HEADER,
    nitFindings: [NIT],
  };
  const without = formatLooksGoodComment(args);
  const withIt = formatLooksGoodComment({
    ...args,
    summaryMarkdown: `Clean PR. ${NOT_VERIFIED}`,
  });
  assert.ok(!without.includes('Not verified'));
  assert.strictEqual(withIt.replace(` ${NOT_VERIFIED}`, ''), without);
});

test('nits stay collapsed and out of the findings table for the caic header', () => {
  const comment = formatSummaryComment({
    ...makeSummaryArgs({ summaryMarkdown: BASE_SUMMARY }),
    headerLabel: CAIC_HEADER,
    showCarbonVerification: false,
    findingsTable: [
      {
        area: 'General',
        category: 'Cat 2',
        severity: 'nit',
        title: 'Rename the story',
        file: 'src/a.stories.js',
      },
    ],
    nitFindings: [NIT],
  });
  assert.ok(!comment.includes('Findings ('), 'a nit is not a table row');
  assert.ok(comment.includes('<summary>1 optional nit</summary>'));
  assert.ok(
    comment.includes('- Rename the story \u2014 `src/a.stories.js:40`')
  );
});

test('a caic finding with a fix gets the Suggested fix item in the SPEC', () => {
  const comment = formatSummaryComment({
    ...makeSummaryArgs({ summaryMarkdown: BASE_SUMMARY }),
    owner: 'carbon-design-system',
    repo: 'carbon-ai-chat',
    headerLabel: CAIC_HEADER,
    showCarbonVerification: false,
    recommendation: 'consider-revising',
    inlineFindings: [
      {
        severity: 'blocking',
        file: 'packages/ai-chat/src/a.ts',
        line: 12,
        title: 'Listener leaks',
        body: '**Context:** the guard skips teardown. Call `dispose()` first.',
        carbonVerified: false,
        verificationSource: 'not-carbon-specific',
        fix: ['  this.dispose();', '  return;'],
      },
    ],
  });
  assert.ok(
    comment.includes(
      '- Suggested fix (at line 12):\n\n        this.dispose();\n        return;\n'
    )
  );
});

// ── summary ───────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}  Failed: ${failed}`);
if (failed > 0) process.exit(1);
