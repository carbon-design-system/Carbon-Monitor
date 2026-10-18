/**
 * Tests for createOctokit (src/githubClient.js), fully offline via a mocked fetch
 *
 *  1. The instance carries paginate and the retry plugin
 *  2. A 502 on a read is retried; a 502 on a write is not (no duplicate comments)
 *  3. The rate-limit handler retries at most twice and only for waits of 60 s or less
 *  4. postReviewComments posts one COMMENT review; a 422 falls back to one comment at a time;
 *     any other error posts nothing more and returns null
 *  5. fetchPRFiles pages at 70, the most files GitHub sends patches for in one page
 */

const nodeAssert = require('assert');
const {
  createGitHubClient,
  createOctokit,
  rateLimitHandler,
} = require('../src/githubClient');

let passed = 0;
let failed = 0;

async function test(description, fn) {
  try {
    await fn();
    console.log(`  \u2705 ${description}`);
    passed++;
  } catch (err) {
    console.error(`  \u274c ${description}`);
    console.error(`     ${err.message}`);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

async function build() {
  const calls = [];
  const octokit = await createOctokit({
    auth: 'test-token',
    baseUrl: 'https://api.example.test',
    // 1 ms instead of seconds between retries keeps the test fast.
    retry: { retryAfterBaseValue: 1 },
    request: {
      fetch: async (url, init) => {
        calls.push(`${init.method} ${url}`);
        return new Response('{"message":"bad gateway"}', {
          status: 502,
          headers: { 'content-type': 'application/json' },
        });
      },
    },
  });
  return { octokit, calls };
}

// A stub Octokit that records the review calls; `failReview` and `failComment` shape the errors.
function stub({ failReview, failComment } = {}) {
  const calls = { reviews: [], comments: [] };
  const octokit = {
    rest: {
      pulls: {
        createReview: async (args) => {
          calls.reviews.push(args);
          if (failReview) throw failReview;
          return { data: { id: 77 } };
        },
        createReviewComment: async (args) => {
          calls.comments.push(args);
          if (failComment && failComment(args)) {
            throw Object.assign(new Error('Validation Failed'), {
              status: 422,
            });
          }
          return { data: { id: 5, pull_request_review_id: 88 } };
        },
      },
    },
  };
  return { client: createGitHubClient(octokit), calls };
}

const target = { owner: 'o', repo: 'r', pullNumber: 9, commitId: 'abc123' };
const inline = (path, position) => ({ path, position, body: `on ${path}` });
const httpError = (status, message) =>
  Object.assign(new Error(message), { status });

async function quietly(fn) {
  const { log, warn, error } = console;
  console.log = console.warn = console.error = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, { log, warn, error });
  }
}

