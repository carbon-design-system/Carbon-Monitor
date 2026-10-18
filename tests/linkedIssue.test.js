/**
 * Unit tests — Issue linking feature
 *
 * Covers two layers:
 *   1. fetchLinkedIssueContext (githubClient.js) — parses any GitHub closing keyword
 *      (all 9 forms), fetches the linked issue, and optionally its parent.
 *   2. buildReviewBundle (reviewBundle.js) — injects the fetched context as a
 *      "## Linked Issue Context" section into PR_REVIEW_REQUEST.md.
 *
 * Both layers are tested with mock octokit / mock client objects so the suite
 * runs offline with no GitHub token.
 */

'use strict';

const fs = require('fs').promises;
const path = require('path');

const { createGitHubClient } = require('../src/githubClient');
const { buildReviewBundle } = require('../src/reviewBundle');
const { ISSUE_CONTEXT_TOKENS, CHARS_PER_TOKEN } = require('../src/constants');

// ─── Helpers ──────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function test(description, fn) {
  try {
    await fn();
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

// Minimal PR fixture used by bundle tests
const MINIMAL_PR = {
  number: 99,
  title: 'Test PR',
  user: { login: 'alice' },
  body: 'Closes #42',
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-02T00:00:00Z',
};

const MINIMAL_FILES = [
  {
    filename: 'foo.js',
    status: 'added',
    additions: 1,
    deletions: 0,
    changes: 1,
    patch: '@@ -0,0 +1 @@\n+const x = 1;',
  },
];

/**
 * Build a mock octokit whose issues.get and request return canned data.
 * Pass throwOn: 'issue' | 'parent' to simulate API failures.
 */
function makeOctokit({ subIssueOverride, parentIssueOverride, throwOn } = {}) {
  return {
    rest: {
      issues: {
        get: async ({ issue_number }) => {
          if (throwOn === 'issue')
            throw new Error('Simulated GitHub API error');
          return {
            data: subIssueOverride || {
              number: issue_number,
              title: 'Test issue title',
              body: 'This issue describes the problem to be fixed.',
              parent_issue_url: null,
            },
          };
        },
      },
    },
    request: async (_url) => {
      if (throwOn === 'parent') throw new Error('Simulated parent API error');
      return {
        data: parentIssueOverride || {
          number: 1,
          title: 'Parent epic title',
          body: 'High-level epic description.',
        },
      };
    },
  };
}

/**
 * Build a fake client whose fetchLinkedIssueContext returns a canned value.
 * Used for bundle-level tests so they don't depend on githubClient internals.
 */
function makeFakeClient(result) {
  return {
    fetchLinkedIssueContext: async () => result,
  };
}

// ─── Test suites ──────────────────────────────────────────────────────────────

async function runTests() {
  // ── fetchLinkedIssueContext: PR body parsing ─────────────────────────────────
  console.log(
    '\n── fetchLinkedIssueContext: PR body parsing ──────────────────'
  );

  await test('returns found:false when prBody is null', async () => {
    const client = createGitHubClient(makeOctokit());
    const result = await client.fetchLinkedIssueContext({
      owner: 'o',
      repo: 'r',
      prBody: null,
    });
    assert(result.found === false, `expected found:false, got ${result.found}`);
  });

  await test('returns found:false when prBody is empty string', async () => {
    const client = createGitHubClient(makeOctokit());
    const result = await client.fetchLinkedIssueContext({
      owner: 'o',
      repo: 'r',
      prBody: '',
    });
    assert(result.found === false, `expected found:false, got ${result.found}`);
  });

  await test('returns found:false when body has no Closes/Fixes/Resolves keyword', async () => {
    const client = createGitHubClient(makeOctokit());
    const result = await client.fetchLinkedIssueContext({
      owner: 'o',
      repo: 'r',
      prBody: 'This PR does stuff, see #42 for context.',
    });
    assert(result.found === false, `expected found:false, got ${result.found}`);
  });

  await test('parses "Closes #42" and returns found:true with correct issue number', async () => {
    const client = createGitHubClient(makeOctokit());
    const result = await client.fetchLinkedIssueContext({
      owner: 'o',
      repo: 'r',
      prBody: 'Closes #42',
    });
    assert(result.found === true, 'expected found:true');
    assert(
      result.subIssue.number === 42,
      `expected issue number 42, got ${result.subIssue.number}`
    );
  });

  await test('parses "Fixes #100" keyword', async () => {
    const client = createGitHubClient(makeOctokit());
    const result = await client.fetchLinkedIssueContext({
      owner: 'o',
      repo: 'r',
      prBody: 'Fixes #100',
    });
    assert(result.found === true, 'expected found:true');
    assert(
      result.subIssue.number === 100,
      `expected issue number 100, got ${result.subIssue.number}`
    );
  });

  await test('parses "Resolves #7" keyword', async () => {
    const client = createGitHubClient(makeOctokit());
    const result = await client.fetchLinkedIssueContext({
      owner: 'o',
      repo: 'r',
      prBody: 'Resolves #7',
    });
    assert(result.found === true, 'expected found:true');
    assert(
      result.subIssue.number === 7,
      `expected issue number 7, got ${result.subIssue.number}`
    );
  });

  await test('keyword matching is case-insensitive', async () => {
    const client = createGitHubClient(makeOctokit());
    for (const keyword of [
      'closes',
      'CLOSES',
      'Closes',
      'FIXES',
      'fixes',
      'RESOLVES',
      'resolves',
    ]) {
      const result = await client.fetchLinkedIssueContext({
        owner: 'o',
        repo: 'r',
        prBody: `${keyword} #5`,
      });
      assert(
        result.found === true,
        `expected found:true for keyword "${keyword}"`
      );
    }
  });

  await test('subIssue title and body are populated from the API response', async () => {
    const client = createGitHubClient(
      makeOctokit({
        subIssueOverride: {
          number: 42,
          title: 'Accessibility: add aria-label to time picker',
          body: 'The time picker is missing aria-label on the select element.',
          parent_issue_url: null,
        },
      })
    );
    const result = await client.fetchLinkedIssueContext({
      owner: 'o',
      repo: 'r',
      prBody: 'Closes #42',
    });
    assert(
      result.subIssue.title === 'Accessibility: add aria-label to time picker',
      'title mismatch'
    );
    assert(
      result.subIssue.body.includes('missing aria-label'),
      'body mismatch'
    );
  });

  await test('parentIssue is null when subIssue has no parent_issue_url', async () => {
    const client = createGitHubClient(
      makeOctokit({
        subIssueOverride: {
          number: 42,
          title: 'Child issue',
          body: 'Body.',
          parent_issue_url: null,
        },
      })
    );
    const result = await client.fetchLinkedIssueContext({
      owner: 'o',
      repo: 'r',
      prBody: 'Closes #42',
    });
    assert(result.found === true, 'expected found:true');
    assert(
      result.parentIssue === null,
      `expected parentIssue:null, got ${JSON.stringify(result.parentIssue)}`
    );
  });

  await test('parentIssue is populated when subIssue has parent_issue_url', async () => {
    const client = createGitHubClient(
      makeOctokit({
        subIssueOverride: {
          number: 42,
          title: 'Child issue',
          body: 'Body.',
          parent_issue_url: 'https://api.github.com/repos/o/r/issues/1',
        },
        parentIssueOverride: {
          number: 1,
          title: 'Parent epic',
          body: 'Epic body.',
        },
      })
    );
    const result = await client.fetchLinkedIssueContext({
      owner: 'o',
      repo: 'r',
      prBody: 'Closes #42',
    });
    assert(result.found === true, 'expected found:true');
    assert(result.parentIssue !== null, 'expected parentIssue to be populated');
    assert(
      result.parentIssue.number === 1,
      `expected parent number 1, got ${result.parentIssue.number}`
    );
    assert(result.parentIssue.title === 'Parent epic', 'parent title mismatch');
  });

  await test('returns found:false (silently) when issue API throws', async () => {
    const client = createGitHubClient(makeOctokit({ throwOn: 'issue' }));
    const result = await client.fetchLinkedIssueContext({
      owner: 'o',
      repo: 'r',
      prBody: 'Closes #42',
    });
    assert(
      result.found === false,
      `expected found:false on API error, got ${result.found}`
    );
  });

  await test('parses "fix #N" singular form', async () => {
    const client = createGitHubClient(makeOctokit());
    const result = await client.fetchLinkedIssueContext({
      owner: 'o',
      repo: 'r',
      prBody: 'fix #42',
    });
    assert(result.found === true, 'expected found:true for "fix"');
    assert(
      result.subIssue.number === 42,
      `expected issue 42, got ${result.subIssue.number}`
    );
  });

  await test('parses "fixed #N" past tense', async () => {
    const client = createGitHubClient(makeOctokit());
    const result = await client.fetchLinkedIssueContext({
      owner: 'o',
      repo: 'r',
      prBody: 'fixed #42',
    });
    assert(result.found === true, 'expected found:true for "fixed"');
    assert(
      result.subIssue.number === 42,
      `expected issue 42, got ${result.subIssue.number}`
    );
  });

  await test('parses "close #N" singular form', async () => {
    const client = createGitHubClient(makeOctokit());
    const result = await client.fetchLinkedIssueContext({
      owner: 'o',
      repo: 'r',
      prBody: 'close #42',
    });
    assert(result.found === true, 'expected found:true for "close"');
    assert(
      result.subIssue.number === 42,
      `expected issue 42, got ${result.subIssue.number}`
    );
  });

  await test('parses "closed #N" past tense', async () => {
    const client = createGitHubClient(makeOctokit());
    const result = await client.fetchLinkedIssueContext({
      owner: 'o',
      repo: 'r',
      prBody: 'closed #42',
    });
    assert(result.found === true, 'expected found:true for "closed"');
    assert(
      result.subIssue.number === 42,
      `expected issue 42, got ${result.subIssue.number}`
    );
  });

  await test('parses "resolve #N" singular form', async () => {
    const client = createGitHubClient(makeOctokit());
    const result = await client.fetchLinkedIssueContext({
      owner: 'o',
      repo: 'r',
      prBody: 'resolve #42',
    });
    assert(result.found === true, 'expected found:true for "resolve"');
    assert(
      result.subIssue.number === 42,
      `expected issue 42, got ${result.subIssue.number}`
    );
  });

  await test('parses "resolved #N" past tense', async () => {
    const client = createGitHubClient(makeOctokit());
    const result = await client.fetchLinkedIssueContext({
      owner: 'o',
      repo: 'r',
      prBody: 'resolved #42',
    });
    assert(result.found === true, 'expected found:true for "resolved"');
    assert(
      result.subIssue.number === 42,
      `expected issue 42, got ${result.subIssue.number}`
    );
  });

  await test('word boundary prevents "hotfix #N" from matching fix (by design)', async () => {
    const client = createGitHubClient(makeOctokit());
    const result = await client.fetchLinkedIssueContext({
      owner: 'o',
      repo: 'r',
      prBody: 'hotfix #42',
    });
    assert(
      result.found === false,
      'expected found:false — "hotfix" must not match the "fix" keyword'
    );
  });

  await test('parent fetch failure degrades gracefully — sub-issue still returned', async () => {
    const client = createGitHubClient(
      makeOctokit({
        // parent_issue_url must be non-null to enter the parent fetch branch
        subIssueOverride: {
          number: 42,
          title: 'Child issue',
          body: 'Body.',
          parent_issue_url: 'https://api.github.com/repos/o/r/issues/1',
        },
        throwOn: 'parent',
      })
    );
    const result = await client.fetchLinkedIssueContext({
      owner: 'o',
      repo: 'r',
      prBody: 'Closes #42',
    });
    assert(
      result.found === true,
      'expected found:true — sub-issue must not be lost when parent fetch fails'
    );
    assert(
      result.subIssue.number === 42,
      `expected subIssue.number 42, got ${result.subIssue.number}`
    );
    assert(
      result.parentIssue === null,
      'expected parentIssue:null when parent fetch throws'
    );
  });

  await test('only the first closing keyword reference is used (by design)', async () => {
    const client = createGitHubClient(makeOctokit());
    const result = await client.fetchLinkedIssueContext({
      owner: 'o',
      repo: 'r',
      prBody: 'Closes #10\nAlso fixes #20',
    });
    assert(result.found === true, 'expected found:true');
    assert(
      result.subIssue.number === 10,
      `expected issue 10 (first match), got ${result.subIssue.number}`
    );
  });

  // ── buildReviewBundle: issue context injection ────────────────────────────────
  console.log(
    '\n── buildReviewBundle: Linked Issue Context injection ─────────'
  );

  await test('## Linked Issue Context section is present when client returns found:true', async () => {
    const bundle = await buildReviewBundle({
      owner: 'o',
      repo: 'r',
      pr: MINIMAL_PR,
      files: MINIMAL_FILES,
      client: makeFakeClient({
        found: true,
        subIssue: {
          number: 42,
          title: 'Add aria-label support',
          body: 'We need aria-label on time-picker selects.',
        },
        parentIssue: null,
      }),
    });
    try {
      const content = await fs.readFile(
        path.join(bundle.dir, 'PR_REVIEW_REQUEST.md'),
        'utf8'
      );
      assert(
        content.includes('## Linked Issue Context'),
        'Missing "## Linked Issue Context" section'
      );
      assert(content.includes('Issue #42'), 'Missing issue number reference');
      assert(content.includes('Add aria-label support'), 'Missing issue title');
      assert(
        content.includes('aria-label on time-picker selects'),
        'Missing issue body content'
      );
    } finally {
      await bundle.cleanup();
    }
  });

  await test('## Linked Issue Context section is absent when client returns found:false', async () => {
    const bundle = await buildReviewBundle({
      owner: 'o',
      repo: 'r',
      pr: MINIMAL_PR,
      files: MINIMAL_FILES,
      client: makeFakeClient({ found: false }),
    });
    try {
      const content = await fs.readFile(
        path.join(bundle.dir, 'PR_REVIEW_REQUEST.md'),
        'utf8'
      );
      assert(
        !content.includes('## Linked Issue Context'),
        '"## Linked Issue Context" must be absent when no issue found'
      );
    } finally {
      await bundle.cleanup();
    }
  });

  await test('## Linked Issue Context section is absent when no client is provided', async () => {
    const bundle = await buildReviewBundle({
      owner: 'o',
      repo: 'r',
      pr: MINIMAL_PR,
      files: MINIMAL_FILES,
      // no client
    });
    try {
      const content = await fs.readFile(
        path.join(bundle.dir, 'PR_REVIEW_REQUEST.md'),
        'utf8'
      );
      assert(
        !content.includes('## Linked Issue Context'),
        '"## Linked Issue Context" must be absent with no client'
      );
    } finally {
      await bundle.cleanup();
    }
  });

  await test('parent issue content is included when parentIssue is present', async () => {
    const bundle = await buildReviewBundle({
      owner: 'o',
      repo: 'r',
      pr: MINIMAL_PR,
      files: MINIMAL_FILES,
      client: makeFakeClient({
        found: true,
        subIssue: { number: 42, title: 'Child issue', body: 'Child body.' },
        parentIssue: {
          number: 1,
          title: 'Parent epic',
          body: 'Epic-level description here.',
        },
      }),
    });
    try {
      const content = await fs.readFile(
        path.join(bundle.dir, 'PR_REVIEW_REQUEST.md'),
        'utf8'
      );
      assert(
        content.includes('Parent Issue #1'),
        'Missing parent issue reference'
      );
      assert(content.includes('Parent epic'), 'Missing parent issue title');
      assert(
        content.includes('Epic-level description here'),
        'Missing parent issue body'
      );
    } finally {
      await bundle.cleanup();
    }
  });

  await test('issue context section appears before the ## Diff section', async () => {
    const bundle = await buildReviewBundle({
      owner: 'o',
      repo: 'r',
      pr: MINIMAL_PR,
      files: MINIMAL_FILES,
      client: makeFakeClient({
        found: true,
        subIssue: { number: 42, title: 'Some issue', body: 'Issue body.' },
        parentIssue: null,
      }),
    });
    try {
      const content = await fs.readFile(
        path.join(bundle.dir, 'PR_REVIEW_REQUEST.md'),
        'utf8'
      );
      const issuePos = content.indexOf('## Linked Issue Context');
      const diffPos = content.indexOf('## Diff');
      assert(issuePos !== -1, '"## Linked Issue Context" not found');
      assert(diffPos !== -1, '"## Diff" not found');
      assert(
        issuePos < diffPos,
        `Issue context (pos ${issuePos}) must appear before ## Diff (pos ${diffPos})`
      );
    } finally {
      await bundle.cleanup();
    }
  });

  await test('oversized issue body (no newlines) falls back to hard char cut with truncation notice', async () => {
    const maxChars = ISSUE_CONTEXT_TOKENS * CHARS_PER_TOKEN;
    const longBody = 'x'.repeat(maxChars + 1000); // wall of chars, no newlines — exercises the -1 fallback path

    const bundle = await buildReviewBundle({
      owner: 'o',
      repo: 'r',
      pr: MINIMAL_PR,
      files: MINIMAL_FILES,
      client: makeFakeClient({
        found: true,
        subIssue: { number: 42, title: 'Big issue', body: longBody },
        parentIssue: null,
      }),
    });
    try {
      const content = await fs.readFile(
        path.join(bundle.dir, 'PR_REVIEW_REQUEST.md'),
        'utf8'
      );
      assert(
        content.includes('[... issue context truncated ...]'),
        'Truncation notice must be present for oversized issue body'
      );
      assert(
        !content.includes('x'.repeat(maxChars + 500)),
        'Full oversized body must not appear in the bundle'
      );
    } finally {
      await bundle.cleanup();
    }
  });

  await test('oversized issue body snaps to last complete line — partial line after cap is absent', async () => {
    const maxChars = ISSUE_CONTEXT_TOKENS * CHARS_PER_TOKEN;
    // The heading prefix added by reviewBundle.js is included in issueContent before
    // the cap check: `### Issue #42: Snap test\n\n` — measure it precisely so the
    // fixture arithmetic is exact regardless of title length.
    const headingPrefix = '### Issue #42: Snap test\n\n';
    const bodyBudget = maxChars - headingPrefix.length;

    // Build a body where:
    //   - complete lines fill up to just under the body budget (each ending with \n)
    //   - a partial line starts after the cap and must NOT appear in the output
    const completeLine =
      'This is a complete sentence that ends on a clean line boundary.\n';
    // Leave ~50 chars of breathing room so the partial line starts inside the hard-cut window
    const repeatCount = Math.floor((bodyBudget - 50) / completeLine.length);
    const fillerLines = completeLine.repeat(repeatCount);
    // Partial line must be long enough to push issueContent past maxChars.
    // fillerLines ends ~50 chars before bodyBudget, so we need > 50 + headingPrefix chars.
    const partialLine =
      'THIS_PARTIAL_LINE_MUST_NOT_APPEAR_IN_OUTPUT ' + 'x'.repeat(200);
    const longBody = fillerLines + partialLine;

    // Sanity: combined issueContent is over the cap
    const issueContent = `${headingPrefix}${longBody}`;
    assert(
      issueContent.length > maxChars,
      `fixture must exceed maxChars (${issueContent.length} vs ${maxChars})`
    );
    // Sanity: a hard cut at maxChars would include the start of the partial line
    const hardCut = issueContent.substring(0, maxChars);
    assert(
      hardCut.includes('THIS_PARTIAL_LINE'),
      'fixture check: hard cut must include start of partialLine'
    );

    const bundle = await buildReviewBundle({
      owner: 'o',
      repo: 'r',
      pr: MINIMAL_PR,
      files: MINIMAL_FILES,
      client: makeFakeClient({
        found: true,
        subIssue: { number: 42, title: 'Snap test', body: longBody },
        parentIssue: null,
      }),
    });
    try {
      const content = await fs.readFile(
        path.join(bundle.dir, 'PR_REVIEW_REQUEST.md'),
        'utf8'
      );
      assert(
        content.includes('[... issue context truncated ...]'),
        'Truncation notice must be present'
      );
      assert(
        !content.includes('THIS_PARTIAL_LINE_MUST_NOT_APPEAR_IN_OUTPUT'),
        'Partial line after the cap must be absent — truncation must snap to last complete line'
      );
    } finally {
      await bundle.cleanup();
    }
  });

  await test('parent body causing truncation — notice appears and partial parent content absent', async () => {
    const maxChars = ISSUE_CONTEXT_TOKENS * CHARS_PER_TOKEN;
    const shortSubBody = 'Short sub-issue body.\n';
    // Make parent body long enough that combined content exceeds cap
    const parentBody = 'Parent line.\n'.repeat(
      Math.ceil(maxChars / 'Parent line.\n'.length) + 5
    );

    const bundle = await buildReviewBundle({
      owner: 'o',
      repo: 'r',
      pr: MINIMAL_PR,
      files: MINIMAL_FILES,
      client: makeFakeClient({
        found: true,
        subIssue: { number: 42, title: 'Child', body: shortSubBody },
        parentIssue: { number: 1, title: 'Parent epic', body: parentBody },
      }),
    });
    try {
      const content = await fs.readFile(
        path.join(bundle.dir, 'PR_REVIEW_REQUEST.md'),
        'utf8'
      );
      assert(
        content.includes('[... issue context truncated ...]'),
        'Truncation notice must appear when parent body pushes combined content past cap'
      );
      // The full repeated parent body must not appear verbatim
      assert(
        !content.includes(parentBody),
        'Full parent body must not appear — it exceeds the cap'
      );
    } finally {
      await bundle.cleanup();
    }
  });

  await test('issue body that fits within the cap is not truncated', async () => {
    const shortBody = 'Short issue body that is well within the token limit.';
    const bundle = await buildReviewBundle({
      owner: 'o',
      repo: 'r',
      pr: MINIMAL_PR,
      files: MINIMAL_FILES,
      client: makeFakeClient({
        found: true,
        subIssue: { number: 42, title: 'Small issue', body: shortBody },
        parentIssue: null,
      }),
    });
    try {
      const content = await fs.readFile(
        path.join(bundle.dir, 'PR_REVIEW_REQUEST.md'),
        'utf8'
      );
      assert(
        !content.includes('[... issue context truncated ...]'),
        'Truncation notice must NOT appear for a short issue body'
      );
      assert(
        content.includes(shortBody),
        'Full body must be present for a short issue'
      );
    } finally {
      await bundle.cleanup();
    }
  });

  // ─── Summary ────────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);

  if (failed > 0) {
    process.exit(1);
  } else {
    console.log('✅ All linked issue tests passed!');
  }
}

runTests().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
