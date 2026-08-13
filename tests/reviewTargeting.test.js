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
 * 16. The default limit is MAX_PRS_PER_RUN
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
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

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
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-monitor-targeting-'));
const originalHome = process.env.HOME;
process.env.HOME = sandbox;
process.env.MCP_STATE_PATH = path.join(sandbox, 'state.json');
process.env.GITHUB_AI_AGENT_PR_NUMBER = '';
process.env.AUTH_REQUIRED = 'false';

const INDEX_PATH = path.join(__dirname, '..', 'src', 'index.js');
const REPO_ROOT = path.join(__dirname, '..');

const { parsePrNumbers, resolveReviewTargets } = require('../src/index');
const { MAX_PRS_PER_RUN } = require('../src/constants');
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
  return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : null };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n🎯 Review targeting and MCP disconnect tests\n');

  // ── parsePrNumbers: the auto path ────────────────────────────────────────

  await test('absent, null, blank and empty input all mean auto-select', () => {
    for (const input of [undefined, null, '', '   ', []]) {
      const result = parsePrNumbers(input);
      assert(result.ok, `${JSON.stringify(input)} should be accepted`);
      assertEqual(result.prNumbers, null, `${JSON.stringify(input)} should select auto mode`);
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
    assertList(parsePrNumbers(['22971']).prNumbers, [22971], 'array of strings');
  });

  // ── parsePrNumbers: rejected entries ─────────────────────────────────────

  await test('zero is rejected and the message names it', () => {
    for (const input of [[0], '0', '22971,0']) {
      const result = parsePrNumbers(input);
      assert(!result.ok, `${JSON.stringify(input)} should be rejected`);
      assert(result.error.includes('0'), `message should name the value: ${result.error}`);
    }
  });

  await test('negative numbers are rejected', () => {
    for (const input of [[-5], '-5', [22971, -1]]) {
      assert(!parsePrNumbers(input).ok, `${JSON.stringify(input)} should be rejected`);
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
    assert(result.error.includes('abc'), `message should name the value: ${result.error}`);
    assert(!parsePrNumbers(['22971', 'abc']).ok, 'one bad entry rejects the list');
    // Number() would read these as 16, 1000 and 5 — a typo must never resolve to
    // some other repository's PR.
    for (const sneaky of ['0x10', '1e3', '+5', 'NaN', 'Infinity']) {
      assert(!parsePrNumbers([sneaky]).ok, `${sneaky} should be rejected`);
    }
  });

  await test('null, booleans and objects inside the list are rejected', () => {
    for (const entry of [null, undefined, true, false, {}, [], { number: 22971 }]) {
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
      assert(result.error.includes('empty'), `message should say so: ${result.error}`);
    }
  });

  // ── parsePrNumbers: dedup and limits ─────────────────────────────────────

  await test('duplicates are removed and order is preserved', () => {
    const result = parsePrNumbers('22973, 22971, 22973, 22972, 22971');
    assert(result.ok, result.error);
    assertList(result.prNumbers, [22973, 22971, 22972], 'prNumbers');
  });

  await test('exactly maxPRs is accepted', () => {
    const list = Array.from({ length: MAX_PRS_PER_RUN }, (_, i) => 22971 + i);
    const result = parsePrNumbers(list);
    assert(result.ok, result.error);
    assertEqual(result.prNumbers.length, MAX_PRS_PER_RUN, 'accepted count');
  });

  await test('maxPRs + 1 is rejected, naming both the limit and the count', () => {
    const list = Array.from({ length: MAX_PRS_PER_RUN + 1 }, (_, i) => 22971 + i);
    const result = parsePrNumbers(list);
    assert(!result.ok, 'over the limit should be rejected');
    assert(
      result.error.includes(String(MAX_PRS_PER_RUN)),
      `message should state the limit: ${result.error}`
    );
    assert(
      result.error.includes(String(MAX_PRS_PER_RUN + 1)),
      `message should state the count received: ${result.error}`
    );
  });

  await test('the maxPRs argument overrides the default', () => {
    assert(parsePrNumbers([1, 2, 3], 3).ok, 'three under a limit of three');
    assert(!parsePrNumbers([1, 2, 3, 4], 3).ok, 'four over a limit of three');
    // Deduplication happens first, so a repeated PR does not consume budget.
    assert(parsePrNumbers([1, 1, 2, 2, 3], 3).ok, 'duplicates must not count toward the limit');
  });

  await test('the default limit is MAX_PRS_PER_RUN', () => {
    const overBy = Array.from({ length: MAX_PRS_PER_RUN + 1 }, (_, i) => i + 1);
    assert(!parsePrNumbers(overBy).ok, 'the default must be the configured maximum');
    assert(parsePrNumbers(overBy, MAX_PRS_PER_RUN + 1).ok, 'raising the limit admits it');
  });

  // ── resolveReviewTargets: precedence ─────────────────────────────────────

  await test('an explicit list outranks TARGET_PR', () => {
    const target = resolveReviewTargets({ prNumbers: [22971, 22972] }, 4242);
    assert(target.ok, target.error);
    assertEqual(target.mode, 'explicit', 'mode');
    assertEqual(target.source, 'argument', 'source');
    assertList(target.prNumbers, [22971, 22972], 'prNumbers');
    assert(!target.prNumbers.includes(4242), 'the pinned env target must not leak in');
  });

  await test('TARGET_PR is used when the caller names nothing', () => {
    for (const options of [undefined, {}, { prNumbers: null }]) {
      const target = resolveReviewTargets(options, 4242);
      assertEqual(target.mode, 'explicit', 'mode');
      assertEqual(target.source, 'cli-env', 'source');
      assertList(target.prNumbers, [4242], 'prNumbers');
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
    const target = resolveReviewTargets({ prNumbers: '' }, 4242);
    assertEqual(target.mode, 'explicit', 'mode');
    assertList(target.prNumbers, [4242], 'prNumbers');
  });

  await test('resolveReviewTargets reports an invalid list instead of throwing', () => {
    const target = resolveReviewTargets({ prNumbers: 'abc' }, 4242);
    assert(target.ok === false, 'should not be ok');
    assert(target.error.includes('abc'), `message should name the value: ${target.error}`);
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
      env: { ...process.env, GITHUB_AI_AGENT_PR_NUMBER: '4242' },
      encoding: 'utf8',
    });

    const result = JSON.parse(out.trim());
    assertList(result.noArgument.prNumbers, [4242], 'env var target');
    assertEqual(result.noArgument.source, 'cli-env', 'source without an argument');
    assertList(result.withArgument.prNumbers, [22971], 'argument wins');
    assertEqual(result.withArgument.source, 'argument', 'source with an argument');
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
      assert(json.error.includes('abc'), `message should name the value: ${json.error}`);
      assert(process.exitCode === undefined || process.exitCode === 0, 'process must be unharmed');
    });
  });

  await test('POST /api/review/trigger rejects a non-array, non-string prNumbers', async () => {
    const { status, json } = await callApi({
      method: 'POST',
      url: '/api/review/trigger',
      body: { prNumbers: { first: 22971 } },
    });
    assertEqual(status, 400, 'status');
    assert(json.error.includes('array'), `message should say what is accepted: ${json.error}`);
  });

  await test('POST /api/review/trigger enforces the same limit as parsePrNumbers', async () => {
    const list = Array.from({ length: MAX_PRS_PER_RUN + 1 }, (_, i) => 22971 + i);
    const { status, json } = await callApi({
      method: 'POST',
      url: '/api/review/trigger',
      body: { prNumbers: list },
    });
    assertEqual(status, 400, 'status');
    assert(
      json.error.includes(String(MAX_PRS_PER_RUN)),
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
      assert(json.error.includes('JSON object'), `message should say so: ${json.error}`);
    }
  });

  // ── Disconnect ───────────────────────────────────────────────────────────

  await test('disconnect strips both credential headers from mcp.json', async () => {
    await mcp.writeBobMcpHeaders({ token: 'token-one', sessionId: 'session-one' });

    const result = await mcp.disconnect();
    assertEqual(result.disconnected, true, 'disconnected');
    assertEqual(result.hadToken, true, 'hadToken');
    assertEqual(result.hadSession, true, 'hadSession');

    const headers = readConfig().mcpServers['carbon-mcp'].headers;
    assert(!headers.Authorization, 'the bearer must be gone');
    assert(!headers['X-MCP-Session'], 'the session id must be gone — it mints new bearers');
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
    assertEqual(entry.timeout, 999000, 'a custom timeout must survive a disconnect');
    assertEqual(entry.alwaysAllow.length, 1, 'a customised allow-list must survive');
    assertEqual(entry.headers['X-Operator-Note'], 'keep me', 'unrelated headers must survive');
    assert(!entry.headers.Authorization, 'the bearer must be gone');
    assert(after.mcpServers['other-server'], 'unrelated servers must be left alone');
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
    assert(!state.refreshToken, 'the refresh token must not survive a disconnect');
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
    assertEqual(status.needsReauth, false, 'a deliberate sign-out is not a failure');
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
    assertEqual(probe.reason, 'not-configured', 'no credentials means nothing to probe');
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
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-monitor-fresh-'));
    const previousHome = process.env.HOME;
    const previousState = process.env.MCP_STATE_PATH;
    process.env.HOME = fresh;
    process.env.MCP_STATE_PATH = path.join(fresh, 'state.json');

    try {
      const result = await mcp.disconnect();
      assertEqual(result.disconnected, true, 'disconnected');
      assertEqual(result.hadToken, false, 'nothing was configured');
      assert(!fs.existsSync(path.join(fresh, '.bob', 'settings', 'mcp.json')),
        'a disconnect must not conjure a config file that never existed');
    } finally {
      process.env.HOME = previousHome;
      process.env.MCP_STATE_PATH = previousState;
      fs.rmSync(fresh, { recursive: true, force: true });
    }
  });

  await test('POST /api/mcp/disconnect is routed and reports success', async () => {
    await mcp.writeBobMcpHeaders({ token: 'token-four', sessionId: 'session-four' });

    const first = await callApi({ method: 'POST', url: '/api/mcp/disconnect' });
    assertEqual(first.status, 200, 'status');
    assertEqual(first.json.success, true, 'success');
    assertEqual(first.json.disconnected, true, 'disconnected');

    const second = await callApi({ method: 'POST', url: '/api/mcp/disconnect' });
    assertEqual(second.status, 200, 'a second call is not an error');
    assertEqual(second.json.disconnected, true, 'disconnected');

    const headers = readConfig().mcpServers['carbon-mcp'].headers;
    assert(!headers.Authorization && !headers['X-MCP-Session'], 'credentials must be gone');
  });

  // ── Clearing the review log ──────────────────────────────────────────────

  await test('POST /api/review/logs/clear empties the buffer and counts what it dropped', async () => {
    reviewLog.clear();
    reviewLog.append('fetching PR #22971');
    reviewLog.append('bundle built');
    reviewLog.append('agent thinking');

    const { status, json } = await callApi({ method: 'POST', url: '/api/review/logs/clear' });
    assertEqual(status, 200, 'status');
    assertEqual(json.success, true, 'success');
    assertEqual(json.cleared, 3, 'cleared must name how many lines went away');

    const after = await callApi({ method: 'GET', url: '/api/review/logs?since=0' });
    assertEqual(after.json.lines.length, 0, 'nothing may survive the clear');
  });

  await test('clearing an already-empty buffer reports zero rather than failing', async () => {
    const { status, json } = await callApi({ method: 'POST', url: '/api/review/logs/clear' });
    assertEqual(status, 200, 'a second clear is not an error');
    assertEqual(json.cleared, 0, 'cleared');
  });

  await test('clearing does NOT restart the sequence counter', async () => {
    // The console polls with ?since=N. If clear reset the counter, the next run
    // would reuse seq numbers the client has already rendered — new output would
    // sit below its cursor and never appear, or old output would replay as new.
    reviewLog.clear();
    reviewLog.append('before the clear');

    const first = await callApi({ method: 'GET', url: '/api/review/logs?since=0' });
    const cursor = first.json.nextSince;
    assert(cursor > 0, 'the client should hold a cursor');

    await callApi({ method: 'POST', url: '/api/review/logs/clear' });
    reviewLog.append('after the clear');

    const second = await callApi({ method: 'GET', url: `/api/review/logs?since=${cursor}` });
    assertEqual(second.json.lines.length, 1, 'exactly the one new line');
    assertEqual(second.json.lines[0].text, 'after the clear', 'text');
    assert(
      second.json.lines[0].seq > cursor,
      `a cleared buffer must keep counting forwards: seq ${second.json.lines[0].seq} vs cursor ${cursor}`
    );
  });

  await test('a caught-up client is not told output was dropped', async () => {
    reviewLog.clear();
    reviewLog.append('line one');
    reviewLog.append('line two');

    const caughtUp = await callApi({ method: 'GET', url: '/api/review/logs?since=0' });
    const cursor = caughtUp.json.nextSince;

    await callApi({ method: 'POST', url: '/api/review/logs/clear' });

    const after = await callApi({ method: 'GET', url: `/api/review/logs?since=${cursor}` });
    assertEqual(after.json.lines.length, 0, 'nothing new to send');
    assertEqual(after.json.dropped, false, 'the client had already seen everything discarded');
    assertEqual(after.json.nextSince, cursor, 'an empty read must not move the cursor');
  });

  await test('a client that was behind IS told output was dropped', async () => {
    reviewLog.clear();
    for (const text of ['one', 'two', 'three', 'four']) reviewLog.append(text);

    // Reads a single line, leaving this client three behind the buffer.
    const behind = await callApi({ method: 'GET', url: '/api/review/logs?since=0&limit=1' });
    assertEqual(behind.json.lines.length, 1, 'one line at a time');
    const cursor = behind.json.nextSince;

    await callApi({ method: 'POST', url: '/api/review/logs/clear' });
    reviewLog.append('five');

    const after = await callApi({ method: 'GET', url: `/api/review/logs?since=${cursor}` });
    assertEqual(after.json.dropped, true, 'lines it never saw were discarded — say so');
    assertList(after.json.lines.map((l) => l.text), ['five'], 'only post-clear output remains');
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

      const { status, json } = await callApi({ method: 'POST', url: '/api/review/logs/clear' });
      assertEqual(status, 200, 'clearing during a run is allowed');
      assert(json.cleared >= 1, `something should have been discarded: ${json.cleared}`);

      process.stdout.write('output from after the clear\n');

      const state = reviewLog.read(0);
      assertEqual(state.capturing, true, 'a clear must not unhook the stream capture');
      const texts = state.lines.map((l) => l.text);
      assert(texts.includes('output from after the clear'), 'new output must keep arriving');
      assert(
        !texts.some((t) => t.includes('output from before the clear')),
        'pre-clear output must be gone'
      );
    } finally {
      // Restored even on failure: leaving process.stdout.write wrapped would
      // swallow the rest of this suite's own output.
      reviewLog.stop();
    }

    assertEqual(reviewLog.read(0).capturing, false, 'capture must stop cleanly afterwards');
    reviewLog.clear();
  });

  await test('the clear endpoint is POST-only — GET is not routed', async () => {
    const { status } = await callApi({ method: 'GET', url: '/api/review/logs/clear' });
    assertEqual(status, 404, 'a GET must not empty the log');
  });

  // Restore the environment and remove the scratch directory.
  process.env.HOME = originalHome;
  fs.rmSync(sandbox, { recursive: true, force: true });

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
