/**
 * Regression tests — Carbon Builder skill authority model
 *
 * These tests assert that the carbon-builder skill is the PRIMARY authority for
 * Category 1 findings and that Carbon MCP is positioned as the fallback/secondary
 * source. A regression that swaps this order would silently degrade review quality
 * (agent goes straight to MCP without the skill's governing protocol).
 *
 * Affected files: src/reviewPrompt.js, src/reviewBundle.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ─── Load the live source files ───────────────────────────────────────────────
const { buildReviewPrompt, formatSummaryComment } = require('../src/reviewPrompt');
const bundleSrc = fs.readFileSync(
  path.resolve(__dirname, '../src/reviewBundle.js'),
  'utf8'
);

// ─── Test runner ──────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function test(description, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${description}`);
  } catch (err) {
    failed++;
    console.log(`  ❌ ${description}`);
    console.log(`     ${err.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertMentionsBefore(text, first, second, context) {
  const posFirst = text.indexOf(first);
  const posSecond = text.indexOf(second);
  assert(posFirst !== -1, `"${first}" not found in ${context}`);
  assert(posSecond !== -1, `"${second}" not found in ${context}`);
  assert(
    posFirst < posSecond,
    `Expected "${first}" to appear before "${second}" in ${context}, ` +
    `but "${first}" is at ${posFirst} and "${second}" is at ${posSecond}`
  );
}

// ─── buildReviewPrompt ────────────────────────────────────────────────────────
console.log('\n── buildReviewPrompt: carbon-builder authority ───────────────');

const prompt = buildReviewPrompt({ owner: 'carbon-design-system', repo: 'carbon' });

test('prompt contains "invoke the carbon-builder skill" authority language', () => {
  assert(
    /invoke.*carbon-builder.*skill/i.test(prompt),
    'prompt must contain "invoke the carbon-builder skill" authority language'
  );
});

test('prompt positions carbon-builder before Carbon MCP in Step 2', () => {
  const step2Start = prompt.indexOf('## Step 2');
  const step2Block = prompt.slice(step2Start, step2Start + 1600);
  // Carbon Migration uses "Carbon MCP" (title-case) in the tier ladder; match either form
  const posCB = step2Block.indexOf('carbon-builder');
  const posMCP = Math.min(
    step2Block.indexOf('Carbon MCP') !== -1 ? step2Block.indexOf('Carbon MCP') : Infinity,
    step2Block.indexOf('carbon-mcp') !== -1 ? step2Block.indexOf('carbon-mcp') : Infinity
  );
  assert(posCB !== -1, '"carbon-builder" not found in Step 2');
  assert(posMCP !== Infinity, '"Carbon MCP" or "carbon-mcp" not found in Step 2');
  assert(posCB < posMCP, `Expected carbon-builder (pos ${posCB}) before Carbon MCP (pos ${posMCP}) in Step 2`);
});

test('Step 2 Category 1 branch uses exact Carbon Migration "Carbon API source of truth" phrase', () => {
  const step2Start = prompt.indexOf('## Step 2');
  assert(step2Start !== -1, '"## Step 2" not found');
  const step2Block = prompt.slice(step2Start, step2Start + 1600);
  assert(
    /\*\*Carbon API source of truth\*\*/.test(step2Block),
    'Step 2 Category 1 branch must contain **Carbon API source of truth** (exact Carbon Migration phrasing)'
  );
});

test('Step 2 ladder uses exact Carbon Migration PREFER / FALLBACK phrasing', () => {
  const step2Start = prompt.indexOf('## Step 2');
  const step2Block = prompt.slice(step2Start, step2Start + 1200);
  assert(/\*\*PREFER\*\*/.test(step2Block), 'Step 2 must contain **PREFER** (exact Carbon Migration wording)');
  assert(/\*\*FALLBACK\*\*.*Carbon MCP/.test(step2Block), 'Step 2 must contain **FALLBACK** to Carbon MCP (exact wording)');
  assert(/\*\*FALLBACK\*\*.*model knowledge/.test(step2Block), 'Step 2 must contain **FALLBACK** to model knowledge (exact wording)');
});

