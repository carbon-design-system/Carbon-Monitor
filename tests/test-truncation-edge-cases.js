/**
 * Test edge cases for JSON truncation repair
 * Simulates the exact error: "Unterminated string in JSON at position 8165"
 */

const { parseReviewOutput } = require('../src/reviewParser');

// Simulate a large JSON that gets truncated mid-string at position ~8165
function generateLargeReview(numFindings, truncateAt) {
  let json = `BEGIN_REVIEW_JSON
{
  "summaryMarkdown": "This is a comprehensive review with multiple findings across different files.",
  "findings": [`;

  for (let i = 0; i < numFindings; i++) {
    if (i > 0) json += ',';
    json += `
    {
      "severity": "${i % 4 === 0 ? 'blocking' : i % 3 === 0 ? 'major' : i % 2 === 0 ? 'minor' : 'nit'}",
      "file": "src/utils/helper${i}.js",
      "line": ${10 + i * 5},
      "title": "Finding ${i + 1}: Code quality issue",
      "body": "This is a detailed description of the finding. It includes multiple sentences to make it realistic. The issue should be addressed by refactoring the code to follow best practices. Consider using proper error handling and validation. This is a generic code review comment.",
      "carbonVerified": false,
      "verificationSource": "not-carbon-specific"
    }`;

    // Truncate at specified position if we've reached it
    if (truncateAt && json.length >= truncateAt) {
      return json.substring(0, truncateAt);
    }
  }

  json += `
  ],
  "shouldPostInlineComments": true
}
END_REVIEW_JSON`;

  return json;
}

let failures = 0;

console.log('🧪 Testing edge cases for JSON truncation...\n');

// Test 1: Truncate at exactly 8165 characters (simulating the reported error)
console.log('Test 1: Truncate at position 8165 (reported error scenario)');
const largeReview1 = generateLargeReview(50, 8165);
console.log(`Generated JSON length: ${largeReview1.length} characters`);
const result1 = parseReviewOutput(largeReview1);
if (result1 && result1.findings && result1.findings.length > 0) {
  console.log(
    `✅ PASS: Recovered ${result1.findings.length} findings from truncated JSON`
  );
  console.log(`   Summary: "${result1.summaryMarkdown.substring(0, 50)}..."`);
} else {
  failures++;
  console.log('❌ FAIL: Could not parse truncated JSON');
}
console.log();

// Test 2: Truncate mid-property name
console.log('Test 2: Truncate mid-property name');
const midProperty = `BEGIN_REVIEW_JSON
{
  "summaryMarkdown": "Test",
  "findings": [
    {
      "severity": "major",
      "file": "test.js",
      "line": 10,
      "title": "Finding 1",
      "body": "Complete",
      "carbonVerified": false,
      "verificationSource": "not-carbon-specific"
    },
    {
      "severity": "minor",
      "file": "test2.js",
      "line": 20,
      "tit`;
const result2 = parseReviewOutput(midProperty);
if (result2 && result2.findings.length === 1) {
  console.log(
    '✅ PASS: Recovered 1 complete finding, discarded incomplete one'
  );
} else {
  failures++;
  console.log(
    '❌ FAIL: Expected 1 finding, got:',
    result2?.findings?.length || 'null'
  );
}
console.log();

// Test 3: Truncate mid-array
console.log('Test 3: Truncate mid-array with no complete findings after first');
const midArray = `BEGIN_REVIEW_JSON
{
  "summaryMarkdown": "Test",
  "findings": [
    {
      "severity": "major",
      "file": "test.js",
      "line": 10,
      "title": "Finding 1",
      "body": "Complete",
      "carbonVerified": false,
      "verificationSource": "not-carbon-specific"
    },
    {
      "severity"`;
const result3 = parseReviewOutput(midArray);
if (result3 && result3.findings.length === 1) {
  console.log('✅ PASS: Recovered 1 complete finding');
} else {
  failures++;
  console.log(
    '❌ FAIL: Expected 1 finding, got:',
    result3?.findings?.length || 'null'
  );
}
console.log();

// Test 4: Truncate with escaped quotes in string
console.log('Test 4: Truncate with escaped quotes in body text');
const withEscapes = `BEGIN_REVIEW_JSON
{
  "summaryMarkdown": "Test with \\"escaped\\" quotes",
  "findings": [
    {
      "severity": "major",
      "file": "test.js",
      "line": 10,
      "title": "Finding with \\"quotes\\"",
      "body": "This has \\"escaped\\" quotes in it",
      "carbonVerified": false,
      "verificationSource": "not-carbon-specific"
    },
    {
      "severity": "minor",
      "file": "test2.js",
      "line": 20,
      "title": "Another finding",
      "body": "This is truncated mid`;
const result4 = parseReviewOutput(withEscapes);
if (result4 && result4.findings.length === 1) {
  console.log('✅ PASS: Handled escaped quotes correctly, recovered 1 finding');
} else {
  failures++;
  console.log(
    '❌ FAIL: Expected 1 finding, got:',
    result4?.findings?.length || 'null'
  );
}
console.log();

// Test 5: No complete findings at all
console.log('Test 5: Truncate before any complete findings');
const noComplete = `BEGIN_REVIEW_JSON
{
  "summaryMarkdown": "Test",
  "findings": [
    {
      "severity": "major",
      "file": "test.js",
      "line": 10,
      "title": "Finding 1",
      "body": "This is trunca`;
const result5 = parseReviewOutput(noComplete);
if (result5 && result5.findings.length === 0) {
  console.log('✅ PASS: Correctly returned empty findings array');
} else {
  failures++;
  console.log(
    '❌ FAIL: Expected 0 findings, got:',
    result5?.findings?.length || 'null'
  );
}
console.log();

console.log('🏁 Edge case tests complete');
if (failures > 0) process.exit(1);
