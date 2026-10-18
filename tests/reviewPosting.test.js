/**
 * Offline tests for what a review posts, using the fake Bob and the mock GitHub
 * server (tests/fixtures/concurrencyHarness.js). Three PRs differ only in the
 * fixture's severity: nit (green), the default major (yellow) and blocking (red).
 *
 *  1. Green: one short issue comment with the nit list, no review, one label
 *  2. Yellow and red: one COMMENT review carrying the inline comment, no per-comment
 *     writes, and the full summary comment
 *  3. A review GitHub rejects with 422 falls back to one write per comment
 *  4. An attempt_completion fallback (looks-good with a reliability warning) gets the full comment
 *  5. Inline posting disabled: the mapped finding goes to the summary
 */

const assert = require('assert');
const { parseReviewOutput } = require('../src/reviewParser');
const { runBatch } = require('./fixtures/concurrencyHarness');

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
  console.log('\nReview posting tests\n');

  const batch = await runBatch({
    prNumbers: [1, 2, 3, 4],
    concurrency: 1,
    fixtures: {
      1: { severity: 'nit' },
      2: {},
      3: { severity: 'blocking' },
      4: { source: 'review-completion' },
    },
  });

  await test('a clean PR gets one short comment with the nit list, no review and one label', () => {
    assert.strictEqual(batch.comments(1).length, 1);
    const body = batch.comments(1)[0].body.body;
    assert.ok(
      body.startsWith(
        '[AI agent review — Carbon grounded] · **Looks Good** · Reviewed by: IBM Bob · Commit: sha1\n\n'
      ),
      body
    );
    assert.ok(body.includes('<summary>1 optional nit</summary>'), body);
    assert.ok(
      body.includes(
        '`packages/react/src/components/Button/Button.stories.js:42`'
      )
    );
    for (const absent of [
      '## Recommendation',
      '| Area',
      'Token',
      'Review artifacts',
    ]) {
      assert.ok(!body.includes(absent), `${absent} in the clean comment`);
    }
    assert.strictEqual(batch.reviews(1).length, 0);
    assert.strictEqual(batch.inlineComments(1).length, 0);
    assert.strictEqual(batch.labels(1).length, 1);
  });

  await test('a yellow PR gets one review with the inline comment and the full summary', () => {
    assert.strictEqual(batch.reviews(2).length, 1);
    const review = batch.reviews(2)[0].body;
    assert.strictEqual(review.event, 'COMMENT');
    assert.strictEqual(review.commit_id, 'sha2');
    assert.strictEqual(review.body, undefined, 'no review body');
    assert.deepStrictEqual(
      review.comments.map(({ path, position }) => ({ path, position })),
      [{ path: 'Button.stories.js', position: 3 }]
    );
    assert.strictEqual(
      batch.inlineComments(2).length,
      0,
      'no per-comment writes'
    );
    assert.strictEqual(batch.comments(2).length, 1);
    const body = batch.comments(2)[0].body.body;
    assert.ok(body.includes('**Suggested Improvements**'), body);
    assert.ok(body.includes('## Recommendation'));
    assert.ok(body.includes('- Inline comments: 1\n'));
    assert.strictEqual(batch.labels(2).length, 1);
  });

  await test('a red PR gets the same review and a Consider Revising summary', () => {
    assert.strictEqual(batch.reviews(3).length, 1);
    const review = batch.reviews(3)[0].body;
    assert.strictEqual(review.event, 'COMMENT');
    assert.strictEqual(review.commit_id, 'sha3');
    assert.strictEqual(review.body, undefined, 'no review body');
    assert.deepStrictEqual(
      review.comments.map(({ path, position }) => ({ path, position })),
      [{ path: 'Button.stories.js', position: 3 }]
    );
    assert.strictEqual(batch.inlineComments(3).length, 0);
    const body = batch.comments(3)[0].body.body;
    assert.ok(body.includes('**Consider Revising**'), body);
    assert.ok(body.includes('- Inline comments: 1\n'));
  });

  await test('an unreliable looks-good (attempt_completion) keeps the full comment and its warning', () => {
    const warn = console.warn;
    console.warn = () => {};
    const parsed = parseReviewOutput(
      'x\n[attempt_completion] Result: All fine.'
    );
    console.warn = warn;
    assert.strictEqual(parsed.recommendation, 'looks-good');
    assert.ok(parsed.catalogueWarning, 'the parser sets a warning');
    assert.strictEqual(batch.comments(4).length, 1);
    const body = batch.comments(4)[0].body.body;
    assert.ok(body.includes('**Review Reliability Note:**'), body);
    assert.ok(body.includes('## Recommendation'), body);
    assert.ok(
      !body.startsWith(
        '[AI agent review — Carbon grounded] · **Looks Good** · Reviewed by'
      )
    );
    assert.strictEqual(batch.reviews(4).length, 0);
  });

  await test('the log counts inline, summary and nit findings', () => {
    const text = batch.lines.map((l) => l.text).join('\n');
    assert.ok(text.includes('Inline: 0, Summary: 0, Nits: 1'));
    assert.ok(text.includes('Inline: 1, Summary: 0, Nits: 0'));
    assert.ok(text.includes('Posted one review with 1 inline comment(s)'));
  });
  await batch.cleanup();

  const rejected = await runBatch({
    prNumbers: [2],
    concurrency: 1,
    rejectReviews: true,
    fixtures: { 2: {} },
  });

  await test('a 422 on the review falls back to one write per comment, summary unchanged', () => {
    assert.strictEqual(
      rejected.reviews(2).length,
      1,
      'tried once, not retried'
    );
    assert.strictEqual(rejected.inlineComments(2).length, 1);
    const single = rejected.inlineComments(2)[0].body;
    assert.strictEqual(single.path, 'Button.stories.js');
    assert.strictEqual(single.position, 3);
    assert.strictEqual(single.commit_id, 'sha2');
    assert.strictEqual(rejected.comments(2).length, 1);
    assert.ok(
      rejected.comments(2)[0].body.body.includes('- Inline comments: 1\n')
    );
    const text = rejected.lines.map((l) => l.text).join('\n');
    assert.ok(text.includes('Grouped review rejected (422:'), text);
    assert.strictEqual(rejected.labels(2).length, 1);
  });
  await rejected.cleanup();

  // The inline kill switch moves mapped findings into the summary instead of dropping them.
  process.env.GITHUB_AI_AGENT_POST_INLINE_COMMENTS = 'false';
  let disabled;
  try {
    disabled = await runBatch({
      prNumbers: [2],
      concurrency: 1,
      fixtures: { 2: {} },
    });
  } finally {
    delete process.env.GITHUB_AI_AGENT_POST_INLINE_COMMENTS;
  }

  await test('with inline posting disabled the finding lands in the summary, not nowhere', () => {
    assert.strictEqual(disabled.reviews(2).length, 0);
    assert.strictEqual(disabled.inlineComments(2).length, 0);
    assert.strictEqual(disabled.comments(2).length, 1);
    const body = disabled.comments(2)[0].body.body;
    assert.ok(body.includes('## Additional Findings'), body);
    assert.ok(!body.includes('- Inline comments:'), body);
    const text = disabled.lines.map((l) => l.text).join('\n');
    assert.ok(
      text.includes(
        'Inline comments disabled, including 1 finding(s) in the summary'
      ),
      text
    );
    assert.strictEqual(disabled.labels(2).length, 1);
  });
  await disabled.cleanup();

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
