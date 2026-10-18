/**
 * Tests for src/reviewPrompt.js — escapeAtSign helper and its application
 * across formatInlineComment and formatSummaryComment.
 *
 * Covers:
 *  1. escapeAtSign escapes @word in plain text
 *  2. escapeAtSign does NOT escape @ inside backtick code spans
 *  3. escapeAtSign handles null/undefined safely
 *  4. escapeAtSign handles text with no @ signs unchanged
 *  5. formatInlineComment escapes @word in title and body
 *  6. formatSummaryComment escapes @word in summaryMarkdown
 *  7. formatSummaryComment escapes @word in summaryFindings title and body
 *  8. formatSummaryComment escapes @word in findingsTable row.title
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { escapeAtSign } = require('../src/textUtils');
const {
  formatInlineComment,
  formatSummaryComment,
  buildReviewPrompt,
} = require('../src/reviewPrompt');
const agents = require('../src/agents');

const ZWS = '\u200B'; // zero-width space inserted by escapeAtSign

let passed = 0;
let failed = 0;

async function test(description, fn) {
  try {
    await fn();
    console.log(`  ✅ ${description}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ ${description}`);
    console.error(`     ${err.message}`);
    failed++;
  }
}

async function main() {
  console.log('\n🔤 reviewPrompt escapeAtSign tests\n');

  // ── 1. Escapes @word in plain text ──────────────────────────────────────────
  await test('escapeAtSign inserts zero-width space after @ before a word char', () => {
    const result = escapeAtSign(
      'The @if flags.enabled block sets border: none'
    );
    assert.ok(
      result.includes(`@${ZWS}if`),
      `Expected @${ZWS}if but got: ${result}`
    );
    assert.ok(!result.includes('@if'), 'Raw @if must not remain');
  });

  // ── 2. Does not escape @ inside backtick code spans ─────────────────────────
  await test('escapeAtSign leaves @ inside backtick spans untouched', () => {
    const input = 'Use `@if` or `@mixin` in SCSS';
    const result = escapeAtSign(input);
    // The backtick segments must be byte-for-byte identical
    assert.ok(
      result.includes('`@if`'),
      '`@if` inside backticks must be preserved as-is'
    );
    assert.ok(
      result.includes('`@mixin`'),
      '`@mixin` inside backticks must be preserved as-is'
    );
    // No ZWS should appear inside a code span
    assert.ok(
      !result.includes(`\`@${ZWS}`),
      'No ZWS should appear inside backtick spans'
    );
  });

  // ── 3. Handles null and undefined safely ────────────────────────────────────
  await test('escapeAtSign returns null/undefined unchanged without throwing', () => {
    assert.strictEqual(escapeAtSign(null), null, 'null must pass through');
    assert.strictEqual(
      escapeAtSign(undefined),
      undefined,
      'undefined must pass through'
    );
    assert.strictEqual(escapeAtSign(''), '', 'empty string must pass through');
  });

  // ── 4. Leaves text with no @ signs unchanged ────────────────────────────────
  await test('escapeAtSign does not mutate text that contains no @ signs', () => {
    const input = 'The selector applies to cds-select globally.';
    assert.strictEqual(
      escapeAtSign(input),
      input,
      'No-@ text must be returned unchanged'
    );
  });

  // ── 5. formatInlineComment escapes @word in title and body ──────────────────
  await test('formatInlineComment escapes @word in finding title and body', () => {
    const finding = {
      title: 'v12 @if block applies globally',
      severity: 'major',
      body: 'The @if flags.enabled block inside :host sets border: none for every instance.',
      carbonVerified: false,
      verificationSource: 'not-carbon-specific',
    };
    const result = formatInlineComment(finding);

    assert.ok(
      result.includes(`@${ZWS}if`),
      'title: @if must be escaped in inline comment'
    );
    assert.ok(
      !result.includes(' @if '),
      'body: raw @if must not appear in inline comment'
    );
  });

  // ── 6. formatSummaryComment escapes @word in summaryMarkdown ────────────────
  await test('formatSummaryComment escapes @word in summaryMarkdown', () => {
    const result = formatSummaryComment({
      agent: 'bob',
      summaryMarkdown:
        'PR adds @if flags.enabled blocks that apply globally to cds-select.',
      prNumber: 42,
      commitSha: 'abc1234def',
      recommendation: 'looks-good',
    });

    assert.ok(
      result.includes(`@${ZWS}if`),
      'summaryMarkdown: @if must be escaped in summary comment'
    );
    assert.ok(
      !result.includes(' @if '),
      'summaryMarkdown: raw @if must not appear unescaped'
    );
  });

  // ── 7. formatSummaryComment escapes @word in summaryFindings title and body ──
  await test('formatSummaryComment escapes @word in summaryFindings title and body', () => {
    const result = formatSummaryComment({
      agent: 'bob',
      summaryMarkdown: 'One finding.',
      prNumber: 42,
      commitSha: 'abc1234def',
      recommendation: 'consider-revising',
      summaryFindings: [
        {
          title: '@mixin applies without scope',
          severity: 'major',
          file: 'select.scss',
          body: 'The @include reset mixin runs for all cds-select instances.',
          carbonVerified: false,
          verificationSource: 'not-carbon-specific',
        },
      ],
    });

    assert.ok(
      result.includes(`@${ZWS}mixin`),
      'summaryFindings title: @mixin must be escaped'
    );
    assert.ok(
      result.includes(`@${ZWS}include`),
      'summaryFindings body: @include must be escaped'
    );
  });

  // ── 8. formatSummaryComment escapes @word in findingsTable row.title ─────────
  await test('formatSummaryComment escapes @word in findingsTable row.title', () => {
    const result = formatSummaryComment({
      agent: 'bob',
      summaryMarkdown: 'One finding.',
      prNumber: 42,
      commitSha: 'abc1234def',
      recommendation: 'consider-revising',
      findingsTable: [
        {
          area: 'General',
          category: 'Cat 2',
          severity: 'major',
          title: '@if block scope too broad',
          file: 'select.scss',
        },
      ],
    });

    assert.ok(
      result.includes(`@${ZWS}if`),
      'findingsTable row.title: @if must be escaped in table cell'
    );
  });

  // ── 9. Prompt per agent ─────────────────────────────────────────────────────
  const target = { owner: 'carbon-design-system', repo: 'carbon' };
  // Generated from the code at commit d17acc5, before the fragments existed.
  const snapshot = fs.readFileSync(
    path.join(__dirname, 'fixtures', 'prompt', 'bob-review-prompt.md'),
    'utf8'
  );

  await test('Bob prompt is byte-identical to the committed snapshot', () => {
    assert.ok(buildReviewPrompt({ ...target, agent: 'bob' }) === snapshot);
  });

  await test('the prompt defaults to Bob when no agent is passed', () => {
    assert.ok(buildReviewPrompt(target) === snapshot);
  });

  await test('an unknown agent throws', () => {
    assert.throws(() => buildReviewPrompt({ ...target, agent: 'nope' }));
  });

  await test('Claude prompt carries the four Claude fragments on the expected lines', () => {
    const f = agents.get('claude').promptFragments;
    const lines = buildReviewPrompt({ ...target, agent: 'claude' }).split('\n');
    const at = (needle) => lines.filter((l) => l.includes(needle));
    const contract = at(`${f.noCompletion} at any point`);
    assert.strictEqual(contract.length, 1);
    assert.ok(contract[0].startsWith('2. '));
    const writes = at(`${f.noFileWrite} at any point.`);
    assert.strictEqual(writes.length, 1);
    assert.ok(writes[0].startsWith('5. '));
    const output = at(`${f.noCompletion}, do not write any prose`);
    assert.strictEqual(output.length, 1);
    assert.ok(output[0].startsWith('Your ONLY structured output'));
    const verified = at(`(any file under ${f.skillPath})`);
    assert.strictEqual(verified.length, 1);
    assert.ok(verified[0].indexOf('"carbon-builder"') >= 0);
    const read = at(
      `explicit ${f.readTool} call to ${f.skillPath}SKILL.md or another file under ${f.skillPath} visible`
    );
    assert.strictEqual(read.length, 1);
    assert.ok(read[0].startsWith('- "carbon-builder": verified'));
  });

  await test('Claude prompt names no Bob tool or Bob path', () => {
    const prompt = buildReviewPrompt({ ...target, agent: 'claude' });
    for (const banned of [
      'attempt_completion',
      'write_to_file',
      'read_file',
      '.bob/skills',
    ]) {
      assert.ok(!prompt.includes(banned), `${banned} in the Claude prompt`);
    }
  });

  await test('Claude and Bob prompts differ only on the fragment lines', () => {
    const bobLines = snapshot.split('\n');
    const claudeLines = buildReviewPrompt({ ...target, agent: 'claude' }).split(
      '\n'
    );
    assert.strictEqual(claudeLines.length, bobLines.length);
    const changed = bobLines.filter((l, i) => l !== claudeLines[i]);
    assert.strictEqual(changed.length, 5);
  });

  // ── Summary ──────────────────────────────────────────────────────────────────
  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
