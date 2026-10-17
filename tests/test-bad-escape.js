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
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}`);
  }
};

console.log(
  '\n── escapeInvalidJsonEscapes: unit behaviour ───────────────────'
);

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
  ok(
    `valid JSON unchanged: ${v.slice(0, 40)}…`,
    escapeInvalidJsonEscapes(v) === v
  );
}

// Invalid escapes get their backslash doubled so they parse as a literal '\'.
// Note: b f n r t u ARE valid JSON escape letters, so a backslash before one of
// them (e.g. \b in a Windows path) is deliberately left as the control-char escape
// — preserving valid escapes is what guarantees a correct review is never corrupted.
// This case uses only letters that are NOT valid escapes so the literal backslash
// round-trips exactly.
const repaired = escapeInvalidJsonEscapes(
  '{"a":"regex \\d+ ok, md \\_ and \\. dot"}'
);
let parsed = null;
try {
  parsed = JSON.parse(repaired);
} catch (_) {
  /* leave null */
}
ok('bad escapes (\\d, \\_, \\.) become parseable', parsed !== null);
ok(
  'repaired value preserves the literal backslashes',
  parsed && parsed.a === 'regex \\d+ ok, md \\_ and \\. dot'
);

// A path whose escape happens to be a valid JSON escape letter still RECOVERS
// (the whole point — the review is not dropped), even if exact fidelity varies.
const pathRepaired = escapeInvalidJsonEscapes(
  '{"a":"see C:\\Users\\proj\\src for details"}'
);
let pathParsed = null;
try {
  pathParsed = JSON.parse(pathRepaired);
} catch (_) {
  /* leave null */
}
ok(
  'windows-ish path with mixed escapes still becomes parseable',
  pathParsed !== null
);

console.log(
  '\n── parseReviewOutput: end-to-end recovery ─────────────────────'
);

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
try {
  JSON.parse(rawJson);
} catch (e) {
  rawErr = e.message;
}
ok(
  'raw payload reproduces "Bad escaped character"',
  /[Bb]ad escaped character/.test(rawErr)
);

const recovered = parseReviewOutput(badEscapeReview);
ok('review is recovered (not dropped)', !!recovered);
ok(
  'exactly one finding parsed',
  !!recovered && recovered.findings.length === 1
);

// A clean review must still parse on the first attempt — the escaper is only a
// fallback and must never be needed here.
const cleanReview =
  'noise BEGIN_REVIEW_JSON\n' +
  '{"summaryMarkdown":"ok","findings":[],"shouldPostInlineComments":false}\n' +
  'END_REVIEW_JSON';
const clean = parseReviewOutput(cleanReview);
ok(
  'clean review still parses (happy path untouched)',
  !!clean && clean.findings.length === 0
);

console.log(
  '\n── jsonrepair last-resort fallback ────────────────────────────'
);

// jsonrepair runs ONLY after the escaper has also failed. These lock in that it
// recovers malformations the escaper cannot — so they no longer fall through to
// the token-doubling agent retry — AND that it does NOT run when a cheaper layer
// already succeeds, the ordering that keeps the working path untouched.
function runCapturingWarnings(agentOutput) {
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  let review = null;
  try {
    review = parseReviewOutput(agentOutput);
  } finally {
    console.warn = originalWarn;
  }
  return { review, warnings: warnings.join('\n') };
}

const mk = (bodyJson) => `BEGIN_REVIEW_JSON\n${bodyJson}\nEND_REVIEW_JSON`;
const goodFinding =
  '{"severity":"minor","file":"a.ts","line":1,"title":"t",' +
  '"body":"a reasonably long body ending with an actionable suggestion sentence",' +
  '"carbonVerified":false,"verificationSource":"not-carbon-specific"}';

// 1. Trailing comma — no bad escape for the escaper to fix, so it reaches jsonrepair.
const trailingComma = mk(
  `{"summaryMarkdown":"ok","findings":[${goodFinding},],"shouldPostInlineComments":false}`
);
const tc = runCapturingWarnings(trailingComma);
ok('trailing comma recovered', !!tc.review);
ok('trailing comma used the jsonrepair layer', /jsonrepair/.test(tc.warnings));

// 2. Unescaped interior quote in a NON-padded payload — the quote-sanitiser only
//    runs for v2-padded output, so this would otherwise fall through to the retry.
const unescQuote = mk(
  '{"summaryMarkdown":"ok","findings":[{"severity":"minor","file":"a.ts","line":1,' +
    '"title":"t","body":"the attr role="dialog" is required; add an actionable fix sentence",' +
    '"carbonVerified":false,"verificationSource":"not-carbon-specific"}],"shouldPostInlineComments":false}'
);
const uq = runCapturingWarnings(unescQuote);
ok('unescaped interior quote (non-padded) recovered', !!uq.review);
ok(
  'unescaped interior quote used the jsonrepair layer',
  /jsonrepair/.test(uq.warnings)
);

// 3. Escaper path UNTOUCHED: the bad-escape payload is still fixed by the escaper,
//    and jsonrepair is NOT invoked — the layering the fallback must preserve.
const be = runCapturingWarnings(badEscapeReview);
ok(
  'bad-escape still recovered by the escaper, not jsonrepair',
  !!be.review &&
    /Escaped invalid backslash/.test(be.warnings) &&
    !/jsonrepair/.test(be.warnings)
);

// 4. Clean review invokes NO repair layer at all.
const cl = runCapturingWarnings(cleanReview);
ok(
  'clean review triggers no repair layer',
  !!cl.review && !/Escaped invalid backslash|jsonrepair/.test(cl.warnings)
);

console.log('\n────────────────────────────────────────────────────────────');
console.log(`Results: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log('❌ Bad-escape regression tests FAILED');
  process.exit(1);
}
console.log('✅ All bad-escape regression tests passed!');