test('Step 2 uses exact Carbon Migration "MUST NOT halt" + "Uptime is mandatory" sentences', () => {
  const step2Start = prompt.indexOf('## Step 2');
  const step2Block = prompt.slice(step2Start, step2Start + 1600);
  assert(
    /The review MUST NOT halt because a tier is unavailable\./.test(step2Block),
    'Step 2 must contain "The review MUST NOT halt because a tier is unavailable."'
  );
  assert(
    /Uptime is mandatory\./.test(step2Block),
    'Step 2 must contain "Uptime is mandatory."'
  );
});

test('Step 2 per-item Category 1 instruction uses invoke-first language', () => {
  const step2Start = prompt.indexOf('## Step 2');
  const step2Block = prompt.slice(step2Start, step2Start + 1600);
  // "Invoke via the Skill tool before making any Carbon claim" is the PREFER sub-bullet
  assert(
    /Invoke via the.*Skill.*tool before making any Carbon claim/i.test(step2Block),
    'Category 1 PREFER bullet must say "Invoke via the Skill tool before making any Carbon claim"'
  );
  assert(
    /Before looking up any prop.*invoke.*carbon-builder/i.test(step2Block),
    'Category 1 per-item instruction must contain "Before looking up any prop…invoke carbon-builder"'
  );
});

test('Step 2 tier ladder positions carbon-builder before Carbon MCP', () => {
  const step2Start = prompt.indexOf('## Step 2');
  const step2Block = prompt.slice(step2Start, step2Start + 1600);
  const posCB = step2Block.indexOf('carbon-builder');
  const posMCP = Math.min(
    step2Block.indexOf('Carbon MCP') !== -1 ? step2Block.indexOf('Carbon MCP') : Infinity,
    step2Block.indexOf('carbon-mcp') !== -1 ? step2Block.indexOf('carbon-mcp') : Infinity
  );
  assert(posCB !== -1, '"carbon-builder" not found in Step 2');
  assert(posMCP !== Infinity, '"Carbon MCP" or "carbon-mcp" not found in Step 2');
  assert(posCB < posMCP, `Expected carbon-builder (pos ${posCB}) before Carbon MCP (pos ${posMCP}) in Step 2 tier ladder`);
});

test('Step 4 Carbon verification rule uses invoke-first language', () => {
  const ruleStart = prompt.indexOf('**Carbon verification rule:**');
  assert(ruleStart !== -1, '"**Carbon verification rule:**" not found in Step 4');
  const ruleBlock = prompt.slice(ruleStart, ruleStart + 500);
  assert(
    /invoke.*carbon-builder.*skill first/i.test(ruleBlock),
    'Carbon verification rule must say "invoke the carbon-builder skill first"'
  );
  assert(
    /Before looking up any prop.*invoke.*carbon-builder/i.test(ruleBlock),
    'Carbon verification rule must contain "Before looking up any prop…invoke carbon-builder"'
  );
});

test('Step 4 Category 1 block uses MANDATORY invoke language from Carbon Migration', () => {
  const cat1Start = prompt.lastIndexOf('Category 1 — Carbon API finding');
  assert(cat1Start !== -1, '"Category 1 — Carbon API finding" not found in Step 4');
  const cat1Block = prompt.slice(cat1Start, cat1Start + 800);
  assert(
    /MANDATORY.*Invoke.*carbon-builder.*skill.*every Category 1/i.test(cat1Block),
    'Category 1 block must say "MANDATORY: Invoke the carbon-builder skill for every Category 1 recommendation"'
  );
  assert(
    /MANDATORY.*carbon-builder.*unavailable.*fall back to Carbon MCP/i.test(cat1Block),
    'Category 1 block must say "MANDATORY: If carbon-builder is unavailable, fall back to Carbon MCP"'
  );
  assert(
    /MANDATORY.*Tool unavailability.*NOT.*reason to drop/i.test(cat1Block),
    'Category 1 block must say "MANDATORY: Tool unavailability is NOT a reason to drop the finding"'
  );
});

