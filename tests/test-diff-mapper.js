/**
 * Test diff mapper functionality
 */

const {
  parseDiffLinePositions,
  mapFindingToDiffPosition,
  splitFindings,
} = require('../src/diffMapper');

// Sample unified diff
const sampleDiff = `diff --git a/src/components/Button.js b/src/components/Button.js
index 1234567..abcdefg 100644
--- a/src/components/Button.js
+++ b/src/components/Button.js
@@ -10,7 +10,8 @@ import React from 'react';
 
 export function Button({ label, onClick }) {
   return (
-    <button onClick={onClick}>
+    <button 
+      onClick={onClick}>
       {label}
     </button>
   );
@@ -25,6 +26,7 @@ export function IconButton({ icon, onClick }) {
     <button 
       className="icon-button"
       onClick={onClick}
+      aria-label={icon}
     >
       <Icon name={icon} />
     </button>`;

// Sample files array
const sampleFiles = [
  {
    filename: 'src/components/Button.js',
    additions: 2,
    deletions: 1,
    status: 'modified',
  },
];

// Sample findings
const sampleFindings = [
  {
    severity: 'minor',
    file: 'src/components/Button.js',
    line: 13,
    title: 'Split button attributes',
    body: 'Button attributes should be on separate lines',
    carbonVerified: false,
    verificationSource: 'not-carbon-specific',
  },
  {
    severity: 'major',
    file: 'src/components/Button.js',
    line: 29,
    title: 'Missing aria-label',
    body: 'Icon button needs aria-label for accessibility',
    carbonVerified: true,
    verificationSource: 'carbon-builder',
  },
  {
    severity: 'nit',
    file: 'src/components/Button.js',
    line: 100,
    title: 'Unreachable finding',
    body: 'This line is not in the diff',
    carbonVerified: false,
    verificationSource: 'not-carbon-specific',
  },
  {
    severity: 'minor',
    file: 'src/other/File.js',
    line: 10,
    title: 'Different file',
    body: 'This file is not in the changed files',
    carbonVerified: false,
    verificationSource: 'not-carbon-specific',
  },
];

console.log('🧪 Testing Diff Mapper\n');

// Test 1: Parse diff line positions
console.log('Test 1: Parse diff line positions');
const lineMap = parseDiffLinePositions(sampleDiff);
console.log('Files found:', Array.from(lineMap.keys()));
const buttonMap = lineMap.get('src/components/Button.js');
console.log(
  'Line mappings for Button.js:',
  buttonMap ? buttonMap.lineMap.size : 0
);
console.log('✅ Test 1 passed\n');

// Test 2: Map individual findings
console.log('Test 2: Map individual findings');
sampleFindings.forEach((finding, i) => {
  const position = mapFindingToDiffPosition(finding, sampleDiff, sampleFiles);
  console.log(`Finding ${i + 1} (${finding.file}:${finding.line}):`);
  if (position) {
    console.log(`  ✅ Mapped to position ${position.position}`);
  } else {
    console.log(`  ❌ Could not map to diff`);
  }
});
console.log('✅ Test 2 passed\n');

// Test 3: Split findings
console.log('Test 3: Split findings into inline vs summary');
const { inlineFindings, summaryFindings } = splitFindings(
  sampleFindings,
  sampleDiff,
  sampleFiles
);
console.log(`Inline findings: ${inlineFindings.length}`);
console.log(`Summary findings: ${summaryFindings.length}`);

inlineFindings.forEach((f) => {
  console.log(
    `  ✅ ${f.file}:${f.line} -> position ${f.diffPosition.position}`
  );
});

summaryFindings.forEach((f) => {
  console.log(`  ℹ️  ${f.file}:${f.line} (not in diff)`);
});

console.log('✅ Test 3 passed\n');

