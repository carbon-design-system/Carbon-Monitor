/**
 * Regression tests for invalid-backslash-escape recovery in reviewParser.
 *
 * Bob's JSON block is free-form LLM output. Prose fields (body, mcpEvidence,
 * summaryMarkdown) frequently contain a lone backslash — a regex (\d, \s), a
 * Windows path, or escaped markdown (\_, \*) — which is an invalid JSON escape.
 * Before the fix, JSON.parse threw "Bad escaped character" and the ENTIRE review
 * was dropped (the PR was skipped). These tests lock in that:
 *   1. such payloads now recover, and
 *   2. already-valid JSON is left byte-for-byte identical (no happy-path change).
 */

const {
  parseReviewOutput,
  escapeInvalidJsonEscapes,
} = require('../src/reviewParser');

let pass = 0;
let fail = 0;
const ok = (name, cond) => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}`); }
};

console.log('\n── escapeInvalidJsonEscapes: unit behaviour ───────────────────');

// Valid escapes must pass through untouched (byte-identical).
const validValues = [
  '{"a":"escaped quote \\" ok"}',
  '{"a":"escaped backslash \\\\ ok"}',
  '{"a":"newline \\n tab \\t return \\r ok"}',
  '{"a":"unicode \\u00e9 and slash \\/ ok"}',
  '{"a":"plain text, no escapes at all"}',
];
for (const v of validValues) {
  JSON.parse(v); // sanity: input really is valid JSON
  ok(`valid JSON unchanged: ${v.slice(0, 40)}…`, escapeInvalidJsonEscapes(v) === v);
}

// Invalid escapes get their backslash doubled so they parse as a literal '\'.
// Note: b f n r t u ARE valid JSON escape letters, so a backslash before one of
// them (e.g. \b in a Windows path) is deliberately left as the control-char escape
// — preserving valid escapes is what guarantees a correct review is never corrupted.
// This case uses only letters that are NOT valid escapes so the literal backslash
// round-trips exactly.
const repaired = escapeInvalidJsonEscapes('{"a":"regex \\d+ ok, md \\_ and \\. dot"}');
let parsed = null;
try { parsed = JSON.parse(repaired); } catch (_) { /* leave null */ }
ok('bad escapes (\\d, \\_, \\.) become parseable', parsed !== null);
ok('repaired value preserves the literal backslashes',
  parsed && parsed.a === 'regex \\d+ ok, md \\_ and \\. dot');

// A path whose escape happens to be a valid JSON escape letter still RECOVERS
// (the whole point — the review is not dropped), even if exact fidelity varies.
const pathRepaired = escapeInvalidJsonEscapes('{"a":"see C:\\Users\\proj\\src for details"}');
let pathParsed = null;
try { pathParsed = JSON.parse(pathRepaired); } catch (_) { /* leave null */ }
ok('windows-ish path with mixed escapes still becomes parseable', pathParsed !== null);

console.log('\n── parseReviewOutput: end-to-end recovery ─────────────────────');

// Mirrors the cloud failure on PR #23212: a lone backslash inside a finding body.
const badEscapeReview = [
  'transcript preamble ... BEGIN_REVIEW_JSON',
  '{',
  '  "summaryMarkdown": "This PR updates the motion API. 1 minor finding.",',
  '  "findings": [',
  '    {',
  '      "severity": "minor",',
  '      "file": "packages/motion/src/surfaces.ts",',
  '      "line": 2,',
  '      "title": "Anchor the regex",',
  '      "body": "The pattern \\d+ is unanchored; use ^\\d+$ to bound it and add a guard.",',
  '      "carbonVerified": false,',
  '      "verificationSource": "not-carbon-specific"',
  '    }',
  '  ],',
  '  "shouldPostInlineComments": true',
  '}',
  'END_REVIEW_JSON',
].join('\n');

// Confirm the raw extracted JSON really is the failing class before repair.
const rawJson = badEscapeReview.slice(
  badEscapeReview.indexOf('{'),
  badEscapeReview.lastIndexOf('}') + 1
);
let rawErr = '';
try { JSON.parse(rawJson); } catch (e) { rawErr = e.message; }
ok('raw payload reproduces "Bad escaped character"', /[Bb]ad escaped character/.test(rawErr));

const recovered = parseReviewOutput(badEscapeReview);
ok('review is recovered (not dropped)', !!recovered);
ok('exactly one finding parsed', !!recovered && recovered.findings.length === 1);

// A clean review must still parse on the first attempt — the escaper is only a
// fallback and must never be needed here.
const cleanReview =
  'noise BEGIN_REVIEW_JSON\n' +
  '{"summaryMarkdown":"ok","findings":[],"shouldPostInlineComments":false}\n' +
  'END_REVIEW_JSON';
const clean = parseReviewOutput(cleanReview);
ok('clean review still parses (happy path untouched)', !!clean && clean.findings.length === 0);

console.log('\n────────────────────────────────────────────────────────────');
console.log(`Results: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log('❌ Bad-escape regression tests FAILED');
  process.exit(1);
}
console.log('✅ All bad-escape regression tests passed!');