test('prompt carbon-builder verificationSource rule precedes carbon-mcp rule', () => {
  assertMentionsBefore(
    prompt,
    '"carbon-builder"',
    '"carbon-mcp"',
    'verificationSource rules in prompt'
  );
});

// ─── reviewBundle agent rules ─────────────────────────────────────────────────
console.log('\n── reviewBundle rules: carbon-builder authority ──────────────');

// Extract the rules template literal from the bundle source
const rulesMatch = bundleSrc.match(/const rules\s*=\s*`([\s\S]*?)`\s*;/);
assert(rulesMatch, 'Could not extract rules template from reviewBundle.js');
const rulesTemplate = rulesMatch[1];

test('rules file uses TOOL FALLBACK — MANDATORY section header from Carbon Migration', () => {
  assert(
    /TOOL FALLBACK.*MANDATORY/.test(rulesTemplate),
    'rules file must use "TOOL FALLBACK — MANDATORY" section header'
  );
});

test('rules file has MANDATORY carbon-builder invocation bullet', () => {
  assert(
    /MANDATORY.*carbon-builder/.test(rulesTemplate),
    'rules file must have a MANDATORY bullet for carbon-builder invocation'
  );
});

test('rules file has MANDATORY MCP fallback bullet with exact log format', () => {
  assert(
    /carbon-builder UNAVAILABLE — MCP fallback/.test(rulesTemplate),
    'rules file must contain exact log format "carbon-builder UNAVAILABLE — MCP fallback"'
  );
});

test('rules file has MANDATORY Tier 3 model-knowledge fallback bullet', () => {
  assert(
    /CARBON SKILL\/MCP UNAVAILABLE/.test(rulesTemplate),
    'rules file must contain exact log format "CARBON SKILL/MCP UNAVAILABLE"'
  );
});

test('rules file has uptime-is-mandatory statement', () => {
  assert(
    /Uptime is mandatory/.test(rulesTemplate),
    'rules file must state "Uptime is mandatory"'
  );
});

test('rules file positions carbon-builder before Carbon MCP', () => {
  const posCB = rulesTemplate.indexOf('carbon-builder');
  const posMCP = Math.min(
    rulesTemplate.indexOf('Carbon MCP') !== -1 ? rulesTemplate.indexOf('Carbon MCP') : Infinity,
    rulesTemplate.indexOf('carbon-mcp') !== -1 ? rulesTemplate.indexOf('carbon-mcp') : Infinity
  );
  assert(posCB !== -1, '"carbon-builder" not found in agent rules');
  assert(posMCP !== Infinity, '"Carbon MCP" or "carbon-mcp" not found in agent rules');
  assert(posCB < posMCP, `Expected carbon-builder (pos ${posCB}) before Carbon MCP (pos ${posMCP}) in agent rules`);
});

test('rules file does not instruct agent to use MCP for ALL verification (old pattern)', () => {
  assert(
    !/Use Carbon MCP tools.*for ALL Carbon/.test(rulesTemplate),
    'rules file must not contain "Use Carbon MCP tools … for ALL Carbon" (old MCP-first instruction)'
  );
});

test('rules file uses "invoke the carbon-builder skill" authority language', () => {
  assert(
    /invoke.*carbon-builder.*skill/i.test(rulesTemplate),
    'rules file must contain "invoke the carbon-builder skill" authority language'
  );
});

test('rules file uses "Before making any Carbon-specific claim" authority language', () => {
  assert(
    /Before making any Carbon-specific claim/.test(rulesTemplate),
    'rules file must contain "Before making any Carbon-specific claim" (exact Carbon Migration phrasing)'
  );
});

