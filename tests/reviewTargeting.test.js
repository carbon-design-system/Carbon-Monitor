/**
 * Tests for PR-list review targeting and MCP disconnect
 *
 * Two features share this file because they share a risk: both are reachable
 * from an unauthenticated-by-default HTTP endpoint on a single-instance
 * deployment, so both must fail by returning a value rather than by throwing or
 * exiting. The CRITICAL case is test 23 — src/index.js resolves --pr and
 * GITHUB_AI_AGENT_PR_NUMBER at module load and calls process.exit(1) on a bad
 * value, and no request may ever reach that path.
 *
 * Covers:
 *  1. Absent, null, blank and empty input all mean auto-select
 *  2. An array of numbers is accepted
 *  3. A comma-separated string is accepted, whitespace and all
 *  4. A single PR, as a string or a one-element array
 *  5. Zero is rejected and the message names it
 *  6. Negative numbers are rejected
 *  7. Decimals are rejected
 *  8. Non-numeric text is rejected and the message names it
 *  9. null, booleans and objects inside the list are rejected
 * 10. A prNumbers value that is neither array nor string is rejected
 * 11. An empty entry — a stray comma — is rejected
 * 12. Duplicates are removed and order is preserved
 * 13. Exactly maxPRs is accepted
 * 14. maxPRs + 1 is rejected, naming both the limit and the count received
 * 15. The maxPRs argument overrides the default
 * 16. The default limit is MAX_PRS_PER_REPO
 * 17. An explicit list outranks TARGET_PR
 * 18. TARGET_PR is used when the caller names nothing
 * 19. Neither present means auto
 * 20. A blank list does not displace TARGET_PR
 * 21. resolveReviewTargets reports an invalid list instead of throwing
 * 22. The TARGET_PR default really binds to GITHUB_AI_AGENT_PR_NUMBER
 * 23. POST /api/review/trigger answers a bad list with 400 — and does NOT exit
 * 24. POST /api/review/trigger rejects a non-array, non-string prNumbers
 * 25. POST /api/review/trigger enforces the same limit as parsePrNumbers
 * 26. POST /api/review/trigger answers a null or scalar body with 400, not 500
 * 27. disconnect strips both credential headers from Bob's mcp.json
 * 28. disconnect preserves operator-tuned fields and unrelated headers
 * 29. disconnect clears the stored refresh token
 * 30. getStatus reports nothing usable after a disconnect
 * 31. disconnect is idempotent
 * 32. disconnect removes a hand-edited lowercase authorization header
 * 33. disconnect on a never-connected install is not an error
 * 34. POST /api/mcp/disconnect is routed and reports success
 * 35. POST /api/review/logs/clear empties the buffer and counts what it dropped
 * 36. Clearing an already-empty buffer reports zero rather than failing
 * 37. Clearing does NOT restart the sequence counter
 * 38. A caught-up client is not told output was dropped
 * 39. A client that was behind IS told output was dropped
 * 40. Clearing mid-run keeps capture active and new output arriving
 * 41. The clear endpoint is POST-only — GET is not routed
 * 42. parsePrRefs validates, deduplicates by key and caps per repository
 * 43. prs outranks prNumbers, which outranks TARGET_PR; TARGET_PR may name a repo
 * 44. --pr and GITHUB_AI_AGENT_PR_NUMBER take 1204 or repo#1204 and reject a repo not listed
 * 45. Auto mode queues every carbon PR before any carbon-ai-chat PR, capped per repo
 * 46. An explicit prs list in caic-then-carbon order is reviewed carbon first
 * 47. carbon#1204 and carbon-ai-chat#1204 post to their own repos
 * 48. Run and per-PR events, the ledger and the digest name the right repositories
 * 49. Typed numbers resolve with a cap of 2: 2 + 2 succeed, 3 in one repo fail before any review
 * 50. The same final cap holds for prs; duplicates collapse before it is counted
 * 51. A bare number that matches two repos, or none, fails the run before any review
 * 52. An open-PR tiebreak is logged before any review, and a console note reaches the log
 * 53. A profile failure starts no reviews, emits run_failed and rejects
 * 54. A scheduled profile failure sends the run-failure Slack payload, not a low-token alert
 * 55. A Slack failure does not replace the profile error; a manual run sends nothing
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { EventEmitter } = require('events');

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

function assertList(actual, expected, label) {
  assertEqual(JSON.stringify(actual), JSON.stringify(expected), label);
}

/**
 * Sandbox every path the modules under test write to, BEFORE requiring them.
 *
 * mcpConnection derives Bob's config path from os.homedir(), so without this the
 * disconnect tests would delete the developer's own working Carbon MCP session.
 * GITHUB_AI_AGENT_PR_NUMBER is pinned empty so a value in the repo's .env cannot
 * make TARGET_PR non-null and quietly invert the precedence tests — dotenv never
 * overrides a key that is already present, even when its value is blank.
 */
const sandbox = fs.mkdtempSync(
  path.join(os.tmpdir(), 'carbon-monitor-targeting-')
);
const originalHome = process.env.HOME;
process.env.HOME = sandbox;
process.env.MCP_STATE_PATH = path.join(sandbox, 'state.json');
process.env.GITHUB_AI_AGENT_PR_NUMBER = '';
process.env.AUTH_REQUIRED = 'false';
// Two repos and a cap of 2 per repo; fixed here because constants.js reads them
// once. A fake webhook enables the run-failure alert, and every https call is
// refused until a case installs its own stub.
process.env.CARBON_MONITOR_SKIP_DOTENV = '1';
process.env.GITHUB_AI_AGENT_REPOS = 'carbon,carbon-ai-chat';
process.env.GITHUB_AI_AGENT_MAX_PRS = '2';
// Read when src/index.js loads, which the harness below does before any case runs.
process.env.GITHUB_AI_AGENT_TOKEN = 'test-token';
delete process.env.ES_URL;
delete process.env.BOB_API_KEY;
process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.com/services/T0/B0/test';
const https = require('https');
const refuseHttps = () => {
  throw new Error('unexpected https request');
};
https.request = refuseHttps;

// Patches the modules src/index.js destructures, so it must run before it loads.
const harness = require('./fixtures/concurrencyHarness');
harness.install();

const INDEX_PATH = path.join(__dirname, '..', 'src', 'index.js');
const REPO_ROOT = path.join(__dirname, '..');

const {
  parsePrNumbers,
  parsePrRefs,
  resolveReviewTargets,
} = require('../src/index');
const { MAX_PRS_PER_REPO, GITHUB_REPOS } = require('../src/constants');
const slack = require('../src/slackNotifier');
const profiles = require('../src/profiles');
// The most one run may name before repositories are known.
const AGGREGATE_CAP = MAX_PRS_PER_REPO * GITHUB_REPOS.length;
const mcp = require('../src/api/mcpConnection');
const reviewLog = require('../src/api/reviewLog');
const { handleRequest } = require('../src/api/server');

const configPath = mcp.getBobMcpConfigPath();

