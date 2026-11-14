/**
 * Offline caic reviews through the fake Bob and the mock GitHub server
 * (tests/fixtures/concurrencyHarness.js): what a carbon-ai-chat review posts.
 *
 *  1. A major and a nit: the major is inline, the nit only in the collapsed list
 *  2. The summary's Not verified sentence is posted once, inside the Summary section
 *  3. Nits only: the caic Looks Good comment with the nit list, and no review
 */

const assert = require('assert');

// constants.js reads the repository list once, when src/index.js loads.
process.env.CARBON_MONITOR_SKIP_DOTENV = '1';
process.env.GITHUB_AI_AGENT_REPOS = 'carbon-ai-chat';

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

const FILE = 'packages/ai-chat/src/chat/utils/foo.ts';
// Lines 11 and 12 are both added lines, so either finding could map inline.
const FILES = [
  {
    filename: FILE,
    status: 'modified',
    additions: 2,
    deletions: 0,
    changes: 2,
    patch: '@@ -10,2 +10,4 @@\n a\n+b\n+c\n d',
  },
];
const NOT_VERIFIED = 'Not verified: the retry branch of the upload queue.';
const NIT_LINE = `- Comment restates the code — \`${FILE}:12\``;

async function main() {
  console.log('\ncaic posting tests\n');

  const batch = await runBatch({
    prNumbers: [1, 2],
    concurrency: 1,
    files: { 1: FILES, 2: FILES },
    fixtures: {
      1: { source: 'review-caic-nit-major' },
      // The fixture with its major turned into a second nit.
      2: { source: 'review-caic-nit-major', severity: 'nit' },
    },
  });

  await test('a caic review posts the major inline and never the nit', () => {
    assert.strictEqual(batch.reviews(1).length, 1);
    assert.strictEqual(batch.inlineComments(1).length, 0, 'one grouped review');
    const comments = batch.reviews(1)[0].body.comments;
    assert.strictEqual(comments.length, 1, JSON.stringify(comments));
    assert.strictEqual(comments[0].path, FILE);
    assert.ok(comments[0].body.includes('**Listener leaks on every close**'));
    assert.ok(comments[0].body.includes('**Context:**'), 'orientation kept');
    assert.ok(!comments[0].body.includes('Comment restates the code'));
  });

  await test('the caic summary lists the nit only in the collapsed list', () => {
    assert.strictEqual(batch.comments(1).length, 1);
    const body = batch.comments(1)[0].body.body;
    assert.ok(body.startsWith('[AI agent review - CAIC] · '), body);
    assert.ok(body.includes('<summary>📓 Findings (1)</summary>'), body);
    assert.ok(
      body.includes(
        '| General | Cat 2 | major | Listener leaks on every close |'
      ),
      body
    );
    assert.ok(!body.includes('| nit |'), 'a nit is not a table row');
    assert.ok(body.includes('<summary>1 optional nit</summary>'), body);
    assert.strictEqual(body.split('Comment restates the code').length, 2);
    assert.ok(body.includes(NIT_LINE), body);
  });

  await test('the Not verified sentence is posted once, inside the Summary section', () => {
    const body = batch.comments(1)[0].body.body;
    assert.strictEqual(body.split(NOT_VERIFIED).length, 2, body);
    const at = body.indexOf(NOT_VERIFIED);
    assert.ok(body.indexOf('## Summary') < at, 'after the Summary heading');
    assert.ok(at < body.indexOf('optional nit'), 'before the nit list');
  });

  await test('a nits-only caic review gets the Looks Good comment and no review', () => {
    assert.strictEqual(batch.reviews(2).length, 0);
    assert.strictEqual(batch.inlineComments(2).length, 0);
    assert.strictEqual(batch.comments(2).length, 1);
    const body = batch.comments(2)[0].body.body;
    assert.ok(
      body.startsWith(
        '[AI agent review - CAIC] · **Looks Good** · Reviewed by: IBM Bob · Commit: sha2\n\n'
      ),
      body
    );
    assert.ok(body.includes('<summary>2 optional nits</summary>'), body);
    assert.ok(body.includes(NIT_LINE), body);
    assert.ok(!body.includes('Findings ('), body);
  });

  await batch.cleanup();

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Passed: ${passed}  Failed: ${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
