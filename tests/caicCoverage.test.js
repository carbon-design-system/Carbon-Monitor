'use strict';
// tests/caicCoverage.test.js — AC-14
//
// AC-14: Given paths es-custom/…, telemetry.yml, custom-elements.json and
//        x_spec.ts, when classified with the caic extra patterns, then the first
//        three are generated (class 2) and the last is support (class 1); the
//        same paths without extra patterns classify as today (class 0 or 1).

const assert = require('assert');
const { classify } = require('../src/reviewCoverage');
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

// Get the caic extra patterns from the profile object (not resolved, just the
// static object — no env needed for this).
const { CAIC } = require('../src/profiles');

// ── AC-14: caic extra patterns ────────────────────────────────────────────────
console.log(
  '\n── AC-14: caic extra coverage patterns ──────────────────────────────'
);

// Generated (class 2) with caic patterns
const GENERATED_PATHS = [
  'packages/ai-chat/src/chat/es-custom/foo.js',
  'dist/es-custom/bar.css',
  'storybook-static/main.js',
  'storybook-react-static/main.js',
  'packages/ai-chat-components/custom-elements.json',
  'telemetry.yml',
];

// Support (class 1) with caic patterns
const SUPPORT_PATHS = [
  'packages/ai-chat/src/foo_spec.ts',
  'packages/ai-chat-components/src/bar_spec.tsx',
  'tests/integration.ts',
  'packages/ai-chat/tests/unit.ts',
];

for (const p of GENERATED_PATHS) {
  test(`"${p}" → class 2 (generated) with caic patterns`, () => {
    const cls = classify(p, CAIC.extraPatterns);
    assert.strictEqual(cls, 2, `Expected 2 (generated), got ${cls}`);
  });
}

for (const p of SUPPORT_PATHS) {
  test(`"${p}" → class 1 (support) with caic patterns`, () => {
    const cls = classify(p, CAIC.extraPatterns);
    assert.strictEqual(cls, 1, `Expected 1 (support), got ${cls}`);
  });
}

// AC-14 also requires: same paths WITHOUT extra patterns classify as today
// (i.e. as class 0 — regular source files)
const PATHS_WITHOUT_EXTRA = [
  'packages/ai-chat/src/chat/es-custom/foo.js',
  'telemetry.yml',
  'packages/ai-chat-components/custom-elements.json',
  'packages/ai-chat/src/foo_spec.ts',
];

for (const p of PATHS_WITHOUT_EXTRA) {
  test(`"${p}" without extra patterns → class 0 (source) as today`, () => {
    const cls = classify(p); // no extra arg
    assert.strictEqual(
      cls,
      0,
      `Expected 0 (source) without extra patterns, got ${cls}`
    );
  });
}

// A few core paths must still be classified correctly with caic patterns (regression guard)
const CORE_GENERATED = [
  '__snapshots__/foo.snap',
  'dist/foo.js',
  'es/foo.js',
  'lib/foo.js',
  'foo.min.js',
  'package-lock.json',
];

const CORE_SUPPORT = [
  '__tests__/foo.test.js',
  '__testfixtures__/data.json',
  'foo.test.js',
  'foo.spec.ts',
  'foo.stories.jsx',
  'README.md',
];

for (const p of CORE_GENERATED) {
  test(`core generated "${p}" still class 2 with caic patterns`, () => {
    const cls = classify(p, CAIC.extraPatterns);
    assert.strictEqual(cls, 2, `Expected 2 (generated), got ${cls}`);
  });
}

for (const p of CORE_SUPPORT) {
  test(`core support "${p}" still class 1 with caic patterns`, () => {
    const cls = classify(p, CAIC.extraPatterns);
    assert.strictEqual(cls, 1, `Expected 1 (support), got ${cls}`);
  });
}

// ── summary ───────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}  Failed: ${failed}`);
if (failed > 0) process.exit(1);