function readConfig() {
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

function readStateFile() {
  return JSON.parse(fs.readFileSync(process.env.MCP_STATE_PATH, 'utf8'));
}

// ─── Fake req/res, enough for handleRequest ──────────────────────────────────

function makeReq({ method = 'POST', url = '/', body }) {
  const chunks =
    body === undefined
      ? []
      : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))];

  return {
    method,
    url,
    headers: { host: 'localhost' },
    // readJsonBody consumes the request with `for await`, so it must be async
    // iterable — not merely an object with a body property.
    [Symbol.asyncIterator]: async function* () {
      for (const chunk of chunks) yield chunk;
    },
  };
}

function makeRes() {
  return {
    statusCode: null,
    headers: {},
    body: '',
    headersSent: false,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      Object.assign(this.headers, headers || {});
      this.headersSent = true;
    },
    end(chunk) {
      if (chunk) this.body += chunk;
    },
  };
}

async function callApi(options) {
  const res = makeRes();
  await handleRequest(makeReq(options), res);
  return {
    status: res.statusCode,
    json: res.body ? JSON.parse(res.body) : null,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n🎯 Review targeting and MCP disconnect tests\n');

  // ── parsePrNumbers: the auto path ────────────────────────────────────────

  await test('absent, null, blank and empty input all mean auto-select', () => {
    for (const input of [undefined, null, '', '   ', []]) {
      const result = parsePrNumbers(input);
      assert(result.ok, `${JSON.stringify(input)} should be accepted`);
      assertEqual(
        result.prNumbers,
        null,
        `${JSON.stringify(input)} should select auto mode`
      );
    }
  });

  // ── parsePrNumbers: accepted shapes ──────────────────────────────────────

  await test('an array of numbers is accepted', () => {
    const result = parsePrNumbers([22971, 22972]);
    assert(result.ok, result.error);
    assertList(result.prNumbers, [22971, 22972], 'prNumbers');
  });

  await test('a comma-separated string is accepted, whitespace and all', () => {
    const result = parsePrNumbers(' 22971 ,22972 , 22973 ');
    assert(result.ok, result.error);
    assertList(result.prNumbers, [22971, 22972, 22973], 'prNumbers');
  });

  await test('a single PR, as a string or a one-element array', () => {
    assertList(parsePrNumbers('22971').prNumbers, [22971], 'string form');
    assertList(parsePrNumbers([22971]).prNumbers, [22971], 'array form');
    assertList(
      parsePrNumbers(['22971']).prNumbers,
      [22971],
      'array of strings'
    );
  });

  // ── parsePrNumbers: rejected entries ─────────────────────────────────────

  await test('zero is rejected and the message names it', () => {
    for (const input of [[0], '0', '22971,0']) {
      const result = parsePrNumbers(input);
      assert(!result.ok, `${JSON.stringify(input)} should be rejected`);
      assert(
        result.error.includes('0'),
        `message should name the value: ${result.error}`
      );
    }
  });

  await test('negative numbers are rejected', () => {
    for (const input of [[-5], '-5', [22971, -1]]) {
      assert(
        !parsePrNumbers(input).ok,
        `${JSON.stringify(input)} should be rejected`
      );
    }
  });

  await test('decimals are rejected', () => {
    for (const input of [[22971.5], '22971.5', ['22971.0']]) {
      const result = parsePrNumbers(input);
      assert(!result.ok, `${JSON.stringify(input)} should be rejected`);
    }
  });

  await test('non-numeric text is rejected and the message names it', () => {
    const result = parsePrNumbers('abc');
    assert(!result.ok, '"abc" should be rejected');
    assert(
      result.error.includes('abc'),
      `message should name the value: ${result.error}`
    );
    assert(
      !parsePrNumbers(['22971', 'abc']).ok,
      'one bad entry rejects the list'
    );
    // Number() would read these as 16, 1000 and 5 — a typo must never resolve to
    // some other repository's PR.
    for (const sneaky of ['0x10', '1e3', '+5', 'NaN', 'Infinity']) {
      assert(!parsePrNumbers([sneaky]).ok, `${sneaky} should be rejected`);
    }
  });

  await test('null, booleans and objects inside the list are rejected', () => {
    for (const entry of [
      null,
      undefined,
      true,
      false,
      {},
      [],
      { number: 22971 },
    ]) {
      const result = parsePrNumbers([entry]);
      assert(!result.ok, `${JSON.stringify(entry)} should be rejected`);
      assert(
        result.prNumbers === null,
        'a rejected list must not also return numbers'
      );
    }
  });

  await test('a prNumbers value that is neither array nor string is rejected', () => {
    for (const input of [22971, true, { prNumbers: [1] }, () => {}]) {
      const result = parsePrNumbers(input);
      assert(!result.ok, `${typeof input} should be rejected`);
      assert(
        result.error.includes('array') && result.error.includes('string'),
        `message should say what is accepted: ${result.error}`
      );
    }
  });

  await test('an empty entry — a stray comma — is rejected', () => {
    for (const input of ['22971,', ',22971', '22971,,22972', ['']]) {
      const result = parsePrNumbers(input);
      assert(!result.ok, `${JSON.stringify(input)} should be rejected`);
      assert(
        result.error.includes('empty'),
        `message should say so: ${result.error}`
      );
    }
  });

  // ── parsePrNumbers: dedup and limits ─────────────────────────────────────

  await test('duplicates are removed and order is preserved', () => {
    const result = parsePrNumbers('22973, 22971, 22973, 22972, 22971');
    assert(result.ok, result.error);
    assertList(result.prNumbers, [22973, 22971, 22972], 'prNumbers');
  });

  await test('exactly the aggregate limit is accepted', () => {
    const list = Array.from({ length: AGGREGATE_CAP }, (_, i) => 22971 + i);
    const result = parsePrNumbers(list);
    assert(result.ok, result.error);
    assertEqual(result.prNumbers.length, AGGREGATE_CAP, 'accepted count');
  });

  await test('the aggregate limit + 1 is rejected, naming both the limit and the count', () => {
    const list = Array.from({ length: AGGREGATE_CAP + 1 }, (_, i) => 22971 + i);
    const result = parsePrNumbers(list);
    assert(!result.ok, 'over the limit should be rejected');
    assert(
      result.error.includes(String(AGGREGATE_CAP)),
      `message should state the limit: ${result.error}`
    );
    assert(
      result.error.includes(String(AGGREGATE_CAP + 1)),
      `message should state the count received: ${result.error}`
    );
  });

  await test('the maxPRs argument overrides the default', () => {
    assert(parsePrNumbers([1, 2, 3], 3).ok, 'three under a limit of three');
    assert(!parsePrNumbers([1, 2, 3, 4], 3).ok, 'four over a limit of three');
    // Deduplication happens first, so a repeated PR does not consume budget.
    assert(
      parsePrNumbers([1, 1, 2, 2, 3], 3).ok,
      'duplicates must not count toward the limit'
    );
  });

  await test('the default limit is MAX_PRS_PER_REPO times the number of repos', () => {
    const overBy = Array.from({ length: AGGREGATE_CAP + 1 }, (_, i) => i + 1);
    assert(
      !parsePrNumbers(overBy).ok,
      'the default must be the aggregate maximum'
    );
    assert(
      parsePrNumbers(overBy, AGGREGATE_CAP + 1).ok,
      'raising the limit admits it'
    );
    // Not the per-repo cap: bare numbers have no repository yet.
    assert(
      parsePrNumbers(
        Array.from({ length: MAX_PRS_PER_REPO + 1 }, (_, i) => i + 1)
      ).ok,
      'more than one repo cap of numbers is fine before they are resolved'
    );
  });

  // ── resolveReviewTargets: precedence ─────────────────────────────────────

  await test('an explicit list outranks TARGET_PR', () => {
    const target = resolveReviewTargets(
      { prNumbers: [22971, 22972] },
      { repo: null, number: 4242 }
    );
    assert(target.ok, target.error);
    assertEqual(target.mode, 'explicit', 'mode');
    assertEqual(target.source, 'argument', 'source');
    assertList(target.prNumbers, [22971, 22972], 'prNumbers');
    assert(
      !target.prNumbers.includes(4242),
      'the pinned env target must not leak in'
    );
  });

  await test('TARGET_PR is used when the caller names nothing', () => {
    for (const options of [undefined, {}, { prNumbers: null }]) {
      const target = resolveReviewTargets(options, {
        repo: null,
        number: 4242,
      });
      assertEqual(target.mode, 'explicit', 'mode');
      assertEqual(target.source, 'cli-env', 'source');
      assertList(target.prNumbers, [4242], 'prNumbers');
      assertEqual(target.refs, null, 'a bare number has no repository yet');
    }
  });

  await test('neither present means auto', () => {
    const target = resolveReviewTargets({}, null);
    assert(target.ok, target.error);
    assertEqual(target.mode, 'auto', 'mode');
    assertEqual(target.prNumbers, null, 'prNumbers');
  });

  await test('a blank list does not displace TARGET_PR', () => {
    // An empty console input box means "you decide", not "review nothing".
    const target = resolveReviewTargets(
      { prNumbers: '' },
      { repo: null, number: 4242 }
    );
    assertEqual(target.mode, 'explicit', 'mode');
    assertList(target.prNumbers, [4242], 'prNumbers');
  });

  await test('resolveReviewTargets reports an invalid list instead of throwing', () => {
    const target = resolveReviewTargets(
      { prNumbers: 'abc' },
      { repo: null, number: 4242 }
    );
    assert(target.ok === false, 'should not be ok');
    assert(
      target.error.includes('abc'),
      `message should name the value: ${target.error}`
    );
    assertEqual(target.prNumbers, null, 'no numbers on a rejection');
  });

  await test('the TARGET_PR default really binds to GITHUB_AI_AGENT_PR_NUMBER', () => {
    // Proven in a child process, because TARGET_PR is resolved once at module
    // load: the only honest way to test the binding is to load the module under
    // a different environment.
    const script = `
      const { resolveReviewTargets } = require(${JSON.stringify(INDEX_PATH)});
      process.stdout.write(JSON.stringify({
        noArgument: resolveReviewTargets(),
        withArgument: resolveReviewTargets({ prNumbers: [22971] }),
      }));
    `;
    const out = execFileSync(process.execPath, ['-e', script], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        GITHUB_AI_AGENT_PR_NUMBER: '4242',
        CARBON_MONITOR_SKIP_DOTENV: '1',
      },
      encoding: 'utf8',
    });

    const result = JSON.parse(out.trim());
    assertList(result.noArgument.prNumbers, [4242], 'env var target');
    assertEqual(
      result.noArgument.source,
      'cli-env',
      'source without an argument'
    );
    assertList(result.withArgument.prNumbers, [22971], 'argument wins');
    assertEqual(
      result.withArgument.source,
      'argument',
      'source with an argument'
    );
  });

  // ── The route enforces the same rules, and survives them ─────────────────

  await test('POST /api/review/trigger answers a bad list with 400 — and does NOT exit', () => {
    // If validation ever routed back to index.js's load-time TARGET_PR check,
    // this call would take the whole test process out with exit code 1 instead
    // of returning. Reaching the assertions below is itself the proof.
    return callApi({
      method: 'POST',
      url: '/api/review/trigger',
      body: { prNumbers: 'abc' },
    }).then(({ status, json }) => {
      assertEqual(status, 400, 'status');
      assert(
        json.error.includes('abc'),
        `message should name the value: ${json.error}`
      );
      assert(
        process.exitCode === undefined || process.exitCode === 0,
        'process must be unharmed'
      );
    });
  });

  await test('POST /api/review/trigger rejects a non-array, non-string prNumbers', async () => {
    const { status, json } = await callApi({
      method: 'POST',
      url: '/api/review/trigger',
      body: { prNumbers: { first: 22971 } },
    });
    assertEqual(status, 400, 'status');
    assert(
      json.error.includes('array'),
      `message should say what is accepted: ${json.error}`
    );
  });

  await test('POST /api/review/trigger enforces the same limit as parsePrNumbers', async () => {
    const list = Array.from({ length: AGGREGATE_CAP + 1 }, (_, i) => 22971 + i);
    const { status, json } = await callApi({
      method: 'POST',
      url: '/api/review/trigger',
      body: { prNumbers: list },
    });
    assertEqual(status, 400, 'status');
    assert(
      json.error.includes(String(AGGREGATE_CAP)),
      `message should state the limit: ${json.error}`
    );
  });

  await test('POST /api/review/trigger answers a null or scalar body with 400, not 500', async () => {
    // JSON.parse('null') returns null, and reading .prNumbers off it throws.
    for (const raw of ['null', '5', '"22971"', '[22971]']) {
      const { status, json } = await callApi({
        method: 'POST',
        url: '/api/review/trigger',
        body: raw,
      });
      assertEqual(status, 400, `status for body ${raw}`);
      assert(
        json.error.includes('JSON object'),
        `message should say so: ${json.error}`
      );
    }
  });

  // ── Disconnect ───────────────────────────────────────────────────────────

  await test('disconnect strips both credential headers from mcp.json', async () => {
    await mcp.writeBobMcpHeaders({
      token: 'token-one',
      sessionId: 'session-one',
    });

    const result = await mcp.disconnect();
    assertEqual(result.disconnected, true, 'disconnected');
    assertEqual(result.hadToken, true, 'hadToken');
    assertEqual(result.hadSession, true, 'hadSession');

    const headers = readConfig().mcpServers['carbon-mcp'].headers;
    assert(!headers.Authorization, 'the bearer must be gone');
    assert(
      !headers['X-MCP-Session'],
      'the session id must be gone — it mints new bearers'
    );
  });

  await test('disconnect preserves operator-tuned fields and unrelated headers', async () => {
    const config = readConfig();
    config.mcpServers['carbon-mcp'].timeout = 999000;
    config.mcpServers['carbon-mcp'].alwaysAllow = ['code_search'];
    config.mcpServers['carbon-mcp'].headers = {
      Authorization: 'Bearer token-two',
      'X-MCP-Session': 'session-two',
      'X-Operator-Note': 'keep me',
    };
    config.mcpServers['other-server'] = { type: 'stdio', command: 'echo' };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    await mcp.disconnect();

    const after = readConfig();
    const entry = after.mcpServers['carbon-mcp'];
    assertEqual(
      entry.timeout,
      999000,
      'a custom timeout must survive a disconnect'
    );
    assertEqual(
      entry.alwaysAllow.length,
      1,
      'a customised allow-list must survive'
    );
    assertEqual(
      entry.headers['X-Operator-Note'],
      'keep me',
      'unrelated headers must survive'
    );
    assert(!entry.headers.Authorization, 'the bearer must be gone');
    assert(
      after.mcpServers['other-server'],
      'unrelated servers must be left alone'
    );
  });

  await test('disconnect clears the stored refresh token', async () => {
    // Written directly: the refresh token normally arrives from an OAuth
    // exchange, and it is the one credential that can mint access indefinitely.
    fs.writeFileSync(
      process.env.MCP_STATE_PATH,
      JSON.stringify({
        mode: 'oauth',
        refreshToken: 'refresh-token-that-must-not-survive',
        sessionId: 'session-three',
        needsReauth: false,
      })
    );
    await mcp.writeBobMcpHeaders({ token: 'token-three' });

    const result = await mcp.disconnect();
    assertEqual(result.hadRefreshToken, true, 'hadRefreshToken');

    const state = readStateFile();
    assert(
      !state.refreshToken,
      'the refresh token must not survive a disconnect'
    );
    assert(!state.sessionId, 'the session id must not survive either');
    assertEqual(state.mode, 'none', 'mode');
    assert(
      !JSON.stringify(state).includes('refresh-token-that-must-not-survive'),
      'no trace of the old token may remain in state'
    );
  });

  await test('getStatus reports nothing usable after a disconnect', async () => {
    const status = await mcp.getStatus();
    assertEqual(status.hasToken, false, 'hasToken');
    assertEqual(status.hasSession, false, 'hasSession');
    assertEqual(status.canAutoRefresh, false, 'canAutoRefresh');
    assertEqual(
      status.needsReauth,
      false,
      'a deliberate sign-out is not a failure'
    );
    assertEqual(status.mode, 'none', 'mode');
    assertEqual(status.expiresInSeconds, null, 'nothing left to expire');
  });

  await test('disconnect is idempotent', async () => {
    const first = await mcp.disconnect();
    const second = await mcp.disconnect();
    assertEqual(first.disconnected, true, 'first call');
    assertEqual(second.disconnected, true, 'second call must also succeed');
    assertEqual(second.hadToken, false, 'nothing was left to remove');
    assertEqual(second.hadRefreshToken, false, 'nothing was left to remove');

    const probe = await mcp.probe();
    assertEqual(
      probe.reason,
      'not-configured',
      'no credentials means nothing to probe'
    );
  });

  await test('disconnect removes a hand-edited lowercase authorization header', async () => {
    const config = readConfig();
    config.mcpServers['carbon-mcp'].headers = {
      authorization: 'Bearer hand-edited',
      'x-mcp-session': 'hand-edited-session',
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    await mcp.disconnect();

    const headers = readConfig().mcpServers['carbon-mcp'].headers;
    assertEqual(
      Object.keys(headers).length,
      0,
      'HTTP header names are case-insensitive — a lowercase copy would still authenticate'
    );
  });

  await test('disconnect on a never-connected install is not an error', async () => {
    const fresh = fs.mkdtempSync(
      path.join(os.tmpdir(), 'carbon-monitor-fresh-')
    );
    const previousHome = process.env.HOME;
    const previousState = process.env.MCP_STATE_PATH;
    process.env.HOME = fresh;
    process.env.MCP_STATE_PATH = path.join(fresh, 'state.json');

    try {
      const result = await mcp.disconnect();
      assertEqual(result.disconnected, true, 'disconnected');
      assertEqual(result.hadToken, false, 'nothing was configured');
      assert(
        !fs.existsSync(path.join(fresh, '.bob', 'settings', 'mcp.json')),
        'a disconnect must not conjure a config file that never existed'
      );
    } finally {
      process.env.HOME = previousHome;
      process.env.MCP_STATE_PATH = previousState;
      fs.rmSync(fresh, { recursive: true, force: true });
    }
  });

  await test('POST /api/mcp/disconnect is routed and reports success', async () => {
    await mcp.writeBobMcpHeaders({
      token: 'token-four',
      sessionId: 'session-four',
    });

    const first = await callApi({ method: 'POST', url: '/api/mcp/disconnect' });
    assertEqual(first.status, 200, 'status');
    assertEqual(first.json.success, true, 'success');
    assertEqual(first.json.disconnected, true, 'disconnected');

    const second = await callApi({
      method: 'POST',
      url: '/api/mcp/disconnect',
    });
    assertEqual(second.status, 200, 'a second call is not an error');
    assertEqual(second.json.disconnected, true, 'disconnected');

    const headers = readConfig().mcpServers['carbon-mcp'].headers;
    assert(
      !headers.Authorization && !headers['X-MCP-Session'],
      'credentials must be gone'
    );
  });

  // ── Clearing the review log ──────────────────────────────────────────────

  await test('POST /api/review/logs/clear empties the buffer and counts what it dropped', async () => {
    reviewLog.clear();
    reviewLog.append('fetching PR #22971');
    reviewLog.append('bundle built');
    reviewLog.append('agent thinking');

    const { status, json } = await callApi({
      method: 'POST',
      url: '/api/review/logs/clear',
    });
    assertEqual(status, 200, 'status');
    assertEqual(json.success, true, 'success');
    assertEqual(json.cleared, 3, 'cleared must name how many lines went away');

    const after = await callApi({
      method: 'GET',
      url: '/api/review/logs?since=0',
    });
    assertEqual(after.json.lines.length, 0, 'nothing may survive the clear');
  });

  await test('clearing an already-empty buffer reports zero rather than failing', async () => {
    const { status, json } = await callApi({
      method: 'POST',
      url: '/api/review/logs/clear',
    });
    assertEqual(status, 200, 'a second clear is not an error');
    assertEqual(json.cleared, 0, 'cleared');
  });

  await test('clearing does NOT restart the sequence counter', async () => {
    // The console polls with ?since=N. If clear reset the counter, the next run
    // would reuse seq numbers the client has already rendered — new output would
    // sit below its cursor and never appear, or old output would replay as new.
    reviewLog.clear();
    reviewLog.append('before the clear');

    const first = await callApi({
      method: 'GET',
      url: '/api/review/logs?since=0',
    });
    const cursor = first.json.nextSince;
    assert(cursor > 0, 'the client should hold a cursor');

    await callApi({ method: 'POST', url: '/api/review/logs/clear' });
    reviewLog.append('after the clear');

    const second = await callApi({
      method: 'GET',
      url: `/api/review/logs?since=${cursor}`,
    });
    assertEqual(second.json.lines.length, 1, 'exactly the one new line');
    assertEqual(second.json.lines[0].text, '[batch] after the clear', 'text');
    assert(
      second.json.lines[0].seq > cursor,
      `a cleared buffer must keep counting forwards: seq ${second.json.lines[0].seq} vs cursor ${cursor}`
    );
  });

  await test('a caught-up client is not told output was dropped', async () => {
    reviewLog.clear();
    reviewLog.append('line one');
    reviewLog.append('line two');

    const caughtUp = await callApi({
      method: 'GET',
      url: '/api/review/logs?since=0',
    });
    const cursor = caughtUp.json.nextSince;

    await callApi({ method: 'POST', url: '/api/review/logs/clear' });

    const after = await callApi({
      method: 'GET',
      url: `/api/review/logs?since=${cursor}`,
    });
    assertEqual(after.json.lines.length, 0, 'nothing new to send');
    assertEqual(
      after.json.dropped,
      false,
      'the client had already seen everything discarded'
    );
    assertEqual(
      after.json.nextSince,
      cursor,
      'an empty read must not move the cursor'
    );
  });

  await test('a client that was behind IS told output was dropped', async () => {
    reviewLog.clear();
    for (const text of ['one', 'two', 'three', 'four']) reviewLog.append(text);

    // Reads a single line, leaving this client three behind the buffer.
    const behind = await callApi({
      method: 'GET',
      url: '/api/review/logs?since=0&limit=1',
    });
    assertEqual(behind.json.lines.length, 1, 'one line at a time');
    const cursor = behind.json.nextSince;

    await callApi({ method: 'POST', url: '/api/review/logs/clear' });
    reviewLog.append('five');

    const after = await callApi({
      method: 'GET',
      url: `/api/review/logs?since=${cursor}`,
    });
    assertEqual(
      after.json.dropped,
      true,
      'lines it never saw were discarded — say so'
    );
    assertList(
      after.json.lines.map((l) => l.text),
      ['[batch] five'],
      'only post-clear output remains'
    );
  });

  await test('clearing mid-run keeps capture active and new output arriving', async () => {
    // Nothing inside the try may print: capture is wrapping process.stdout, so
    // any stray logging would land in the buffer under test. The route logging
    // done by handleRequest is expected and is exactly why `cleared` is only
    // asserted to be non-zero.
    reviewLog.clear();
    reviewLog.start('run-under-test');

    try {
      process.stdout.write('output from before the clear\n');

      const { status, json } = await callApi({
        method: 'POST',
        url: '/api/review/logs/clear',
      });
      assertEqual(status, 200, 'clearing during a run is allowed');
      assert(
        json.cleared >= 1,
        `something should have been discarded: ${json.cleared}`
      );

      process.stdout.write('output from after the clear\n');

      const state = reviewLog.read(0);
      assertEqual(
        state.capturing,
        true,
        'a clear must not unhook the stream capture'
      );
      const texts = state.lines.map((l) => l.text);
      assert(
        texts.includes('[batch] output from after the clear'),
        'new output must keep arriving'
      );
      assert(
        !texts.some((t) => t.includes('output from before the clear')),
        'pre-clear output must be gone'
      );
    } finally {
      // Restored even on failure: leaving process.stdout.write wrapped would
      // swallow the rest of this suite's own output.
      reviewLog.stop();
    }

    assertEqual(
      reviewLog.read(0).capturing,
      false,
      'capture must stop cleanly afterwards'
    );
    reviewLog.clear();
  });

  await test('the clear endpoint is POST-only — GET is not routed', async () => {
    const { status } = await callApi({
      method: 'GET',
      url: '/api/review/logs/clear',
    });
    assertEqual(status, 404, 'a GET must not empty the log');
  });

  // ── Refs: validation, precedence and the CLI forms ───────────────────────

  const ref = (repo, number) => ({ repo, number });
  const [R1, R2] = GITHUB_REPOS;

  await test('parsePrRefs validates, deduplicates by key and caps per repository', () => {
    const ok = parsePrRefs([ref(R1, 5), ref(R2, 5), ref(R1, 5)]);
    assert(ok.ok, ok.error);
    assertList(ok.refs, [ref(R1, 5), ref(R2, 5)], 'one PR per key');

    for (const input of [undefined, null, []]) {
      assertEqual(parsePrRefs(input).refs, null, 'not given');
      assert(parsePrRefs(input).ok, 'not given is not an error');
    }
    const unknown = parsePrRefs([ref('elsewhere', 5)]);
    assert(!unknown.ok, 'a repo outside the list');
    assert(
      unknown.error.includes('elsewhere') && unknown.error.includes(R1),
      `names the repo and the list: ${unknown.error}`
    );
    for (const bad of [
      0,
      -1,
      1.5,
      '5',
      null,
      NaN,
      Number.MAX_SAFE_INTEGER + 2,
    ]) {
      assert(!parsePrRefs([ref(R1, bad)]).ok, `${bad} is not a PR number`);
    }
    for (const bad of [5, 'x', ref(R1, 1), [null], [5], [[R1, 1]]]) {
      assert(!parsePrRefs(bad).ok, `${JSON.stringify(bad)} is not a ref list`);
    }

    const capped = parsePrRefs([ref(R1, 1), ref(R1, 2), ref(R1, 3)]);
    assert(!capped.ok, `${MAX_PRS_PER_REPO} per repository`);
    assert(
      capped.error.includes(`Too many PRs for ${R1}: 3`) &&
        capped.error.includes(String(MAX_PRS_PER_REPO)),
      capped.error
    );
    // The cap is per repository and counted after deduplication.
    assert(
      parsePrRefs([ref(R1, 1), ref(R1, 2), ref(R2, 1), ref(R2, 2)]).ok,
      '2 + 2 is within a cap of 2 per repository'
    );
    assert(
      parsePrRefs([ref(R1, 1), ref(R1, 1), ref(R1, 2), ref(R1, 1)]).ok,
      'duplicates do not count'
    );
  });

  await test('prs outranks prNumbers, which outranks TARGET_PR; TARGET_PR may name a repo', () => {
    const pinned = { repo: R2, number: 7 };
    const withRefs = resolveReviewTargets(
      { prs: [ref(R1, 1)], prNumbers: [2, 3] },
      pinned
    );
    assert(withRefs.ok, withRefs.error);
    assertList(withRefs.refs, [ref(R1, 1)], 'refs');
    assertEqual(withRefs.prNumbers, null, 'numbers are not mixed in');
    assertEqual(withRefs.source, 'argument', 'source');

    const numbers = resolveReviewTargets({ prNumbers: [2, 3] }, pinned);
    assertList(numbers.prNumbers, [2, 3], 'prNumbers beat the pinned target');
    assertEqual(numbers.refs, null, 'refs');

    const env = resolveReviewTargets({}, pinned);
    assertList(env.refs, [ref(R2, 7)], 'a pinned repo#number is a ref');
    assertEqual(env.prNumbers, null, 'no number left to look up');
    assertEqual(env.source, 'cli-env', 'source');

    const bad = resolveReviewTargets({ prs: [ref('elsewhere', 1)] }, pinned);
    assert(!bad.ok && bad.error.includes('elsewhere'), 'an invalid ref list');
  });

  await test('--pr and GITHUB_AI_AGENT_PR_NUMBER take 1204 or repo#1204 and reject an unlisted repo', () => {
    const script = `
      const { resolveReviewTargets } = require(${JSON.stringify(INDEX_PATH)});
      process.stdout.write(JSON.stringify(resolveReviewTargets()));
    `;
    const run = (env, args = []) =>
      spawnSync(process.execPath, ['-e', script, '--', ...args], {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          CARBON_MONITOR_SKIP_DOTENV: '1',
          GITHUB_AI_AGENT_PR_NUMBER: '',
          ...env,
        },
        encoding: 'utf8',
      });

    const named = run({ GITHUB_AI_AGENT_PR_NUMBER: `${R2}#1204` });
    assertEqual(named.status, 0, named.stderr);
    assertList(JSON.parse(named.stdout).refs, [ref(R2, 1204)], 'env ref');

    const bare = run({ GITHUB_AI_AGENT_PR_NUMBER: '1204' });
    assertList(JSON.parse(bare.stdout).prNumbers, [1204], 'env number');

    const flag = run({ GITHUB_AI_AGENT_PR_NUMBER: '5' }, ['--pr', `${R1}#9`]);
    assertEqual(flag.status, 0, flag.stderr);
    assertList(JSON.parse(flag.stdout).refs, [ref(R1, 9)], 'the flag wins');

    for (const value of ['nope#7', `${R1}#`, `${R1}#0`, `#7`, `${R1}#7x`]) {
      const result = run({ GITHUB_AI_AGENT_PR_NUMBER: value });
      assertEqual(result.status, 1, `${value} exits 1`);
    }
    const unlisted = run({ GITHUB_AI_AGENT_PR_NUMBER: 'nope#7' });
    assert(
      unlisted.stderr.includes('nope') &&
        unlisted.stderr.includes(GITHUB_REPOS.join(', ')),
      `names the repo and the list: ${unlisted.stderr}`
    );
    assert(
      run({}, ['--pr', 'nope#7']).stderr.includes(GITHUB_REPOS.join(', ')),
      'the flag is checked too'
    );
  });

  // ── Whole batches against the mock GitHub and the fake Bob ───────────────

  const CARBON = 'carbon-design-system/carbon';
  const CAIC = 'carbon-design-system/carbon-ai-chat';
  const fx = (...numbers) => Object.fromEntries(numbers.map((n) => [n, {}]));
  const texts = (run) => run.lines.map((l) => l.text);

  // A run that is expected to reject: the sandbox still cleans up after it.
  async function attempt(o) {
    let error = null;
    const run = await harness.sandbox(o, async ({ reviewPRs, reviewLog }) => {
      reviewLog.start('test');
      try {
        await reviewPRs(o.options);
      } catch (err) {
        error = err;
      } finally {
        reviewLog.stop();
      }
      return reviewLog.read(0, 100000).lines;
    });
    return { ...run, error, lines: run.value };
  }

  const auto = await harness.runBatch({
    concurrency: 1,
    open: { carbon: [11, 12, 13], 'carbon-ai-chat': [21, 22, 23] },
    fixtures: fx(11, 12, 13, 21, 22, 23),
  });

  await test('auto mode queues every carbon PR before any carbon-ai-chat PR, and caps each repo', () => {
    assertList(
      auto.snapshots[0].queued,
      ['carbon#11', 'carbon#12', 'carbon-ai-chat#21', 'carbon-ai-chat#22'],
      'queue'
    );
    for (const key of [
      'carbon#11',
      'carbon#12',
      'carbon-ai-chat#21',
      'carbon-ai-chat#22',
    ]) {
      assertEqual(auto.comments(key).length, 1, `summary on ${key}`);
      assertEqual(auto.labels(key).length, 1, `label on ${key}`);
    }
    for (const key of ['carbon#13', 'carbon-ai-chat#23']) {
      assertEqual(auto.comments(key).length, 0, `${key} is over the cap`);
    }
    const order = auto.writes
      .filter((w) => /\/issues\/\d+\/comments$/.test(w.path))
      .map((w) => w.path.split('/')[3]);
    assertList(
      order,
      ['carbon', 'carbon', 'carbon-ai-chat', 'carbon-ai-chat'],
      'post order'
    );
  });

  await test('each PR is reviewed with its own repository profile', () => {
    const body = (key) => auto.comments(key)[0].body.body;
    assert(body('carbon-ai-chat#21').includes('AI agent review - CAIC'));
    assert(!body('carbon#11').includes('CAIC'), 'core header unchanged');
    const profileOf = (repo, n) =>
      auto.events.find(
        (e) =>
          e.event_type === 'pr_review_started' &&
          e.repo === repo &&
          e.pr_number === n
      ).profile;
    assertEqual(profileOf(CARBON, 11), 'core', 'carbon');
    assertEqual(profileOf(CAIC, 21), 'caic', 'carbon-ai-chat');
  });

  await test('run events, ledger rows and the digest name the right repositories', () => {
    const joined = `${CARBON},${CAIC}`;
    for (const type of ['run_started', 'run_completed']) {
      const e = auto.events.find((x) => x.event_type === type);
      assertEqual(e.repo, joined, `${type} repo`);
      assertList(e.payload.repos, [CARBON, CAIC], `${type} repos`);
    }
    assertEqual(
      auto.events.find((e) => e.event_type === 'run_completed').payload
        .prs_reviewed,
      4,
      'prs_reviewed'
    );
    for (const e of auto.events.filter((x) => x.pr_number)) {
      assert(e.repo === CARBON || e.repo === CAIC, `per-PR repo ${e.repo}`);
    }
    assertList(
      auto.ledger.map((r) => `${r.repo}#${r.prNumber}`).sort(),
      [`${CARBON}#11`, `${CARBON}#12`, `${CAIC}#21`, `${CAIC}#22`],
      'ledger'
    );
    assertEqual(auto.digest.repo, joined, 'digest repo');
    assertList(auto.digest.repos, [CARBON, CAIC], 'digest repos');
    assertList(
      auto.digest.results.map((r) => [r.repo, r.prNumber]),
      [
        ['carbon', 11],
        ['carbon', 12],
        ['carbon-ai-chat', 21],
        ['carbon-ai-chat', 22],
      ],
      'digest results carry their repo, in batch order'
    );
    assert(
      texts(auto).includes(`[batch] [Carbon-Monitor] repos=${joined}`),
      'banner'
    );
  });
  await auto.cleanup();

  const nothing = await harness.runBatch({ concurrency: 1, fixtures: {} });

  await test('a scheduled run with nothing open posts an empty digest for every repo', () => {
    assertList(nothing.digest.results, [], 'results');
    assertList(nothing.digest.repos, [CARBON, CAIC], 'repos');
    assertEqual(nothing.writes.length, 0, 'nothing posted');
  });
  await nothing.cleanup();

  const ordered = await harness.runBatch({
    concurrency: 1,
    prs: [ref(R2, 21), ref(R1, 11)],
    fixtures: fx(11, 21),
  });

  await test('an explicit prs list in caic-then-carbon order is reviewed carbon first', () => {
    assertList(
      ordered.snapshots[0].queued,
      ['carbon#11', 'carbon-ai-chat#21'],
      'queue'
    );
    assertList(
      ordered.digest.results.map((r) => r.repo),
      ['carbon', 'carbon-ai-chat'],
      'digest'
    );
    assertEqual(ordered.bobRuns[0].pr, 11, 'carbon ran first');
    assertEqual(
      ordered.events.find((e) => e.event_type === 'run_completed').payload
        .prs_requested,
      2,
      'prs_requested'
    );
  });
  await ordered.cleanup();

  const same = await harness.runBatch({
    concurrency: 2,
    prs: [ref(R1, 1204), ref(R2, 1204)],
    fixtures: fx(1204),
  });

  await test('carbon#1204 and carbon-ai-chat#1204 post to their own repos', () => {
    for (const key of ['carbon#1204', 'carbon-ai-chat#1204']) {
      assertEqual(same.comments(key).length, 1, `summary on ${key}`);
      assertEqual(same.reviews(key).length, 1, `review on ${key}`);
      assertEqual(same.labels(key).length, 1, `label on ${key}`);
    }
    assertEqual(same.comments(1204).length, 2, 'a bare number matches both');
    for (const repo of ['carbon', 'carbon-ai-chat']) {
      assert(
        texts(same).some((t) => t.includes(`Reviewing ${repo}#1204:`)),
        repo
      );
      assert(
        texts(same).some((t) => t.includes(`${repo}#1204 review complete`)),
        repo
      );
    }
    assertEqual(
      new Set(same.ledger.map((r) => r.repo)).size,
      2,
      'ledger repos'
    );
    assert(
      same.bundles['carbon#1204'].dir !==
        same.bundles['carbon-ai-chat#1204'].dir
    );
  });
  await same.cleanup();

  const fetchFailed = await harness.runBatch({
    concurrency: 1,
    prs: [ref(R1, 11), ref(R1, 404)],
    repoOf: { 404: R2 },
    fixtures: fx(11),
  });

  await test('a ref that cannot be fetched is reported with its repo and the rest still run', () => {
    assertEqual(fetchFailed.comments('carbon#11').length, 1, 'the other PR');
    assert(
      texts(fetchFailed).some((t) => t.includes('Could not fetch carbon#404'))
    );
    const failure = fetchFailed.events.find(
      (e) => e.event_type === 'pr_review_failed'
    );
    assertEqual(failure.repo, CARBON, 'repo');
    assertEqual(failure.pr_number, 404, 'pr');
    assertEqual(failure.profile, 'core', 'profile');
    assertEqual(
      fetchFailed.events.find((e) => e.event_type === 'run_completed').payload
        .prs_fetch_failed,
      1,
      'prs_fetch_failed'
    );
  });
  await fetchFailed.cleanup();

  // ── The per-repository cap with typed numbers (cap 2) ────────────────────

  const split = await harness.runBatch({
    concurrency: 2,
    prNumbers: [1, 2, 3, 4],
    repoOf: { 1: R1, 2: R1, 3: R2, 4: R2 },
    fixtures: fx(1, 2, 3, 4),
  });

  await test('four numbers resolving 2 + 2 succeed under a cap of 2 per repository', () => {
    for (const key of [
      'carbon#1',
      'carbon#2',
      'carbon-ai-chat#3',
      'carbon-ai-chat#4',
    ]) {
      assertEqual(split.comments(key).length, 1, `summary on ${key}`);
    }
    assertEqual(
      split.writes.filter((w) => w.path.endsWith('/comments')).length,
      4
    );
  });
  await split.cleanup();

  const overCap = await attempt({
    concurrency: 2,
    options: { prNumbers: [1, 2, 3] },
    repoOf: { 1: R1, 2: R1, 3: R1 },
    fixtures: fx(1, 2, 3),
  });

  await test('three numbers resolving to carbon fail before any review starts', () => {
    assert(overCap.error, 'the run rejects');
    assert(
      overCap.error.message.includes(`Too many PRs for ${R1}: 3 requested`) &&
        overCap.error.message.includes(`at most ${MAX_PRS_PER_REPO}`),
      overCap.error.message
    );
    assertEqual(overCap.writes.length, 0, 'nothing posted');
    assertEqual(overCap.bobRuns.length, 0, 'no agent ran');
    assert(
      !overCap.events.some((e) => e.event_type === 'run_started'),
      'no run began'
    );
  });
  await overCap.cleanup();

  const overRefs = await attempt({
    concurrency: 2,
    options: { prs: [ref(R2, 1), ref(R2, 2), ref(R2, 3)] },
    fixtures: fx(1, 2, 3),
  });
  const overflow = await attempt({
    concurrency: 2,
    options: { prNumbers: [1, 2, 3, 4, 5] },
    repoOf: { 1: R1, 2: R1, 3: R2, 4: R2, 5: R2 },
    fixtures: fx(1, 2, 3, 4, 5),
  });
  const dupes = await harness.runBatch({
    concurrency: 2,
    prs: [ref(R1, 1), ref(R2, 1), ref(R1, 1), ref(R1, 2), ref(R1, 1)],
    fixtures: fx(1, 2),
  });

  await test('the same final cap holds for prs, aggregate overflow and duplicates', () => {
    assert(
      overRefs.error &&
        overRefs.error.message.includes(`Too many PRs for ${R2}: 3`),
      overRefs.error && overRefs.error.message
    );
    assertEqual(
      overRefs.writes.length + overRefs.bobRuns.length,
      0,
      'prs: nothing ran'
    );

    assert(
      overflow.error &&
        overflow.error.message.includes(`${AGGREGATE_CAP + 1} requested`) &&
        overflow.error.message.includes(`at most ${AGGREGATE_CAP}`),
      overflow.error && overflow.error.message
    );
    assertEqual(
      overflow.writes.length + overflow.bobRuns.length,
      0,
      'overflow: nothing ran'
    );

    // Five refs name three PRs: carbon#1, carbon#2 and carbon-ai-chat#1.
    for (const key of ['carbon#1', 'carbon#2', 'carbon-ai-chat#1']) {
      assertEqual(dupes.comments(key).length, 1, `one summary on ${key}`);
    }
    assertEqual(dupes.bobRuns.length, 3, 'three reviews, not five');
  });
  await Promise.all([overRefs, overflow, dupes].map((r) => r.cleanup()));

  // ── A number that does not resolve to exactly one PR ─────────────────────

  const ambiguous = await attempt({
    concurrency: 1,
    options: { prNumbers: [1204] },
    repoOf: { 1204: [R1, R2] },
    fixtures: fx(1204),
  });
  const missing = await attempt({
    concurrency: 1,
    options: { prNumbers: [1204, 7] },
    repoOf: { 1204: [], 7: R1 },
    fixtures: fx(1204, 7),
  });

  await test('a bare number matching two repos, or none, fails the run before any review', () => {
    assertEqual(
      ambiguous.error && ambiguous.error.message,
      'PR #1204 matches carbon and carbon-ai-chat. Name it as carbon-ai-chat#1204.',
      'ambiguous'
    );
    assertEqual(
      missing.error && missing.error.message,
      'PR #1204 was not found in carbon or carbon-ai-chat.',
      'not found'
    );
    for (const run of [ambiguous, missing]) {
      assertEqual(run.writes.length + run.bobRuns.length, 0, 'nothing ran');
      assert(
        texts(run).some((t) => t.includes('PR #1204')),
        'logged for the console'
      );
    }
  });
  await ambiguous.cleanup();
  await missing.cleanup();

  // ── The open-PR tiebreak is announced ────────────────────────────────────

  const tie = (merged) =>
    harness.runBatch({
      concurrency: 1,
      prNumbers: [1204],
      repoOf: { 1204: [R1, R2] },
      prStates: { 'carbon#1204': { state: 'closed', merged_at: merged } },
      fixtures: fx(1204),
    });
  const mergedTie = await tie('2019-01-01T00:00:00Z');
  const closedTie = await tie(null);

  await test('a number resolved by the open-PR tiebreak is announced before any review starts', () => {
    for (const [run, what] of [
      [mergedTie, 'merged'],
      [closedTie, 'closed'],
    ]) {
      const note = `📌 #1204 → carbon-ai-chat#1204 (carbon#1204 was ${what} at lookup)`;
      const at = texts(run).findIndex((t) => t === `[batch] ${note}`);
      assert(at >= 0, `${note} in ${texts(run).slice(0, 12).join(' | ')}`);
      const reviewing = texts(run).findIndex((t) =>
        t.includes('Reviewing carbon-ai-chat#1204')
      );
      assert(at < reviewing, 'before the review starts');
      assertEqual(
        run.comments('carbon-ai-chat#1204').length,
        1,
        'the open PR is reviewed'
      );
      assertEqual(
        run.comments('carbon#1204').length,
        0,
        'the merged PR is not'
      );
    }
  });
  await mergedTie.cleanup();
  await closedTie.cleanup();

  const fromConsole = await harness.runBatch({
    concurrency: 1,
    prs: [ref(R2, 1204), ref(R1, 3)],
    resolutionNotes: [
      {
        repo: R2,
        number: 1204,
        alternatives: [
          { repo: R1, state: 'closed', mergedAt: '2019-01-01T00:00:00Z' },
        ],
      },
      // Not in prs: never a review target, never logged.
      {
        repo: R2,
        number: 99,
        alternatives: [{ repo: R1, state: 'closed', mergedAt: null }],
      },
    ],
    fixtures: fx(3, 1204),
  });

  await test('a resolution note passed with prs appears in the captured output', () => {
    const lines = texts(fromConsole);
    const at = lines.indexOf(
      '[batch] 📌 #1204 → carbon-ai-chat#1204 (carbon#1204 was merged at lookup)'
    );
    assert(at >= 0, lines.slice(0, 12).join(' | '));
    assert(
      at < lines.findIndex((t) => t.includes('Reviewing ')),
      'before any review'
    );
    assert(
      !lines.some((t) => t.includes('#99')),
      'a note for an unreviewed ref is dropped'
    );
    assertEqual(fromConsole.writes.length > 0, true, 'reviews ran');
  });
  await fromConsole.cleanup();

  // ── A profile that cannot run stops the run, loudly ──────────────────────

  const sendsTo = (sent, statusCode = 200) => {
    https.request = (opts, cb) => {
      const req = new EventEmitter();
      req.setTimeout = () => {};
      req.destroy = () => {};
      req.write = (body) => sent.push(JSON.parse(body));
      req.end = () => setImmediate(() => cb({ statusCode, resume() {} }));
      return req;
    };
  };
  // The registry's own check, run as if the configured agent were Claude.
  const checkRepos = profiles.checkRepos;
  profiles.checkRepos = (repos) => checkRepos(repos, 'claude');
  const PROFILE_ERROR =
    'carbon-ai-chat uses the caic profile, which runs on Bob only (GITHUB_AI_AGENT_CLI is "claude").';
  const failing = (triggeredBy, statusCode) => {
    const sent = [];
    sendsTo(sent, statusCode);
    return attempt({
      concurrency: 1,
      options: { triggeredBy },
      open: { carbon: [11] },
      fixtures: fx(11),
    }).then((run) => ({ ...run, sent }));
  };
  const manual = await failing('manual');
  const scheduled = await failing('schedule');
  const slackDown = await failing('schedule', 500);
  const viaServer = await harness.sandbox(
    { concurrency: 1, open: { carbon: [11] }, fixtures: fx(11) },
    async () => {
      const { status } = await callApi({
        method: 'POST',
        url: '/api/review/trigger',
        body: {},
      });
      let state;
      for (let i = 0; i < 200; i++) {
        ({ json: state } = await callApi({
          method: 'GET',
          url: '/api/review/status',
        }));
        if (!state.running) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      return { status, state };
    }
  );
  profiles.checkRepos = checkRepos;
  https.request = refuseHttps;

  await test('a profile failure starts no reviews, emits run_failed and rejects', () => {
    for (const run of [manual, scheduled]) {
      assertEqual(
        run.error && run.error.message,
        PROFILE_ERROR,
        'the caller sees the error'
      );
      assertEqual(run.writes.length, 0, 'nothing posted');
      assertEqual(run.bobRuns.length, 0, 'no agent ran');
      const failed = run.events.filter((e) => e.event_type === 'run_failed');
      assertEqual(failed.length, 1, 'one run_failed');
      assertEqual(failed[0].payload.error, PROFILE_ERROR, 'payload.error');
      assertEqual(failed[0].repo, `${CARBON},${CAIC}`, 'repo');
      assertList(failed[0].payload.repos, [CARBON, CAIC], 'repos');
      assert(
        !run.events.some((e) => e.event_type === 'run_started'),
        'never started'
      );
    }
  });

  await test('a manual trigger leaves the profile error in the status the console reads', () => {
    assertEqual(
      viaServer.value.status,
      202,
      'accepted, then failed in the background'
    );
    assertEqual(viaServer.value.state.running, false, 'finished');
    assertEqual(
      viaServer.value.state.error,
      PROFILE_ERROR,
      'reviewState.error'
    );
    assertEqual(viaServer.bobRuns.length, 0, 'no agent ran');
  });

  await test('a scheduled profile failure sends the run-failure payload, not a low-token alert', () => {
    assertEqual(scheduled.sent.length, 1, 'one Slack message');
    const payload = scheduled.sent[0];
    const text = JSON.stringify(payload);
    assertEqual(
      payload.blocks[0].text.text,
      '⚠️  Carbon Monitor — Review Run Could Not Start'
    );
    assert(text.includes(CARBON) && text.includes(CAIC), 'names the repos');
    assert(
      text.includes('carbon-ai-chat uses the caic profile'),
      'names the error'
    );
    assert(text.includes('No pull requests were reviewed'), 'says nothing ran');
    assert(
      !/paused|balance|remaining|threshold|Bobcoins/i.test(text),
      `no low-balance wording: ${text}`
    );
    const low = JSON.stringify(
      slack._buildLowTokenPayload({
        percentRemaining: 5,
        threshold: 10,
        repo: CARBON,
        isReminder: false,
      })
    );
    assert(
      !text.includes('Scheduled Review Paused') && low.includes('Paused'),
      'not the alert'
    );
    assertEqual(
      JSON.stringify(
        slack._buildRunFailurePayload({
          startedAt: Date.now(),
          repos: [CARBON, CAIC],
          error: PROFILE_ERROR,
        })
      ).includes('Could Not Start'),
      true,
      'the builder is the source'
    );
  });

  await test('a Slack failure does not replace the profile error; a manual run sends nothing', () => {
    assertEqual(slackDown.sent.length, 1, 'it tried');
    assertEqual(
      slackDown.error && slackDown.error.message,
      PROFILE_ERROR,
      'still the profile error'
    );
    assert(
      slackDown.events.some((e) => e.event_type === 'run_failed'),
      'run_failed'
    );
    assertEqual(manual.sent.length, 0, 'manual runs do not alert');
  });
  for (const run of [manual, scheduled, slackDown, viaServer])
    await run.cleanup();

  // Restore the environment and remove the scratch directory.
  process.env.HOME = originalHome;
  fs.rmSync(sandbox, { recursive: true, force: true });

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
