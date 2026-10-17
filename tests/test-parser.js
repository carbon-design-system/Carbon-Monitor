/**
 * Test the review parser with truncated JSON scenarios
 */

const { parseReviewOutput } = require('../src/reviewParser');

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

console.log('🧪 Testing review parser...\n');

// Test 1
console.log('Test 1: Truncated mid-string');
const result1 = parseReviewOutput(truncatedMidString);
if (result1 && result1.findings.length === 1) {
  console.log('✅ PASS: Recovered 1 complete finding from truncated JSON');
} else {
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
  console.log(
    '❌ FAIL: Expected 1 finding, got:',
    result3?.findings?.length || 'null'
  );
}
console.log();

console.log('🏁 Tests complete');
