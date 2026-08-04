/**
 * Unit tests for hasCatalogue detection in parseReviewOutput.
 *
 * These tests run the actual regex extracted from reviewParser.js so that
 * any future change to the regex is validated before the test is updated.
 *
 * Test cases are derived from:
 *   - bhdUHX artifact: bare NO-FINDINGS lines (old prompt, no findings)
 *   - pDf1M2 artifact: backtick-wrapped `[file:line] — …` lines (new prompt, findings)
 *   - Hypothetical future formats documented during adversarial review
 */

'use strict';

// ---------------------------------------------------------------------------
// Extract the hasCatalogue regex directly from the parser source so this test
// always validates the live pattern, not a stale copy.
// ---------------------------------------------------------------------------
const fs = require('fs');
const parserSrc = fs.readFileSync(require.resolve('../src/reviewParser.js'), 'utf8');
const { parseReviewOutput } = require('../src/reviewParser');

// Pull the regex literal from the source: hasCatalogue = /<regex>/m.test(...)
const regexMatch = parserSrc.match(/hasCatalogue\s*=\s*(\/.*?\/[gimsuy]*)\s*\.test/);
if (!regexMatch) {
  console.error('❌ Could not extract hasCatalogue regex from reviewParser.js');
  process.exit(1);
}
const hasCatalogueRegex = eval(regexMatch[1]); // eslint-disable-line no-eval
console.log(`🔍 Extracted regex: ${hasCatalogueRegex}\n`);

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;

function test(description, input, expected) {
  const result = hasCatalogueRegex.test(input);
  const ok = result === expected;
  if (ok) {
    passed++;
    console.log(`  ✅ ${description}`);
  } else {
    failed++;
    console.log(`  ❌ ${description}`);
    console.log(`     input:    ${JSON.stringify(input.slice(0, 80))}`);
    console.log(`     expected: ${expected}, got: ${result}`);
  }
}

// ---------------------------------------------------------------------------
// SHOULD MATCH (hasCatalogue = true) — catalogue evidence IS present
// ---------------------------------------------------------------------------
console.log('── Should match (catalogue present) ──────────────────────────');

// Observed: bhdUHX — bare NO-FINDINGS lines at start of line
test(
  'bare NO-FINDINGS line',
  'NO-FINDINGS date-picker-input.ts — Internal refactoring replacing querySelector',
  true
);

test(
  'bare NO-FINDINGS line — second file',
  'NO-FINDINGS dropdown.ts — Internal refactoring replacing querySelector',
  true
);

// Observed: pDf1M2 — backtick-wrapped file:line catalogue entries
test(
  'backtick-wrapped file:line catalogue entry',
  '`date-picker-input.ts:66-75 — @query decorator with non-null assertion — Category 2 — pending`',
  true
);

// Observed: pDf1M2 — backtick-wrapped file-only (no line number) catalogue entries
test(
  'backtick-wrapped file-only catalogue entry',
  '`date-picker-input.ts — new @query declarations, no test file in changed files — Category 2 — pending`',
  true
);

// Hypothetical: bullet-prefixed NO-FINDINGS (natural Markdown list form)
test(
  'bullet-prefixed NO-FINDINGS',
  '- NO-FINDINGS dropdown.ts — clean file, no suspicious items',
  true
);

// Hypothetical: bracket-style entry per the prompt example format
test(
  'bracket-style [file:line] — catalogue entry',
  '[overflow-menu.figma.ts:33] — menu-alignment on <cds-overflow-menu> — Category 1 — pending',
  true
);

// Hypothetical: SKIP line for test fixture
test(
  'bare SKIP line',
  'SKIP fixtures/test.ts — fixture',
  true
);

// Hypothetical: bullet-prefixed SKIP
test(
  'bullet-prefixed SKIP',
  '- SKIP __testfixtures__/foo.ts — fixture',
  true
);

// Multiline: catalogue entry is NOT the first line (typical — step heading comes first)
test(
  'catalogue entry present but not first line (multiline)',
  '## Step 1 — Catalogue\n\nReviewing all 4 changed files:\n\nNO-FINDINGS date-picker-input.ts — clean refactor',
  true
);

test(
  'backtick entry in multiline output after prose',
  '## Step 1\n\nAll 4 files reviewed:\n\n`date-picker-input.ts:66-75 — @query non-null assertion — Category 2 — pending`',
  true
);

// ---------------------------------------------------------------------------
// SHOULD NOT MATCH (hasCatalogue = false) — no catalogue evidence present
// ---------------------------------------------------------------------------
console.log('\n── Should not match (no catalogue) ───────────────────────────');

