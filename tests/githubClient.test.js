/**
 * Tests for createOctokit (src/githubClient.js), fully offline via a mocked fetch
 *
 *  1. The instance carries paginate and the retry plugin
 *  2. A 502 on a read is retried; a 502 on a write is not (no duplicate comments)
 *  3. The rate-limit handler retries at most twice and only for waits of 60 s or less
 */

const { createOctokit, rateLimitHandler } = require('../src/githubClient');

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

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