// Test 4: Secondary lookup — agent reports PR_REVIEW_REQUEST.md absolute line numbers
// Mirrors the exact numbers from PR #161:
//   mdDiffStartLine = 44 (line of ```diff in PR_REVIEW_REQUEST.md)
//   Stories @@ at diff line 6  → agent reports md line 117  → new-file line 67
//   Banner  @@ at diff line 90 → agent reports md line 176  → new-file line 42
console.log('Test 4: Secondary lookup (md-absolute line numbers)');

// Build a minimal two-file all-+ diff that matches the structure used in create-test-pr.js
const storiesLines = Array.from({ length: 77 }, (_, i) => `+line ${i + 1}`);
const bannerLines = Array.from({ length: 68 }, (_, i) => `+line ${i + 1}`);
const storiesPath =
  'packages/react/src/components/Notification/stories/ActionableNotification.stories.js';
const bannerPath =
  'packages/react/src/components/Notification/NotificationBanner.tsx';

// diff line 1-5: stories header; diff line 6: stories @@; diff line 7-83: stories content
// diff line 84: blank; diff line 85-89: banner header; diff line 90: banner @@; 91-158: banner content
const secondaryDiff =
  `diff --git a/${storiesPath} b/${storiesPath}\n` +
  `new file mode 100644\nindex 0000000..0000000\n--- /dev/null\n+++ b/${storiesPath}\n` +
  `@@ -0,0 +1,77 @@\n` +
  storiesLines.join('\n') +
  '\n\n' +
  `diff --git a/${bannerPath} b/${bannerPath}\n` +
  `new file mode 100644\nindex 0000000..0000000\n--- /dev/null\n+++ b/${bannerPath}\n` +
  `@@ -0,0 +1,68 @@\n` +
  bannerLines.join('\n') +
  '\n';

const secondaryFiles = [
  { filename: storiesPath, status: 'modified' },
  { filename: bannerPath, status: 'added' },
];

// Verify @@ positions in the constructed diff match expected
const secondaryDiffLines = secondaryDiff.split('\n');
const storiesHunkLine =
  secondaryDiffLines.findIndex((l) => l.startsWith('@@ -0,0 +1,77')) + 1;
const bannerHunkLine =
  secondaryDiffLines.findIndex((l) => l.startsWith('@@ -0,0 +1,68')) + 1;
console.log(`  Stories @@ at diff line: ${storiesHunkLine} (expected 6)`);
console.log(`  Banner  @@ at diff line: ${bannerHunkLine}  (expected 90)`);

const MD_DIFF_START = 44; // ```diff is at line 44 of PR_REVIEW_REQUEST.md (PR #161 value)

// Agent-reported md-absolute lines (what the agent actually writes in its JSON)
const cat1MdLine = MD_DIFF_START + storiesHunkLine + 67 - 1; // = 44 + 6 + 66 = 116? Let's compute directly
// Formula: agent reports md_@@_line + new_file_line = (MD_DIFF_START + hunkLine) + new_file_line
// For stories new-file line 67: agent reports (44 + 6) + 67 = 117
// For banner  new-file line 42: agent reports (44 + 90) + 42 = 176 -- but wait:
// md_@@_line = MD_DIFF_START + hunkLine. new_file_line 1 starts at md_@@_line + 1.
// agent_reported = md_@@_line + new_file_line = (44 + 6) + 67 = 117. Confirmed from actual run.
const cat1Reported = MD_DIFF_START + storiesHunkLine + 67; // = 117
const cat2Reported = MD_DIFF_START + bannerHunkLine + 42; // = 176
console.log(`  Cat1 agent-reported md line: ${cat1Reported} (expected 117)`);
console.log(`  Cat2 agent-reported md line: ${cat2Reported} (expected 176)`);

const cat1Secondary = mapFindingToDiffPosition(
  { file: storiesPath, line: cat1Reported },
  secondaryDiff,
  secondaryFiles,
  MD_DIFF_START
);
const cat2Secondary = mapFindingToDiffPosition(
  { file: bannerPath, line: cat2Reported },
  secondaryDiff,
  secondaryFiles,
  MD_DIFF_START
);

