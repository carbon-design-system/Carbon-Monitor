'use strict';
// tests/caicSummary.test.js — AC-10, AC-11
//
// AC-10: caic review with no Cat 1 finding → summary starts "[AI agent review - CAIC]"
//        and has no "Carbon verification:" line.
// AC-11: caic review with a Cat 1 finding → "Carbon verification:" line IS present.

const assert = require('assert');
const { formatSummaryComment, formatLooksGoodComment } = require('../src/reviewPrompt');
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
console.log('\n── AC-10: caic no Cat 1 → header is CAIC, no Carbon verification ────');

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
  const savedEnv = process.env.REVIEW_PROFILE;
  process.env.REVIEW_PROFILE = 'caic';
  try {
    const profile = profiles.resolve('bob');
    const result = profile.showCarbonVerification(reviewWithNoFindings());
    assert.strictEqual(result, false);
  } finally {
    if (savedEnv === undefined) delete process.env.REVIEW_PROFILE;
    else process.env.REVIEW_PROFILE = savedEnv;
  }
});

test('profile.showCarbonVerification(reviewWithOnlyCat2Findings()) returns false', () => {
  const savedEnv = process.env.REVIEW_PROFILE;
  process.env.REVIEW_PROFILE = 'caic';
  try {
    const profile = profiles.resolve('bob');
    const result = profile.showCarbonVerification(reviewWithOnlyCat2Findings());
    assert.strictEqual(result, false);
  } finally {
    if (savedEnv === undefined) delete process.env.REVIEW_PROFILE;
    else process.env.REVIEW_PROFILE = savedEnv;
  }
});

// ── AC-11: Cat 1 finding → Carbon verification line present ──────────────────
console.log('\n── AC-11: caic with Cat 1 → Carbon verification line is present ─────');

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
  const savedEnv = process.env.REVIEW_PROFILE;
  process.env.REVIEW_PROFILE = 'caic';
  try {
    const profile = profiles.resolve('bob');
    const result = profile.showCarbonVerification(reviewWithCat1Finding());
    assert.strictEqual(result, true);
  } finally {
    if (savedEnv === undefined) delete process.env.REVIEW_PROFILE;
    else process.env.REVIEW_PROFILE = savedEnv;
  }
});

// ── AC-4 guard: core path byte-identical ─────────────────────────────────────
console.log('\n── AC-4 guard: core formatSummaryComment is unchanged ────────────────');

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

// ── summary ───────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}  Failed: ${failed}`);
if (failed > 0) process.exit(1);
