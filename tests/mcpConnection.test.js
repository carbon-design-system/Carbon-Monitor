/**
 * Tests for the Carbon MCP connection manager (src/api/mcpConnection.js)
 *
 * Covers the logic the unattended refresh depends on. Network calls are out of
 * scope here — those are exercised against the real server by the console's
 * "Test connection" action.
 *
 * Covers:
 *  1. decodeJwt reads the payload of a well-formed token
 *  2. decodeJwt returns null for non-JWT input instead of throwing
 *  3. secondsUntilExpiry is positive for a future token
 *  4. secondsUntilExpiry is negative for a lapsed token
 *  5. secondsUntilExpiry is null when there is no exp claim
 *  6. writeBobMcpHeaders creates the config when none exists
 *  7. writeBobMcpHeaders preserves operator-tuned fields across a token write
 *  8. A token-only write does not erase an existing session id
 *  9. writeBobMcpHeaders rejects a call carrying neither credential
 * 10. The config file is written 0600 — it holds a bearer token
 * 11. getStatus reports expiry and never leaks the token itself
 */

const fs = require('fs');
const os = require('os');
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

/** Build an unsigned JWT with the given claims. Only the payload is read. */
function makeJwt(claims) {
  const enc = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${enc({ alg: 'none', typ: 'JWT' })}.${enc(claims)}.signature`;
}

/**
 * Redirect HOME to a scratch directory.
 *
 * mcpConnection derives every path from os.homedir(), so without this the tests
 * would overwrite the developer's real ~/.bob/settings/mcp.json — the file that
 * currently holds their working Carbon MCP session.
 */
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-monitor-test-'));
const originalHome = process.env.HOME;
process.env.HOME = sandbox;
process.env.MCP_STATE_PATH = path.join(sandbox, 'state.json');

const mcp = require('../src/api/mcpConnection');
const configPath = mcp.getBobMcpConfigPath();

function readConfig() {
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

async function main() {
  console.log('\n🔗 Carbon MCP connection tests\n');

  await test('decodeJwt reads the payload of a well-formed token', () => {
    const claims = mcp.decodeJwt(
      makeJwt({ email: 'a@example.com', exp: 1234567890 })
    );
    assert(claims !== null, 'claims should decode');
    assert(
      claims.email === 'a@example.com',
      `unexpected email: ${claims.email}`
    );
    assert(claims.exp === 1234567890, `unexpected exp: ${claims.exp}`);
  });

  await test('decodeJwt returns null for non-JWT input', () => {
    for (const bad of ['', 'opaque-token', 'a.b', 'a.b.c.d', null]) {
      assert(
        mcp.decodeJwt(bad) === null,
        `expected null for ${JSON.stringify(bad)}`
      );
    }
  });

  await test('secondsUntilExpiry is positive for a future token', () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    const remaining = mcp.secondsUntilExpiry(makeJwt({ exp: future }));
    assert(
      remaining > 3500 && remaining <= 3600,
      `unexpected remaining: ${remaining}`
    );
  });

  await test('secondsUntilExpiry is negative for a lapsed token', () => {
    const past = Math.floor(Date.now() / 1000) - 7200;
    const remaining = mcp.secondsUntilExpiry(makeJwt({ exp: past }));
    assert(remaining < 0, `expected a negative value, got ${remaining}`);
  });

  await test('secondsUntilExpiry is null without an exp claim', () => {
    assert(
      mcp.secondsUntilExpiry(makeJwt({ email: 'a@example.com' })) === null,
      'expected null'
    );
    assert(
      mcp.secondsUntilExpiry('opaque-token') === null,
      'expected null for a non-JWT'
    );
  });

  await test('writeBobMcpHeaders creates the config when none exists', async () => {
    fs.rmSync(configPath, { force: true });
    await mcp.writeBobMcpHeaders({
      token: 'token-one',
      sessionId: 'session-one',
    });

    const entry = readConfig().mcpServers['carbon-mcp'];
    assert(entry, 'the carbon-mcp entry should exist');
    assert(
      entry.headers.Authorization === 'Bearer token-one',
      'Authorization should be set'
    );
    assert(
      entry.headers['X-MCP-Session'] === 'session-one',
      'session header should be set'
    );
    assert(
      entry.type === 'streamable-http',
      'transport type should default correctly'
    );
    assert(
      Array.isArray(entry.alwaysAllow) && entry.alwaysAllow.length > 0,
      'the agent must be able to call tools without an interactive prompt'
    );
  });

  await test('preserves operator-tuned fields across a token write', async () => {
    const config = readConfig();
    config.mcpServers['carbon-mcp'].timeout = 999000;
    config.mcpServers['carbon-mcp'].alwaysAllow = ['code_search'];
    config.mcpServers['other-server'] = { type: 'stdio', command: 'echo' };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    await mcp.writeBobMcpHeaders({ token: 'token-two' });

    const after = readConfig();
    assert(
      after.mcpServers['carbon-mcp'].timeout === 999000,
      'a custom timeout must survive'
    );
    assert(
      after.mcpServers['carbon-mcp'].alwaysAllow.length === 1,
      'a customised allow-list must survive'
    );
    assert(
      after.mcpServers['other-server'],
      'unrelated servers must be left alone'
    );
  });

  await test('a token-only write does not erase an existing session id', async () => {
    await mcp.writeBobMcpHeaders({ token: 'token-three' });

    const entry = readConfig().mcpServers['carbon-mcp'];
    assert(
      entry.headers.Authorization === 'Bearer token-three',
      'token should update'
    );
    assert(
      entry.headers['X-MCP-Session'] === 'session-one',
      'the session id is the durable credential and must not be dropped'
    );
  });

  await test('rejects a write carrying neither credential', async () => {
    let threw = false;
    try {
      await mcp.writeBobMcpHeaders({});
    } catch (_) {
      threw = true;
    }
    assert(threw, 'writing nothing should be an error, not a silent no-op');
  });

  await test('writes the config file 0600', () => {
    const mode = fs.statSync(configPath).mode & 0o777;
    assert(
      mode === 0o600,
      `expected 0600, got ${mode.toString(8)} — it holds a bearer token`
    );
  });

  await test('getStatus reports expiry and never leaks the token or the operator email', async () => {
    const future = Math.floor(Date.now() / 1000) + 1800;
    await mcp.writeBobMcpHeaders({
      token: makeJwt({ exp: future, email: 'op@example.com' }),
    });

    const status = await mcp.getStatus();
    assert(status.configured === true, 'should report configured');
    assert(status.hasToken === true, 'should report a token is present');
    // Reports THAT an identity is present, never WHO — the email must not leave
    // the server (asserted against the serialized payload below).
    assert(
      status.authenticated === true,
      'should report an authenticated identity'
    );
    assert(
      status.expiresInSeconds > 1700 && status.expiresInSeconds <= 1800,
      `unexpected expiry: ${status.expiresInSeconds}`
    );

    const serialized = JSON.stringify(status);
    assert(
      !serialized.includes('Bearer '),
      'status must not include the Authorization header'
    );
    assert(
      !serialized.includes('session-one'),
      'status must not include the session id'
    );
    assert(
      !serialized.includes('op@example.com'),
      'status must not expose the operator email address'
    );
  });

  // Restore the environment and remove the scratch directory.
  process.env.HOME = originalHome;
  fs.rmSync(sandbox, { recursive: true, force: true });

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