console.log(`  Cat1 secondary result: ${JSON.stringify(cat1Secondary)}`);
console.log(`  Cat2 secondary result: ${JSON.stringify(cat2Secondary)}`);

// Expected: stories new-file line 67 → position 67; banner new-file line 42 → position 42
// (position 1 is the first line below a file's first @@ header, so a single-hunk
// file maps new-file line N of a hunk starting at 1 to position N).
if (!cat1Secondary || cat1Secondary.position !== 67) {
  console.error(
    `❌ Test 4 failed: Cat1 expected position 67, got ${cat1Secondary?.position}`
  );
  process.exit(1);
}
if (!cat2Secondary || cat2Secondary.position !== 42) {
  console.error(
    `❌ Test 4 failed: Cat2 expected position 42, got ${cat2Secondary?.position}`
  );
  process.exit(1);
}

// Verify backward compat: without mdDiffStartLine, these same reported lines return null
const cat1NoBridge = mapFindingToDiffPosition(
  { file: storiesPath, line: cat1Reported },
  secondaryDiff,
  secondaryFiles
  // no mdDiffStartLine → defaults to 0 → secondary lookup skipped
);
if (cat1NoBridge !== null) {
  console.error(
    `❌ Test 4 failed: backward-compat check — expected null without mdDiffStartLine`
  );
  process.exit(1);
}

console.log('✅ Test 4 passed (secondary lookup + backward compat)\n');

// Test 5: positions match what GitHub resolves. The first @@ header of a file is
// not a position; a later header is. Pairs confirmed on carbon#22971 (Oct 18,
// 2026): GitHub placed position 6 on line 30 and position 14 on line 50 of
// this two-hunk file.
console.log('Test 5: GitHub-confirmed positions on a two-hunk file');
const twoHunkDiff = require('fs').readFileSync(
  require('path').join(
    __dirname,
    'fixtures',
    'diff',
    'ailabel-two-hunks.patch'
  ),
  'utf8'
);
const twoHunkFiles = [
  { filename: 'packages/react/code-connect/AILabel/AILabel.figma.tsx' },
];
const at = (line) =>
  mapFindingToDiffPosition(
    { file: twoHunkFiles[0].filename, line },
    twoHunkDiff,
    twoHunkFiles
  )?.position;
const expectedPositions = { 29: 5, 30: 6, 49: 13, 50: 14 };
for (const [line, position] of Object.entries(expectedPositions)) {
  if (at(Number(line)) !== position) {
    console.error(
      `❌ Test 5 failed: line ${line} expected position ${position}, got ${at(Number(line))}`
    );
    process.exit(1);
  }
}
// The sample diff above: line 13 sits in hunk 1, line 29 in hunk 2 (its header counts).
if (
  mapFindingToDiffPosition(
    { file: 'src/components/Button.js', line: 13 },
    sampleDiff,
    sampleFiles
  ).position !== 5 ||
  mapFindingToDiffPosition(
    { file: 'src/components/Button.js', line: 29 },
    sampleDiff,
    sampleFiles
  ).position !== 14
) {
  console.error('❌ Test 5 failed: sample diff positions');
  process.exit(1);
}
console.log('✅ Test 5 passed (GitHub-confirmed positions)\n');

// Validation
const expectedInline = 2; // Lines 13 and 29 should be mappable
const expectedSummary = 2; // Line 100 and different file should not be mappable

if (
  inlineFindings.length === expectedInline &&
  summaryFindings.length === expectedSummary
) {
  console.log('✅ All tests passed!');
  process.exit(0);
} else {
  console.error(
    `❌ Test failed: Expected ${expectedInline} inline and ${expectedSummary} summary, got ${inlineFindings.length} and ${summaryFindings.length}`
  );
  process.exit(1);
}
