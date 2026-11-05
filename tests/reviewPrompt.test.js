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
 *  9. The Looks Good comment: exact text with and without nits
 * 10. formatSummaryComment lists nits between Summary and Details, never in Additional Findings
 * 11. The agent prompt is byte-identical per agent
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { escapeAtSign } = require('../src/textUtils');
const {
  formatInlineComment,
  formatSummaryComment,
  formatLooksGoodComment,
  formatNotReviewedComment,
  buildReviewPrompt,
} = require('../src/reviewPrompt');
const agents = require('../src/agents');

const ZWS = '\u200B'; // zero-width space inserted by escapeAtSign
const INLINE_PROMPT = '_Rate this finding 👍 / 👎. Replies help us improve._';
const SUMMARY_PROMPT =
  '_Was this review helpful? React with 👍 / 👎, or reply with feedback._';

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

  // ── 9. The Looks Good comment ───────────────────────────────────────────────
  const verdict =
    '[AI agent review — Carbon grounded] · **Looks Good** · Reviewed by: Claude · Commit: abc1234';
  const nit = (title, file, line) => ({
    severity: 'nit',
    title,
    file,
    line,
    body: 'Nit body that must not be shown.',
  });

  await test('the Looks Good comment without nits is the verdict line and the summary', () => {
    const result = formatLooksGoodComment({
      agent: 'claude',
      agentName: 'Claude',
      summaryMarkdown: 'Small, safe change.',
      commitSha: 'abc1234def5678',
    });
    assert.strictEqual(result, `${verdict}\n\nSmall, safe change.\n`);
  });

  await test('the Looks Good comment with nits adds one collapsed list and nothing else', () => {
    const result = formatLooksGoodComment({
      agent: 'claude',
      agentName: 'Claude',
      summaryMarkdown: 'Small, safe change.',
      commitSha: 'abc1234def5678',
      nitFindings: [
        nit('Prefer a token over @media literal', 'src/a.scss', 12),
        nit('Rename the story', 'src/b.stories.js', 40),
      ],
    });
    assert.strictEqual(
      result,
      `${verdict}\n\nSmall, safe change.\n\n` +
        '<details>\n<summary>2 optional nits</summary>\n\n' +
        `- Prefer a token over @${ZWS}media literal — \`src/a.scss:12\`\n` +
        '- Rename the story — `src/b.stories.js:40`\n\n</details>\n'
    );
    for (const absent of [
      '## Recommendation',
      '| Area',
      'Token',
      'Review artifacts',
      'Nit body',
    ]) {
      assert.ok(!result.includes(absent), `${absent} in the quiet comment`);
    }
  });

  await test('one nit reads "1 optional nit", and a nit without a line has no colon', () => {
    const result = formatLooksGoodComment({
      agent: 'claude',
      summaryMarkdown: 'Fine.',
      commitSha: 'abc1234def5678',
      nitFindings: [nit('Whole-file remark', 'src/c.js', undefined)],
    });
    assert.ok(result.includes('<summary>1 optional nit</summary>'));
    assert.ok(result.includes('- Whole-file remark — `src/c.js`\n'));
    assert.ok(
      result.includes('Reviewed by: claude'),
      'name defaults to the id'
    );
  });

  await test('the Looks Good comment escapes @word in the summary', () => {
    const result = formatLooksGoodComment({
      agent: 'bob',
      summaryMarkdown: 'The @if block is fine.',
      commitSha: 'abc1234def5678',
    });
    assert.ok(result.includes(`@${ZWS}if`));
  });

  // ── 10. Nits in the full summary comment ────────────────────────────────────
  const summaryArgs = {
    agent: 'bob',
    agentName: 'IBM Bob',
    summaryMarkdown: 'One finding and a nit.',
    prNumber: 42,
    commitSha: 'abc1234def',
    recommendation: 'suggested-improvements',
    summaryFindings: [
      {
        title: 'Unmapped finding',
        severity: 'minor',
        file: 'a.scss',
        body: 'Body.',
      },
    ],
    nitFindings: [nit('Rename the story', 'src/b.stories.js', 40)],
  };

  await test('formatSummaryComment places the nit block between Summary and Details', () => {
    const result = formatSummaryComment(summaryArgs);
    const summaryAt = result.indexOf('## Summary');
    const nitAt = result.indexOf('<summary>1 optional nit</summary>');
    const detailsAt = result.indexOf('<summary>Details</summary>');
    assert.ok(summaryAt >= 0 && nitAt > summaryAt, 'nit block after Summary');
    assert.ok(detailsAt > nitAt, 'nit block before the Details block');
    assert.ok(result.includes('- Rename the story — `src/b.stories.js:40`'));
  });

  await test('nits stay out of Additional Findings and the artifact counts', () => {
    const result = formatSummaryComment(summaryArgs);
    const additional = result.slice(result.indexOf('## Additional Findings'));
    assert.ok(!additional.includes('Rename the story'));
    assert.ok(result.includes('- Summary findings: 1\n'));
    assert.ok(!result.includes('Inline comments:'));
  });

  await test('a yellow review with nits keeps the full layout', () => {
    const result = formatSummaryComment(summaryArgs);
    for (const present of [
      '## Recommendation',
      'Reviewed by: IBM Bob',
      'Review artifacts:',
      'An AI agent generated this review.',
    ]) {
      assert.ok(result.includes(present), `${present} missing`);
    }
  });

  await test('a nit is listed once: the findings table skips nit rows', () => {
    const result = formatSummaryComment({
      ...summaryArgs,
      findingsTable: [
        {
          area: 'General',
          category: 'Cat 2',
          severity: 'major',
          title: 'Real problem',
          file: 'a.js',
        },
        {
          area: 'General',
          category: 'Cat 2',
          severity: 'nit',
          title: 'Rename the story',
          file: 'src/b.stories.js',
        },
      ],
    });
    assert.ok(result.includes('<summary>Findings (1)</summary>'));
    assert.strictEqual(result.split('Rename the story').length - 1, 1);

    const onlyNits = formatSummaryComment({
      ...summaryArgs,
      findingsTable: [
        { severity: 'nit', title: 'Rename the story', file: 'x.js' },
      ],
    });
    assert.ok(!onlyNits.includes('<summary>Findings'));
  });

  await test('the nit list cannot be closed or broken by a title or path', () => {
    const result = formatLooksGoodComment({
      agent: 'bob',
      summaryMarkdown: 'Fine.',
      commitSha: 'abc1234def5678',
      nitFindings: [nit('Close </details> early', 'src/we`ird.js', 3)],
    });
    assert.strictEqual(result.split('</details>').length - 1, 1);
    assert.ok(
      result.includes('- Close &lt;/details> early — `src/weird.js:3`')
    );
  });

  await test('formatSummaryComment without nits is unchanged by the nit block', () => {
    const { nitFindings, ...rest } = summaryArgs;
    const result = formatSummaryComment(rest);
    assert.ok(!result.includes('optional nit'));
    assert.ok(
      result.includes(
        `One finding and a nit.\n\n${SUMMARY_PROMPT}\n\n\n<details>`
      )
    );
  });

  await test('the summary feedback line sits before Details, so it shows collapsed', () => {
    const result = formatSummaryComment(summaryArgs);
    const at = result.indexOf(SUMMARY_PROMPT);
    assert.ok(at > result.indexOf('## Summary'));
    assert.ok(at < result.indexOf('<summary>Details</summary>'));
    assert.strictEqual(result.split(SUMMARY_PROMPT).length - 1, 1);
  });

  await test('an inline comment ends with the feedback line, after the verification badge', () => {
    const result = formatInlineComment({
      title: 'Missing label',
      severity: 'major',
      body: 'Add an aria-label.',
      carbonVerified: true,
      verificationSource: 'carbon-mcp',
    });
    assert.ok(
      result.endsWith(`*✓ Verified with Carbon MCP*\n\n${INLINE_PROMPT}\n`)
    );
    assert.strictEqual(result.split(INLINE_PROMPT).length - 1, 1);
  });

  await test('the Looks Good comment carries no feedback line', () => {
    const result = formatLooksGoodComment({
      agent: 'bob',
      summaryMarkdown: 'Fine.',
      commitSha: 'abc1234def5678',
      nitFindings: [nit('Rename the story', 'src/b.stories.js', 40)],
    });
    assert.ok(!result.includes('👍'));
  });

  await test('the Not Reviewed comment carries no feedback line', () => {
    const result = formatNotReviewedComment({
      commitSha: 'abc1234def5678',
      coverage: {
        partial: true,
        diff_chars_reviewed: 0,
        files_reviewed: 0,
        files_total: 1,
        omitted: [],
      },
      filesUrl: 'https://example.test/files',
    });
    assert.ok(!result.includes('👍'));
  });

  // ── 11. Prompt per agent ─────────────────────────────────────────────────────
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
