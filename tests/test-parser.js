/**
 * Test the review parser with truncated JSON scenarios
 */

const {
  parseReviewOutput,
  computeRecommendation,
} = require('../src/reviewParser');

// Test case 1: Truncated JSON mid-string
const truncatedMidString = `
Some agent output before the JSON...

BEGIN_REVIEW_JSON
{
  "summaryMarkdown": "This is a test review",
  "findings": [
    {
      "severity": "major",
      "file": "src/test.js",
      "line": 10,
      "title": "Test finding 1",
      "body": "This is a complete finding",
      "carbonVerified": false,
      "verificationSource": "not-carbon-specific"
    },
    {
      "severity": "minor",
      "file": "src/test2.js",
      "line": 20,
      "title": "Test finding 2",
      "body": "This finding is truncated mid-str
`;

// Test case 2: Truncated JSON with complete findings
const truncatedWithCompleteFindings = `
BEGIN_REVIEW_JSON
{
  "summaryMarkdown": "Review summary",
  "findings": [
    {
      "severity": "major",
      "file": "src/test.js",
      "line": 10,
      "title": "Finding 1",
      "body": "Complete finding",
      "carbonVerified": false,
      "verificationSource": "not-carbon-specific"
    },
    {
      "severity": "minor",
      "file": "src/test2.js",
      "line": 20,
      "title": "Finding 2",
      "body": "Also complete",
      "carbonVerified": false,
      "verificationSource": "not-carbon-specific"
    },
    {
      "severity": "nit",
      "file": "src/test3.js",
`;

// Test case 3: Valid complete JSON
const validJSON = `
BEGIN_REVIEW_JSON
{
  "summaryMarkdown": "Complete review",
  "findings": [
    {
      "severity": "major",
      "file": "src/test.js",
      "line": 10,
      "title": "Finding 1",
      "body": "Complete finding",
      "carbonVerified": false,
      "verificationSource": "not-carbon-specific"
    }
  ],
  "shouldPostInlineComments": true
}
END_REVIEW_JSON
`;

let failures = 0;

console.log('🧪 Testing review parser...\n');

// Test 1
console.log('Test 1: Truncated mid-string');
const result1 = parseReviewOutput(truncatedMidString);
if (result1 && result1.findings.length === 1) {
  console.log('✅ PASS: Recovered 1 complete finding from truncated JSON');
} else {
  failures++;
  console.log(
    '❌ FAIL: Expected 1 finding, got:',
    result1?.findings?.length || 'null'
  );
}
console.log();

// Test 2
console.log('Test 2: Truncated with 2 complete findings');
const result2 = parseReviewOutput(truncatedWithCompleteFindings);
if (result2 && result2.findings.length === 2) {
  console.log('✅ PASS: Recovered 2 complete findings from truncated JSON');
} else {
  failures++;
  console.log(
    '❌ FAIL: Expected 2 findings, got:',
    result2?.findings?.length || 'null'
  );
}
console.log();

// Test 3
console.log('Test 3: Valid complete JSON');
const result3 = parseReviewOutput(validJSON);
if (result3 && result3.findings.length === 1) {
  console.log('✅ PASS: Parsed complete JSON correctly');
} else {
  failures++;
  console.log(
    '❌ FAIL: Expected 1 finding, got:',
    result3?.findings?.length || 'null'
  );
}
console.log();

// Test 4: fix passes through untouched; absent or malformed is dropped silently
console.log('Test 4: the optional fix field');
const finding = (extra) => ({
  severity: 'major',
  file: 'src/test.js',
  line: 10,
  title: 'Finding',
  body: 'Complete finding that ends with an imperative sentence.',
  carbonVerified: false,
  verificationSource: 'not-carbon-specific',
  ...extra,
});
const withFixes = `BEGIN_REVIEW_JSON
${JSON.stringify({
  summaryMarkdown: 'Fix field review',
  findings: [
    finding({ fix: ['  const a = 1;', '  return a;'] }),
    finding({}),
    finding({ fix: 'const a = 1;' }),
    finding({ fix: [] }),
    finding({ fix: ['ok', 3] }),
    finding({ fix: null }),
  ],
})}
END_REVIEW_JSON`;
const result4 = parseReviewOutput(withFixes);
const fixes = result4 ? result4.findings.map((f) => f.fix) : [];
const fixKept =
  result4 &&
  result4.findings.length === 6 &&
  JSON.stringify(fixes[0]) ===
    JSON.stringify(['  const a = 1;', '  return a;']) &&
  result4.findings.slice(1).every((f) => !('fix' in f));
if (fixKept) {
  console.log('✅ PASS: fix kept as given, malformed or absent fix dropped');
} else {
  failures++;
  console.log('❌ FAIL: fix handling, got:', JSON.stringify(fixes));
}
console.log();

// Test 5: the blocking rationale lists every blocking title
console.log('Test 5: blocking rationale names every blocking finding');
const rec = computeRecommendation(
  [
    { severity: 'blocking', title: 'First title' },
    { severity: 'major', title: 'Not listed' },
    { severity: 'blocking', title: 'Second title' },
  ],
  { hasCatalogue: true }
);
const expected = '2 blocking findings: "First title", "Second title"';
const single = computeRecommendation(
  [{ severity: 'blocking', title: 'Only title' }],
  { hasCatalogue: true }
).recommendationRationale;
if (
  rec.recommendationRationale === expected &&
  single === '1 blocking finding: "Only title"'
) {
  console.log('✅ PASS: every blocking title listed');
} else {
  failures++;
  console.log('❌ FAIL:', rec.recommendationRationale, '|', single);
}
console.log();

console.log('🏁 Tests complete');
if (failures > 0) process.exit(1);