async function main() {
  console.log('\nGitHub client construction tests\n');

  await test('returns an instance with paginate and retry', async () => {
    const { octokit } = await build();
    assert(typeof octokit.paginate === 'function', 'paginate');
    assert(typeof octokit.retry?.retryRequest === 'function', 'retry plugin');
  });

  await test('a 502 on a read is retried, a 502 on a write is not', async () => {
    const read = await build();
    await read.octokit.request('GET /repos/o/r/pulls/1').catch(() => {});
    assert(read.calls.length > 1, `read tried ${read.calls.length} time(s)`);

    const write = await build();
    await write.octokit
      .request('POST /repos/o/r/issues/1/comments', { body: 'x' })
      .catch(() => {});
    assert(
      write.calls.length === 1,
      `write tried ${write.calls.length} time(s)`
    );
  });

  await test('rate-limit handler gives up after 2 retries or a long wait', async () => {
    const octokit = null;
    const warn = console.warn;
    console.warn = () => {};
    try {
      const handle = rateLimitHandler('primary rate limit');
      const req = { method: 'GET', url: '/x' };
      assert(handle(30, req, octokit, 0) === true, 'short wait, first try');
      assert(handle(30, req, octokit, 1) === true, 'short wait, second try');
      assert(handle(30, req, octokit, 2) === false, 'third try refused');
      assert(handle(3600, req, octokit, 0) === false, 'one-hour wait refused');
    } finally {
      console.warn = warn;
    }
  });

  await test('postReviewComments posts one COMMENT review with every comment', async () => {
    const { client, calls } = stub();
    const result = await quietly(() =>
      client.postReviewComments({
        ...target,
        comments: [inline('a.js', 3), inline('b.js', 7)],
      })
    );
    nodeAssert.strictEqual(calls.reviews.length, 1);
    nodeAssert.strictEqual(calls.comments.length, 0);
    const call = calls.reviews[0];
    nodeAssert.strictEqual(call.event, 'COMMENT');
    nodeAssert.strictEqual(call.commit_id, 'abc123');
    nodeAssert.strictEqual(call.pull_number, 9);
    nodeAssert.strictEqual(call.body, undefined);
    nodeAssert.deepStrictEqual(call.comments, [
      { path: 'a.js', position: 3, body: 'on a.js' },
      { path: 'b.js', position: 7, body: 'on b.js' },
    ]);
    nodeAssert.deepStrictEqual(result, {
      id: 77,
      comments: [
        { path: 'a.js', position: 3 },
        { path: 'b.js', position: 7 },
      ],
    });
  });

  await test('postReviewComments drops comments without a path, position or body', async () => {
    const { client, calls } = stub();
    const result = await quietly(() =>
      client.postReviewComments({
        ...target,
        comments: [
          inline('a.js', 3),
          { path: 'b.js', body: 'no position' },
          { position: 2, body: 'no path' },
          { path: 'c.js', position: 4 },
        ],
      })
    );
    nodeAssert.strictEqual(calls.reviews[0].comments.length, 1);
    nodeAssert.strictEqual(result.comments.length, 1);

    const none = stub();
    const nothing = await quietly(() =>
      none.client.postReviewComments({
        ...target,
        comments: [{ path: 'x.js', body: 'invalid' }],
      })
    );
    nodeAssert.strictEqual(nothing, null);
    nodeAssert.strictEqual(none.calls.reviews.length, 0);
  });

  await test('a 422 falls back to one comment at a time, the rejected one absent', async () => {
    const { client, calls } = stub({
      failReview: httpError(422, 'Unprocessable Entity'),
      failComment: (args) => args.path === 'b.js',
    });
    const result = await quietly(() =>
      client.postReviewComments({
        ...target,
        comments: [inline('a.js', 3), inline('b.js', 7), inline('c.js', 9)],
      })
    );
    nodeAssert.strictEqual(calls.reviews.length, 1, 'the review is tried once');
    nodeAssert.strictEqual(calls.comments.length, 3, 'one call per comment');
    nodeAssert.strictEqual(calls.comments[0].commit_id, 'abc123');
    nodeAssert.deepStrictEqual(result, {
      id: 88,
      comments: [
        { path: 'a.js', position: 3 },
        { path: 'c.js', position: 9 },
      ],
    });
  });

  await test('a 422 where every comment also fails returns null', async () => {
    const { client } = stub({
      failReview: httpError(422, 'Unprocessable Entity'),
      failComment: () => true,
    });
    const result = await quietly(() =>
      client.postReviewComments({ ...target, comments: [inline('a.js', 3)] })
    );
    nodeAssert.strictEqual(result, null);
  });

  await test('a 502 returns null and posts nothing one by one, so nothing doubles', async () => {
    const { client, calls } = stub({
      failReview: httpError(502, 'Bad Gateway'),
    });
    const result = await quietly(() =>
      client.postReviewComments({
        ...target,
        comments: [inline('a.js', 3), inline('b.js', 7)],
      })
    );
    nodeAssert.strictEqual(result, null);
    nodeAssert.strictEqual(calls.reviews.length, 1);
    nodeAssert.strictEqual(calls.comments.length, 0);
  });

  await test('fetchPRFiles reads pages of 70 until a short page', async () => {
    const asked = [];
    const client = createGitHubClient({
      rest: {
        pulls: {
          listFiles: async ({ per_page, page }) => {
            asked.push({ per_page, page });
            const n = page < 3 ? 70 : 5;
            return {
              data: Array.from({ length: n }, (_, i) => ({
                filename: `f${page}-${i}`,
              })),
            };
          },
        },
      },
    });
    const files = await client.fetchPRFiles(target);
    nodeAssert.strictEqual(files.length, 145);
    nodeAssert.deepStrictEqual(asked, [
      { per_page: 70, page: 1 },
      { per_page: 70, page: 2 },
      { per_page: 70, page: 3 },
    ]);
    nodeAssert.strictEqual(
      client.fetchPRDiff,
      undefined,
      'the .diff fetch is gone'
    );
  });

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
