/**
 * Tests for auto-selection of reviewable PRs (fetchReviewablePRs) — the path the
 * scheduled review takes. Asserts two properties: deterministic top-N recency
 * (sorted in code, not response order) and correct exclusion of PRs that should
 * not be reviewed.
 *
 * Covers:
 *  1. A plain open human PR within the window is kept
 *  2. Draft PRs are skipped
 *  3. PRs older than daysBack are skipped; ones inside the window are kept
 *  4. PRs already carrying the review label are skipped
 *  5. PRs carrying a SKIP_LABEL (DO NOT MERGE / WIP) are skipped
 *  6. Bot-authored PRs are skipped
 *  7. The result is sorted newest-created first, regardless of response order
 *  8. Exact created_at ties break by PR number (higher = newer)
 *  9. maxPRs returns the N most recent — not the first N the API happened to send
 * 10. Omitting maxPRs returns every eligible PR, still newest-first
 * 11. Only open PRs are requested (state: 'open' in the query)
 */

const { createGitHubClient } = require('../src/githubClient');
const { SKIP_LABELS } = require('../src/constants');

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

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label || 'assertEqual'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertDeepEqual(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${label || 'assertDeepEqual'}: expected ${e}, got ${a}`);
  }
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const LABEL = 'AIReviewed';
const DAYS_BACK = 21;

/** ISO timestamp for `n` days before now. */
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

/** A reviewable PR by default; override any field to make it ineligible. */
function makePR(overrides = {}) {
  return {
    number: 1,
    title: 'A PR',
    state: 'open',
    draft: false,
    user: { login: 'dev', type: 'User' },
    created_at: daysAgo(1),
    labels: [],
    ...overrides,
  };
}

/**
 * Fake octokit that returns a fixed PR array from pulls.list and records the
 * params it was called with, so tests can assert on the query too.
 */
function makeFakeOctokit(prs, capture = {}) {
  return {
    rest: {
      pulls: {
        list: async (params) => {
          capture.params = params;
          return { data: prs };
        },
      },
    },
  };
}

function fetchWith(prs, { maxPRs, capture } = {}) {
  const client = createGitHubClient(makeFakeOctokit(prs, capture));
  return client.fetchReviewablePRs({ owner: 'o', repo: 'r', daysBack: DAYS_BACK, label: LABEL, maxPRs });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

async function runTests() {
  console.log('\n🧪 fetchReviewablePRs — auto-selection\n');

  // ── B. Exclusion rules ──────────────────────────────────────────────────────

  await test('keeps a plain open human PR within the window', async () => {
    const result = await fetchWith([makePR({ number: 5 })]);
    assertDeepEqual(result.map(p => p.number), [5], 'kept numbers');
  });

  await test('skips draft PRs', async () => {
    const result = await fetchWith([makePR({ number: 5, draft: true })]);
    assertEqual(result.length, 0, 'draft excluded');
  });

  await test('skips PRs older than daysBack, keeps ones inside the window', async () => {
    const result = await fetchWith([
      makePR({ number: 1, created_at: daysAgo(30) }), // stale — excluded
      makePR({ number: 2, created_at: daysAgo(5) }),  // recent — kept
    ]);
    assertDeepEqual(result.map(p => p.number), [2], 'only the in-window PR survives');
  });

  await test('skips PRs already carrying the review label', async () => {
    const result = await fetchWith([makePR({ number: 5, labels: [{ name: LABEL }] })]);
    assertEqual(result.length, 0, 'already-reviewed excluded');
  });

  await test('skips PRs carrying a SKIP_LABEL (DO NOT MERGE / WIP)', async () => {
    for (const skip of SKIP_LABELS) {
      const result = await fetchWith([makePR({ number: 5, labels: [{ name: skip }] })]);
      assertEqual(result.length, 0, `"${skip}" excluded`);
    }
  });

  await test('skips bot-authored PRs', async () => {
    const result = await fetchWith([makePR({ number: 5, user: { login: 'dependabot', type: 'Bot' } })]);
    assertEqual(result.length, 0, 'bot excluded');
  });

  // ── A. Deterministic recency ────────────────────────────────────────────────

  await test('sorts newest-created first, regardless of response order', async () => {
    // Deliberately scrambled response order.
    const result = await fetchWith([
      makePR({ number: 10, created_at: daysAgo(5) }),
      makePR({ number: 11, created_at: daysAgo(1) }),
      makePR({ number: 12, created_at: daysAgo(15) }),
      makePR({ number: 13, created_at: daysAgo(2) }),
    ]);
    assertDeepEqual(result.map(p => p.number), [11, 13, 10, 12], 'newest-first ordering');
  });

  await test('breaks exact created_at ties by PR number (higher = newer)', async () => {
    const t = daysAgo(3);
    const result = await fetchWith([
      makePR({ number: 7, created_at: t }),
      makePR({ number: 9, created_at: t }),
      makePR({ number: 8, created_at: t }),
    ]);
    assertDeepEqual(result.map(p => p.number), [9, 8, 7], 'tie-break by number desc');
  });

  await test('maxPRs returns the N MOST RECENT, not the first N the API sent', async () => {
    // If the code naively sliced the response, this would return [10, 11, 12].
    // The correct top-3 by recency is [11, 13, 10].
    const result = await fetchWith(
      [
        makePR({ number: 10, created_at: daysAgo(5) }),
        makePR({ number: 11, created_at: daysAgo(1) }),
        makePR({ number: 12, created_at: daysAgo(15) }),
        makePR({ number: 13, created_at: daysAgo(2) }),
        makePR({ number: 14, created_at: daysAgo(20) }),
      ],
      { maxPRs: 3 }
    );
    assertDeepEqual(result.map(p => p.number), [11, 13, 10], 'top-3 by recency');
  });

  await test('omitting maxPRs returns every eligible PR, still newest-first', async () => {
    const result = await fetchWith([
      makePR({ number: 1, created_at: daysAgo(9) }),
      makePR({ number: 2, created_at: daysAgo(3) }),
    ]);
    assertDeepEqual(result.map(p => p.number), [2, 1], 'all kept, sorted');
  });

  await test('requests only open PRs', async () => {
    const capture = {};
    await fetchWith([makePR()], { capture });
    assertEqual(capture.params.state, 'open', 'state filter');
    assertEqual(capture.params.sort, 'created', 'sort field');
    assertEqual(capture.params.direction, 'desc', 'sort direction');
  });

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Fatal error in test runner:', err);
  process.exit(1);
});
