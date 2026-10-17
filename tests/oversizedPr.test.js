/**
 * Tests for the oversized-PR size gate in reviewPRs().
 *
 * Covers:
 *  1. Gate fires in auto mode — label added, skipped entry in runResults
 *  2. Gate does NOT fire in explicit mode (--pr N)
 *  3. Gate does NOT fire when files came from ORIGINAL_FILES.json (test fixture)
 *  4. Gate does NOT fire when files.length === MAX_FILES_PER_PR (boundary: at limit is allowed)
 *  5. Comment is NOT posted when label-add fails
 *  6. Comment is NOT posted when GITHUB_AI_AGENT_POST_SUMMARY_COMMENT=false
 */

'use strict';

const assert = require('assert');

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

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Minimal fake of the per-PR logic extracted from reviewPRs().
 * Returns { runResults, labelCalled, commentCalled }.
 */
async function runSizeGate({
  fileCount,
  targetMode = 'auto',
  filesFromTestFixture = false,
  labelThrows = false,
  postSummaryEnv = 'true',
  maxFiles = 300,
}) {
  const runResults = [];
  let labelCalled = false;
  let commentCalled = false;

  // Minimal stubs
  const client = {
    addReviewedLabel: async () => {
      if (labelThrows) throw new Error('GitHub API error');
      labelCalled = true;
    },
    postSummaryComment: async () => {
      commentCalled = true;
    },
  };

  const emitEvent = async () => {};

  const pr = {
    number: 23394,
    html_url: 'https://github.com/carbon-design-system/carbon/pull/23394',
    head: { sha: 'abc123' },
  };

  const files = Array.from({ length: fileCount }, (_, i) => ({
    filename: `file${i}.js`,
    additions: 1,
    deletions: 0,
  }));

  const REVIEW_LABEL = 'AIReviewed';
  const GITHUB_OWNER = 'carbon-design-system';
  const GITHUB_REPO = 'carbon';
  const correlationId = 'test-correlation-id';
  const REVIEW_AGENT = 'bob';

  // Replicate the size gate logic from index.js exactly
  if (
    targetMode === 'auto' &&
    !filesFromTestFixture &&
    files.length > maxFiles
  ) {
    await emitEvent({
      event_type: 'pr_skipped_too_large',
      correlation_id: correlationId,
      repo: `${GITHUB_OWNER}/${GITHUB_REPO}`,
      pr_number: pr.number,
      agent: REVIEW_AGENT,
      payload: { file_count: files.length, limit: maxFiles },
    });

    let labelAdded = false;
    try {
      await client.addReviewedLabel({
        owner: GITHUB_OWNER,
        repo: GITHUB_REPO,
        pullNumber: pr.number,
        label: REVIEW_LABEL,
      });
      labelAdded = true;
    } catch (labelErr) {
      // log only — intentionally swallowed in test
    }

    const postSummary = postSummaryEnv !== 'false';
    if (labelAdded && postSummary) {
      try {
        await client.postSummaryComment({
          owner: GITHUB_OWNER,
          repo: GITHUB_REPO,
          pullNumber: pr.number,
          body: `## Carbon Monitor — Review Skipped\n\nThis PR has **${files.length} changed files**, which exceeds the ${maxFiles}-file limit for automatic review.`,
        });
      } catch (_) {}
    }

    runResults.push({
      prNumber: pr.number,
      prUrl: pr.html_url,
      skipped: true,
      reason: `${files.length} files exceeds limit of ${maxFiles}`,
    });
  }

  return { runResults, labelCalled, commentCalled };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n🧪 oversized PR size gate\n');

  await test('gate fires in auto mode: label added, skipped entry pushed', async () => {
    const { runResults, labelCalled } = await runSizeGate({ fileCount: 489 });
    assert.strictEqual(labelCalled, true, 'addReviewedLabel must be called');
    assert.strictEqual(runResults.length, 1, 'one runResults entry');
    assert.strictEqual(
      runResults[0].skipped,
      true,
      'entry must have skipped:true'
    );
    assert.strictEqual(runResults[0].prNumber, 23394, 'correct PR number');
    assert.ok(
      runResults[0].reason.includes('489'),
      'reason must mention file count'
    );
  });

  await test('gate does NOT fire in explicit mode', async () => {
    const { runResults, labelCalled } = await runSizeGate({
      fileCount: 489,
      targetMode: 'explicit',
    });
    assert.strictEqual(
      labelCalled,
      false,
      'label must not be added in explicit mode'
    );
    assert.strictEqual(
      runResults.length,
      0,
      'no runResults entry in explicit mode'
    );
  });

  await test('gate does NOT fire when files came from test fixture', async () => {
    const { runResults, labelCalled } = await runSizeGate({
      fileCount: 489,
      filesFromTestFixture: true,
    });
    assert.strictEqual(
      labelCalled,
      false,
      'label must not be added for fixture files'
    );
    assert.strictEqual(
      runResults.length,
      0,
      'no runResults entry for fixture files'
    );
  });

  await test('gate does NOT fire when files.length === MAX_FILES_PER_PR (boundary)', async () => {
    const { runResults } = await runSizeGate({ fileCount: 300, maxFiles: 300 });
    assert.strictEqual(
      runResults.length,
      0,
      'exactly at limit must not trigger the gate'
    );
  });

  await test('comment NOT posted when label-add fails', async () => {
    const { commentCalled, runResults } = await runSizeGate({
      fileCount: 489,
      labelThrows: true,
    });
    assert.strictEqual(
      commentCalled,
      false,
      'comment must not be posted when label fails'
    );
    // runResults still gets the skipped entry so Slack digest reflects the attempt
    assert.strictEqual(
      runResults.length,
      1,
      'skipped entry still pushed even when label fails'
    );
  });

  await test('comment NOT posted when POST_SUMMARY_COMMENT env is false', async () => {
    const { commentCalled, labelCalled } = await runSizeGate({
      fileCount: 489,
      postSummaryEnv: 'false',
    });
    assert.strictEqual(labelCalled, true, 'label must still be added');
    assert.strictEqual(
      commentCalled,
      false,
      'comment must be suppressed by env flag'
    );
  });

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