test('rules file uses "Before looking up any prop" authority language', () => {
  assert(
    /Before looking up any prop.*invoke.*carbon-builder/i.test(rulesTemplate),
    'rules file must contain "Before looking up any prop…invoke carbon-builder" (exact Carbon Migration phrasing)'
  );
});

// ─── formatSummaryComment ─────────────────────────────────────────────────────
console.log('\n── formatSummaryComment: header text ────────────────────────');

const dummySummary = formatSummaryComment({
  agent: 'bob',
  summaryMarkdown: 'Test PR.',
  prNumber: 1,
  commitSha: 'abc1234',
  recommendation: 'looks-good',
  recommendationRationale: 'No issues found.'
});

test('summary comment header calls carbon-builder primary authority', () => {
  assert(
    /Carbon Builder skill \(primary authority\)/.test(dummySummary),
    'summary comment header must describe carbon-builder as the primary authority'
  );
});

test('summary comment header positions carbon-builder before MCP', () => {
  assertMentionsBefore(
    dummySummary,
    'Carbon Builder skill',
    'Carbon MCP',
    'summary comment header'
  );
});

test('summary comment contains <details> dropdown block', () => {
  assert(
    dummySummary.includes('<details>'),
    'summary comment must contain a <details> dropdown block'
  );
});

test('summary comment </details> appears before AI disclaimer', () => {
  const closePos = dummySummary.indexOf('</details>');
  const disclaimerPos = dummySummary.indexOf('AI agent generated');
  assert(closePos !== -1, '</details> tag must be present in summary comment');
  assert(disclaimerPos !== -1, 'AI disclaimer must be present in summary comment');
  assert(
    closePos < disclaimerPos,
    `</details> (pos ${closePos}) must appear before AI disclaimer (pos ${disclaimerPos})`
  );
});

test('summary comment <details> block is present even with no summary findings', () => {
  // dummySummary is constructed without summaryFindings or tokenUsage — worst-case probe
  assert(
    dummySummary.includes('<details>') && dummySummary.includes('</details>'),
    '<details> block must be unconditional — present even when summaryFindings is empty'
  );
});

// ─── Rule 19: documentation prose review ──────────────────────────────────────
console.log('\n── Rule 19: documentation prose review ───────────────────────');

test('prompt does not contain old "Only review SOURCE CODE files" gate', () => {
  assert(
    !/Only review SOURCE CODE files/i.test(prompt),
    'prompt must not contain the old "Only review SOURCE CODE files" gate — all changed files are now in scope'
  );
});

test('Rule 19 is documentation prose review and caps findings at nit', () => {
  const rule19Start = prompt.indexOf('Documentation prose review');
  assert(rule19Start !== -1, '"Documentation prose review" not found in prompt — Rule 19 must describe doc prose review');
  const rule19Block = prompt.slice(rule19Start, rule19Start + 400);
  assert(
    /spelling.*grammar|grammar.*spelling/i.test(rule19Block),
    'Rule 19 must specify spelling and grammar as the applicable checks'
  );
  assert(
    /nit/i.test(rule19Block),
    'Rule 19 must state that prose findings are always nit severity'
  );
});

test('severity calibration nit bullet uses generic doc prose cap with no Rule 19 Step C reference', () => {
  const severityStart = prompt.indexOf('Severity calibration');
  assert(severityStart !== -1, '"Severity calibration" not found in prompt');
  const severityBlock = prompt.slice(severityStart, severityStart + 1400);
  assert(
    /Documentation file prose findings.*nit/i.test(severityBlock),
    'nit bullet must state "Documentation file prose findings … are always nit"'
  );
  assert(
    !/Rule 19 Step C/i.test(severityBlock),
    'severity calibration block must not reference "Rule 19 Step C" — old language must be removed'
  );
});

// ─── Linked issue / PR description scope prohibition ─────────────────────────
console.log('\n── Linked issue scope prohibition ────────────────────────────');

