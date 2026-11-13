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
  buildReviewPrompt,
  RESOLUTION_SPEC_PROMPT,
  renderResolutionSpec,
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
      '## Recommendations and Resolution SPEC.md',
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
    assert.ok(result.includes('One finding and a nit.\n\n\n<details>'));
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

  // ── 12. Resolution SPEC.md in formatSummaryComment ──────────────────────────
  console.log('\n── 12. Resolution SPEC.md ──────────────────────────────────');

  await test('formatSummaryComment uses heading "## Recommendations and Resolution SPEC.md"', () => {
    const result = formatSummaryComment({
      agent: 'bob',
      summaryMarkdown: 'No findings.',
      prNumber: 1,
      commitSha: 'abcdef123456',
      recommendation: 'looks-good',
    });
    assert.ok(result.includes('## Recommendations and Resolution SPEC.md'));
  });

  await test('SPEC block is absent when there are no findings above nit', () => {
    const result = formatSummaryComment({
      agent: 'bob',
      summaryMarkdown: 'Only nits.',
      prNumber: 1,
      commitSha: 'abcdef123456',
      nitFindings: [nit('Nit title', 'src/a.js', 10)],
    });
    assert.ok(!result.includes('<summary>Resolution SPEC.md'));
    assert.ok(!result.includes('```markdown\n# Resolution SPEC'));
  });

  await test('SPEC block is present with one major finding', () => {
    const result = formatSummaryComment({
      agent: 'bob',
      summaryMarkdown: 'One issue.',
      prNumber: 42,
      commitSha: 'abcdef123456',
      owner: 'carbon-design-system',
      repo: 'carbon',
      inlineFindings: [
        {
          title: 'Incorrect prop name',
          severity: 'major',
          file: 'packages/react/src/components/Button/Button.js',
          line: 42,
          body: 'Use kind instead of variant.',
          verificationSource: 'carbon-builder',
          mcpEvidence: 'Button prop kind accepts primary, secondary',
        },
      ],
    });

    assert.ok(
      result.includes(
        '<details>\n<summary>Resolution SPEC.md — copy into your IDE agent</summary>'
      )
    );
    assert.ok(
      result.includes(
        '# Resolution SPEC for carbon-design-system/carbon#42 (commit abcdef1)'
      )
    );
    assert.ok(result.includes('### 1. [major] Incorrect prop name'));
    assert.ok(
      result.includes(
        '- File: packages/react/src/components/Button/Button.js:42'
      )
    );
    assert.ok(
      result.includes('- Category: 1 (verified via Carbon Builder skill)')
    );
    assert.ok(
      result.includes(
        '- Evidence: "Button prop kind accepts primary, secondary"'
      )
    );
    assert.ok(result.includes('- Use kind instead of variant.'));
  });

  await test('SPEC ordering: blocking -> major -> minor; inline before summary-only within severity', () => {
    const inlineFindings = [
      {
        title: 'Minor inline',
        severity: 'minor',
        file: 'src/minor-inline.js',
        line: 1,
        body: 'Minor inline body',
      },
      {
        title: 'Blocking inline',
        severity: 'blocking',
        file: 'src/block-inline.js',
        line: 2,
        body: 'Block inline body',
      },
    ];
    const summaryFindings = [
      {
        title: 'Major summary',
        severity: 'major',
        file: 'src/major-summary.js',
        body: 'Major summary body',
      },
      {
        title: 'Blocking summary',
        severity: 'blocking',
        file: 'src/block-summary.js',
        body: 'Block summary body',
      },
    ];

    const result = formatSummaryComment({
      agent: 'bob',
      summaryMarkdown: 'Four findings.',
      prNumber: 10,
      commitSha: '1234567890ab',
      inlineFindings,
      summaryFindings,
    });

    const f1 = result.indexOf('### 1. [blocking] Blocking inline');
    const f2 = result.indexOf('### 2. [blocking] Blocking summary');
    const f3 = result.indexOf('### 3. [major] Major summary');
    const f4 = result.indexOf('### 4. [minor] Minor inline');

    assert.ok(f1 >= 0, 'f1 found');
    assert.ok(f2 > f1, 'f2 after f1');
    assert.ok(f3 > f2, 'f3 after f2');
    assert.ok(f4 > f3, 'f4 after f3');

    // Check file formatting when line is missing
    assert.ok(result.includes('- File: src/major-summary.js\n'));
    assert.ok(result.includes('- File: src/block-inline.js:2\n'));
  });

  await test('SPEC verificationSource handling: carbon-builder vs carbon-mcp vs Category 2', () => {
    const result = formatSummaryComment({
      agent: 'bob',
      summaryMarkdown: 'Check categories.',
      prNumber: 99,
      commitSha: '999999999999',
      summaryFindings: [
        {
          title: 'Skill verified',
          severity: 'major',
          file: 'src/a.js',
          verificationSource: 'carbon-builder',
          mcpEvidence: 'Evidence from builder',
          body: 'Fix a.',
        },
        {
          title: 'MCP verified',
          severity: 'major',
          file: 'src/b.js',
          verificationSource: 'carbon-mcp',
          mcpEvidence: 'Evidence from MCP',
          body: 'Fix b.',
        },
        {
          title: 'Diff finding',
          severity: 'major',
          file: 'src/c.js',
          verificationSource: 'not-carbon-specific',
          mcpEvidence: 'Ignored evidence',
          body: 'Fix c.',
        },
      ],
    });

    assert.ok(
      result.includes(
        '### 1. [major] Skill verified\n- File: src/a.js\n- Category: 1 (verified via Carbon Builder skill)\n- Evidence: "Evidence from builder"\n- Fix a.'
      )
    );
    assert.ok(
      result.includes(
        '### 2. [major] MCP verified\n- File: src/b.js\n- Category: 1 (verified via Carbon MCP)\n- Evidence: "Evidence from MCP"\n- Fix b.'
      )
    );
    assert.ok(
      result.includes(
        '### 3. [major] Diff finding\n- File: src/c.js\n- Category: 2 (from the diff)\n- Fix c.'
      )
    );
    assert.ok(!result.includes('Ignored evidence'));
  });

  await test('SPEC escapes backtick lines and @word in title and body', () => {
    const result = formatSummaryComment({
      agent: 'bob',
      summaryMarkdown: 'Escaping test.',
      prNumber: 5,
      commitSha: '555555555555',
      summaryFindings: [
        {
          title: 'The @mixin problem',
          severity: 'minor',
          file: 'src/mix.scss',
          body: 'Check this code:\n```scss\n@include reset;\n```\nDone.',
        },
      ],
    });

    assert.ok(result.includes(`### 1. [minor] The @${ZWS}mixin problem`));
    // The ```scss and ``` lines are replaced by ~~~scss and ~~~ so they do not close the markdown fence
    assert.ok(result.includes('~~~scss\n'));
    assert.ok(result.includes(`@${ZWS}include reset;\n~~~`));
    // Must not have unescaped ``` inside the finding
    const specBlock = result.substring(
      result.indexOf('```markdown'),
      result.indexOf('```\n\n</details>')
    );
    assert.ok(!specBlock.includes('\n```scss'));
  });

  await test('SPEC title line falls back to #prNumber when owner or repo is omitted', () => {
    const result = formatSummaryComment({
      agent: 'bob',
      summaryMarkdown: 'No owner/repo.',
      prNumber: 77,
      commitSha: '777777777777',
      summaryFindings: [
        {
          title: 'Finding',
          severity: 'minor',
          file: 'a.js',
          body: 'Fix.',
        },
      ],
    });
    assert.ok(result.includes('# Resolution SPEC for #77 (commit 7777777)'));
  });

  await test('Size guard step 1: drops Evidence when comment exceeds 60,000 characters', () => {
    // Construct findings with large evidence such that with evidence > 60k, without evidence < 60k
    const longEvidence = 'E'.repeat(2000);
    const findings = [];
    for (let i = 0; i < 20; i++) {
      findings.push({
        title: `Finding ${i}`,
        severity: 'major',
        file: `src/file${i}.js`,
        verificationSource: 'carbon-builder',
        mcpEvidence: longEvidence,
        body: 'Short body.',
      });
    }

    const result = formatSummaryComment({
      agent: 'bob',
      summaryMarkdown: 'M'.repeat(25000),
      prNumber: 1,
      commitSha: '111111111111',
      summaryFindings: findings,
    });

    assert.ok(
      result.length <= 60000,
      `Result length should be <= 60000, got ${result.length}`
    );
    assert.ok(result.includes('<summary>Resolution SPEC.md'));
    assert.ok(result.includes('### 1. [major] Finding 0'));
    // Evidence lines dropped
    assert.ok(!result.includes('- Evidence:'));
  });

  await test('Size guard step 2: replaces SPEC with omission notice when still exceeding 60,000 characters', () => {
    // Construct huge bodies so comment > 60k even without evidence
    const longBody = 'B'.repeat(4000);
    const findings = [];
    for (let i = 0; i < 20; i++) {
      findings.push({
        title: `Finding ${i}`,
        severity: 'major',
        file: `src/file${i}.js`,
        body: longBody,
      });
    }

    const result = formatSummaryComment({
      agent: 'bob',
      summaryMarkdown: 'Summary',
      prNumber: 1,
      commitSha: '111111111111',
      summaryFindings: findings,
    });

    assert.ok(
      result.includes(
        "<details>\n<summary>Resolution SPEC.md — copy into your IDE agent</summary>\n\n_Resolution SPEC omitted: comment would exceed GitHub's size limit (20 findings)._\n\n</details>"
      )
    );
    assert.ok(!result.includes('```markdown'));
  });

  // ── Summary ──────────────────────────────────────────────────────────────────
  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
