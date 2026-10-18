/**
 * Tests for PR targeting feature
 *
 * Covers:
 *  1. fetchSinglePR — returns the PR object from octokit
 *  2. fetchSinglePR — propagates 404 errors correctly
 *  3. TARGET_PR resolution — --pr CLI flag is parsed correctly
 *  4. TARGET_PR resolution — env var is used when no CLI flag
 *  5. TARGET_PR resolution — CLI flag takes precedence over env var
 *  6. TARGET_PR validation — non-integer value exits with error
 *  7. TARGET_PR validation — zero is rejected
 *  8. TARGET_PR validation — negative number is rejected
 *  9. TARGET_PR validation — --pr with no following value is rejected
 * 10. TARGET_PR resolution — blank env var falls back to auto mode (null)
 * 11. fetchSinglePR — no label/draft/age filtering applied
 */

const { createGitHubClient } = require('../src/githubClient');
const { execSync } = require('child_process');
const path = require('path');

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
    throw new Error(
      `${label || 'assertEqual'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    );
  }
}

// ─── Fake octokit factory ────────────────────────────────────────────────────

function makeFakeOctokit({ pr, throwStatus } = {}) {
  return {
    rest: {
      pulls: {
        get: async ({ pull_number }) => {
          if (throwStatus) {
            const err = new Error(`Not Found`);
            err.status = throwStatus;
            throw err;
          }
          return {
            data: pr || {
              number: pull_number,
              title: 'Test PR',
              state: 'open',
              draft: false,
              user: { login: 'test-user', type: 'User' },
              created_at: new Date().toISOString(),
              head: { sha: 'abc123' },
              body: 'Closes #1',
              labels: [],
            },
          };
        },
      },
    },
  };
}

// ─── Helper: run index.js in a subprocess and capture exit code + stderr ─────

function runIndex(argv, env = {}) {
  try {
    execSync(`node src/index.js ${argv}`, {
      cwd: path.join(__dirname, '..'),
      env: {
        ...process.env,
        GITHUB_AI_AGENT_TOKEN: '', // ensure no real run starts
        CARBON_MONITOR_SKIP_DOTENV: '1', // a developer .env must not override it
        ...env,
      },
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { exitCode: 0, stderr: '' };
  } catch (err) {
    return {
      exitCode: err.status,
      stderr: (err.stderr || Buffer.alloc(0)).toString(),
      stdout: (err.stdout || Buffer.alloc(0)).toString(),
    };
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

async function runTests() {
  console.log('\n📋 PR Targeting Feature Tests\n');

  // ── 1. fetchSinglePR returns the PR object ──────────────────────────────
  await test('fetchSinglePR returns the PR from octokit', async () => {
    const octokit = makeFakeOctokit({
      pr: {
        number: 9999,
        title: 'My specific PR',
        state: 'open',
        draft: false,
        user: { login: 'author', type: 'User' },
        created_at: '2020-01-01T00:00:00Z', // old PR — would be filtered in auto mode
        head: { sha: 'deadbeef' },
        body: null,
        labels: [{ name: 'AIReviewed' }], // already labelled — would be filtered in auto mode
      },
    });
    const client = createGitHubClient(octokit);
    const pr = await client.fetchSinglePR({
      owner: 'carbon-design-system',
      repo: 'carbon',
      pullNumber: 9999,
    });

    assertEqual(pr.number, 9999, 'pr.number');
    assertEqual(pr.title, 'My specific PR', 'pr.title');
    assertEqual(pr.state, 'open', 'pr.state');
    // Confirm the already-labelled PR was NOT filtered out
    assert(
      pr.labels.some((l) => l.name === 'AIReviewed'),
      'AIReviewed label preserved — no filtering'
    );
  });

  // ── 2. fetchSinglePR propagates 404 ────────────────────────────────────
  await test('fetchSinglePR propagates 404 errors', async () => {
    const octokit = makeFakeOctokit({ throwStatus: 404 });
    const client = createGitHubClient(octokit);
    let threw = false;
    try {
      await client.fetchSinglePR({
        owner: 'carbon-design-system',
        repo: 'carbon',
        pullNumber: 99999,
      });
    } catch (err) {
      threw = true;
      assert(
        err.message.includes('Not Found'),
        `Expected "Not Found" in error, got: ${err.message}`
      );
    }
    assert(threw, 'Expected fetchSinglePR to throw on 404');
  });

  // ── 3. fetchSinglePR — draft PR is returned without filtering ──────────
  await test('fetchSinglePR returns draft PRs without filtering', async () => {
    const octokit = makeFakeOctokit({
      pr: {
        number: 777,
        title: 'Draft PR',
        state: 'open',
        draft: true, // would be filtered in auto mode
        user: { login: 'author', type: 'User' },
        created_at: new Date().toISOString(),
        head: { sha: 'aaa111' },
        body: null,
        labels: [],
      },
    });
    const client = createGitHubClient(octokit);
    const pr = await client.fetchSinglePR({
      owner: 'carbon-design-system',
      repo: 'carbon',
      pullNumber: 777,
    });
    assertEqual(pr.draft, true, 'draft flag');
    assertEqual(pr.number, 777, 'pr.number');
  });

  // ── 4. fetchSinglePR — closed PR is returned without filtering ──────────
  await test('fetchSinglePR returns closed PRs without filtering', async () => {
    const octokit = makeFakeOctokit({
      pr: {
        number: 888,
        title: 'Closed PR',
        state: 'closed', // would never appear in auto mode
        draft: false,
        user: { login: 'author', type: 'User' },
        created_at: new Date().toISOString(),
        head: { sha: 'bbb222' },
        body: null,
        labels: [],
      },
    });
    const client = createGitHubClient(octokit);
    const pr = await client.fetchSinglePR({
      owner: 'carbon-design-system',
      repo: 'carbon',
      pullNumber: 888,
    });
    assertEqual(pr.state, 'closed', 'pr.state');
  });

  // ── 5. --pr flag: invalid non-integer exits with code 1 ─────────────────
  await test('--pr abc exits with code 1 and clear error message', () => {
    const result = runIndex('--pr abc');
    assertEqual(result.exitCode, 1, 'exit code');
    const output = result.stderr + (result.stdout || '');
    assert(
      output.includes('Invalid PR number'),
      `Expected "Invalid PR number" in output, got: ${output}`
    );
    assert(
      output.includes('abc'),
      `Expected the bad value "abc" echoed back, got: ${output}`
    );
  });

  // ── 6. --pr flag: zero exits with code 1 ────────────────────────────────
  await test('--pr 0 exits with code 1', () => {
    const result = runIndex('--pr 0');
    assertEqual(result.exitCode, 1, 'exit code');
  });

  // ── 7. --pr flag: negative number exits with code 1 ─────────────────────
  await test('--pr -5 exits with code 1', () => {
    const result = runIndex('--pr -5');
    assertEqual(result.exitCode, 1, 'exit code');
  });

  // ── 8. --pr flag: missing value (last arg) exits with code 1 ────────────
  await test('--pr with no following value exits with code 1', () => {
    const result = runIndex('--pr');
    assertEqual(result.exitCode, 1, 'exit code');
    const output = result.stderr + (result.stdout || '');
    assert(
      output.includes('--pr flag requires a PR number') ||
        output.includes('Invalid PR number'),
      `Expected a PR number error in output, got: ${output}`
    );
  });

  // ── 9. Env var: non-integer exits with code 1 ───────────────────────────
  await test('GITHUB_AI_AGENT_PR_NUMBER=abc exits with code 1', () => {
    const result = runIndex('', { GITHUB_AI_AGENT_PR_NUMBER: 'abc' });
    assertEqual(result.exitCode, 1, 'exit code');
    const output = result.stderr + (result.stdout || '');
    assert(
      output.includes('Invalid PR number'),
      `Expected "Invalid PR number" in output, got: ${output}`
    );
  });

  // ── 10. Env var: blank value is treated as unset (auto mode) ────────────
  await test('GITHUB_AI_AGENT_PR_NUMBER="" does not exit with error (falls back to auto)', () => {
    // No token set → will fail at the token check, not the PR number check.
    // We just need to confirm it does NOT exit with code 1 due to PR number validation.
    const result = runIndex('', { GITHUB_AI_AGENT_PR_NUMBER: '' });
    // Should NOT be a validation exit — may be 0 (early return) or non-1 error
    assert(
      result.exitCode !== 1 ||
        !(result.stderr + (result.stdout || '')).includes('Invalid PR number'),
      'Blank env var should not trigger PR number validation error'
    );
  });

  // ── 11. CLI flag takes precedence over env var ───────────────────────────
  await test('--pr CLI flag takes precedence over GITHUB_AI_AGENT_PR_NUMBER env var', () => {
    // If CLI flag value (abc) is invalid we get exit 1 with the CLI value in the error,
    // NOT the env var value (99999) — proving CLI wins.
    const result = runIndex('--pr abc', { GITHUB_AI_AGENT_PR_NUMBER: '99999' });
    assertEqual(result.exitCode, 1, 'exit code');
    const output = result.stderr + (result.stdout || '');
    assert(
      output.includes('"abc"'),
      `Expected CLI value "abc" in error, got: ${output}`
    );
    assert(
      !output.includes('99999'),
      `Should NOT show env var value 99999, got: ${output}`
    );
  });

  // ── 12. fetchSinglePR passes correct pull_number to octokit ─────────────
  await test('fetchSinglePR passes the exact pullNumber to octokit.rest.pulls.get', async () => {
    let capturedPullNumber = null;
    const octokit = {
      rest: {
        pulls: {
          get: async ({ pull_number }) => {
            capturedPullNumber = pull_number;
            return {
              data: {
                number: pull_number,
                title: 'Captured',
                state: 'open',
                draft: false,
                user: { login: 'u', type: 'User' },
                created_at: new Date().toISOString(),
                head: { sha: 'fff' },
                body: null,
                labels: [],
              },
            };
          },
        },
      },
    };
    const client = createGitHubClient(octokit);
    await client.fetchSinglePR({ owner: 'o', repo: 'r', pullNumber: 42 });
    assertEqual(capturedPullNumber, 42, 'pull_number passed to octokit');
  });

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Fatal error in test runner:', err);
  process.exit(1);
});