test('prompt prohibits using linked issue or PR description to assess completeness', () => {
  assert(
    /Do not use the linked issue context or the PR description to assess whether the PR is complete/i.test(prompt),
    'prompt must prohibit using linked issue context or PR description to assess PR completeness'
  );
});

test('linked issue prohibition permits use as background context for individual code changes', () => {
  const prohibitionPos = prompt.indexOf('Do not use the linked issue context');
  assert(prohibitionPos !== -1, 'linked issue prohibition not found');
  const prohibitionBlock = prompt.slice(prohibitionPos, prohibitionPos + 300);
  assert(
    /background context.*individual code changes/i.test(prohibitionBlock),
    'prohibition must explicitly permit use as background context when evaluating individual code changes'
  );
});

// ─── Rule 9b: unbalanced string literal ───────────────────────────────────────
console.log('\n── Rule 9b: unbalanced string literal ────────────────────────');

test('prompt contains rule 9b unbalanced string literal check', () => {
  assert(
    /unbalanced string literal/i.test(prompt),
    'prompt must contain rule 9b unbalanced string literal check'
  );
});

test('rule 9b is positioned inside the per-file rubric block (after rule 9, before rule 10)', () => {
  const rule9Pos = prompt.indexOf('9. **TypeScript');
  const rule9bPos = prompt.indexOf('9b. **Unbalanced string literal');
  const rule10Pos = prompt.indexOf('10. **Unsafe ID');
  assert(rule9Pos !== -1, 'rule 9 not found');
  assert(rule9bPos !== -1, 'rule 9b not found');
  assert(rule10Pos !== -1, 'rule 10 not found');
  assert(rule9Pos < rule9bPos, `rule 9 (${rule9Pos}) must appear before rule 9b (${rule9bPos})`);
  assert(rule9bPos < rule10Pos, `rule 9b (${rule9bPos}) must appear before rule 10 (${rule10Pos})`);
});

test('rule 9b specifies blocking severity', () => {
  const rule9bPos = prompt.indexOf('9b. **Unbalanced string literal');
  assert(rule9bPos !== -1, 'rule 9b not found');
  const rule9bBlock = prompt.slice(rule9bPos, rule9bPos + 600);
  assert(
    /blocking/i.test(rule9bBlock),
    'rule 9b must assign blocking severity'
  );
});

test('rule 9b lists all required do-not-flag guards', () => {
  const rule9bPos = prompt.indexOf('9b. **Unbalanced string literal');
  assert(rule9bPos !== -1, 'rule 9b not found');
  const rule9bBlock = prompt.slice(rule9bPos, rule9bPos + 1200);
  assert(/template literal|backtick/i.test(rule9bBlock), 'rule 9b must guard against template literals');
  assert(/escaped quote/i.test(rule9bBlock), 'rule 9b must guard against escaped quotes');
  assert(/apostrophe|double-quoted/i.test(rule9bBlock), 'rule 9b must guard against apostrophes in opposite-quote strings');
  assert(/comment/i.test(rule9bBlock), 'rule 9b must guard against comment lines');
  assert(/multi-line|spans multiple/i.test(rule9bBlock), 'rule 9b must guard against multi-line strings');
});

test('NO-FINDINGS paragraph includes rule 9b exception', () => {
  const noFindingsPos = prompt.indexOf('NO-FINDINGS [filename]');
  assert(noFindingsPos !== -1, 'NO-FINDINGS paragraph not found');
  // Use 1600 chars to ensure the rule 9b exception at the end of the paragraph is captured
  const noFindingsBlock = prompt.slice(noFindingsPos, noFindingsPos + 1600);
  assert(
    /unbalanced string literal.*rule 9b|rule 9b.*unbalanced string literal/i.test(noFindingsBlock),
    'NO-FINDINGS paragraph must include the rule 9b unbalanced string literal exception'
  );
});

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  process.exit(1);
} else {
  console.log('✅ All carbon-builder authority tests passed!');
}