// Observed: bhdUHX — agent put all work in <thinking>, output only JSON
test(
  'JSON-only output with no catalogue (original failure case)',
  'BEGIN_REVIEW_JSON\n{\n  "summaryMarkdown": "Refactoring PR.",\n  "findings": []\n}\nEND_REVIEW_JSON',
  false
);

// Observed: Step 2 heading contains em-dash — must not trigger
test(
  '## Step 2 — Resolve heading (em-dash present, no catalogue)',
  '## Step 2 — Resolve every pending item',
  false
);

// Observed: prose resolution lines
test(
  'Resolution: confirmed finding prose line',
  'Resolution: **confirmed finding** — the non-null assertion contradicts the guard',
  false
);

// Observed: summary narrative
test(
  'prose summary (The following findings...)',
  'The following findings could not be mapped to specific lines in the diff:',
  false
);

// Observed: bold filename heading (not a catalogue entry)
test(
  'bold filename heading (**date-picker-input.ts:**)',
  '**date-picker-input.ts:**',
  false
);

// Observed: bullet narrative line (not a formal catalogue entry)
test(
  'bullet narrative line (- Lines 66-75:...)',
  '- Lines 66-75: New @query decorators for _slotAILabelNode and _slotSlugNode',
  false
);

test(
  'bullet Category 2 check narrative',
  '- Category 2 check: @query typed as HTMLSlotElement! but selector can match zero elements',
  false
);

// Pathological: em-dash in prose should not trigger
test(
  'general prose with em-dash but no filename',
  'All 4 changed files reviewed — no issues found.',
  false
);

test(
  'agent step heading with em-dash',
  '## Catalogue entries:',
  false
);

// ---------------------------------------------------------------------------
// step2Window / hasStep2 — ordering-independent resolution detection
//
// These tests call parseReviewOutput with a minimal valid agent output and
// assert on catalogueWarning, which is the observable output of hasStep2.
// catalogueWarning === null  means hasStep2 = true  (correct, no false positive)
// catalogueWarning !== null  means hasStep2 = false (warning fired)
// ---------------------------------------------------------------------------
console.log('\n── step2Window / hasStep2: resolution ordering ───────────────');

// Minimal valid JSON suffix reused across all three fixtures.
const _json = 'BEGIN_REVIEW_JSON\n{"summaryMarkdown":"Clean.","findings":[]}\nEND_REVIEW_JSON';

function testStep2(description, agentOutput, expectWarning) {
  const result = parseReviewOutput(agentOutput);
  const hasWarning = result !== null && result.catalogueWarning !== null &&
    result.catalogueWarning.toLowerCase().includes('pending');
  const ok = hasWarning === expectWarning;
  if (ok) {
    passed++;
    console.log(`  ✅ ${description}`);
  } else {
    failed++;
    console.log(`  ❌ ${description}`);
    console.log(`     expected warning=${expectWarning}, got warning=${hasWarning}`);
    console.log(`     catalogueWarning: ${result?.catalogueWarning}`);
  }
}

// Case 1 — THE FAILING PATTERN (artifact pull-149):
// Agent writes discarded: BEFORE NO-FINDINGS.
// Current code: false-positive warning. Fixed code: no warning.
testStep2(
  'discarded before NO-FINDINGS — no false-positive warning (pull-149 pattern)',
  'file.ts:5 — doc change — Category 2 — pending\n' +
  'discarded: file.ts:5 is non-behavioral.\n' +
  'NO-FINDINGS file.ts — clean file.\n' + _json,
  false  // no warning expected — step was correctly resolved
);

// Case 2 — NORMAL ORDER: resolution after NO-FINDINGS (already worked before fix).
// Must continue to work after the regex narrowing.
testStep2(
  'discarded after NO-FINDINGS — no warning (normal order)',
  'file.ts:5 — doc change — Category 2 — pending\n' +
  'NO-FINDINGS file.ts — clean.\n' +
  'discarded: file.ts:5 is non-behavioral.\n' + _json,
  false  // no warning expected
);

// Case 3 — GENUINELY UNRESOLVED: pending with no discarded/confirmed finding.
// Warning must still fire — this is not a false positive.
testStep2(
  'pending with no resolution — warning correctly fires',
  'file.ts:5 — doc change — Category 2 — pending\n' + _json,
  true   // warning expected — agent skipped Step 2
);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${'─'.repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  process.exit(1);
} else {
  console.log('✅ All hasCatalogue tests passed!');
}

// Made with Bob
