/**
 * Tests for console session authentication (src/api/sessionAuth.js)
 *
 * Covers:
 *  1. Correct credentials are accepted and a session cookie is issued
 *  2. A wrong password is rejected, with a generic message + access contact
 *  3. A wrong username is rejected
 *  4. A username that is a prefix of the real one is rejected (length guard)
 *  5. Sign-in fails closed when CONSOLE_USERNAME / CONSOLE_PASSWORD are unset
 *  6. A freshly minted token verifies
 *  7. A tampered token is rejected
 *  8. A token signed with a different key is rejected
 *  9. An expired token is rejected — the divergence from the Carbon Migrate
 *     original, whose verifyToken ignores the timestamp it signs
 * 10. Garbage input is rejected without throwing
 * 11. hasValidSession bypasses the check when auth is not enforced
 * 12. Cookie carries HttpOnly, SameSite and Path attributes
 * 13. Sign-in is OFF when AUTH_REQUIRED is unset — the default deployment
 * 14. Sign-in stays OFF under NODE_ENV=production unless explicitly enabled
 * 15. Common truthy spellings (1/yes/on/…) all enable it
 * 16. Common falsy spellings all leave it off
 * 17. An unrecognised value leaves it off AND warns — with the default off, a
 *     typo while enabling is the failure that matters
 */

let passed = 0;
let failed = 0;

function test(description, fn) {
  try {
    fn();
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

/** Minimal ServerResponse stand-in capturing Set-Cookie. */
function fakeRes() {
  return {
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
    },
  };
}

/** Minimal IncomingMessage stand-in carrying a cookie header. */
function fakeReq(cookie) {
  return { headers: cookie ? { cookie } : {} };
}

/**
 * Load sessionAuth fresh.
 *
 * AUTH_REQUIRED and the signing key are read at module load, so each scenario
 * needs its own module instance rather than a mutated shared one.
 */
function loadAuth(env = {}, unset = []) {
  const saved = { ...process.env };

  Object.assign(process.env, env);
  // Object.assign cannot express "absent" — a key set by an earlier scenario
  // would survive and the test would silently assert the wrong thing. Testing
  // the DEFAULT requires actually removing the variable.
  for (const key of unset) delete process.env[key];

  delete require.cache[require.resolve('../src/api/sessionAuth')];
  const mod = require('../src/api/sessionAuth');

  // Restore only the keys this call touched, so scenarios do not leak.
  for (const key of [...Object.keys(env), ...unset]) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  return mod;
}

const CREDS = {
  CONSOLE_USERNAME: 'operator',
  CONSOLE_PASSWORD: 'correct-horse-battery',
  SESSION_SIGNING_KEY: 'test-signing-key',
  AUTH_REQUIRED: 'true',
};

console.log('\n🔐 Session authentication tests\n');

// Credentials must remain set while login() runs, so these tests set them on
// process.env directly and restore afterwards.
const originalEnv = { ...process.env };
Object.assign(process.env, CREDS);

const auth = loadAuth(CREDS);

test('accepts correct credentials and issues a cookie', () => {
  const res = fakeRes();
  const result = auth.login(res, { username: 'operator', password: 'correct-horse-battery' });
  assert(result.ok === true, 'login should succeed');
  assert(result.status === 200, `expected 200, got ${result.status}`);
  assert(res.headers['Set-Cookie'], 'a Set-Cookie header should be present');
});

test('rejects a wrong password', () => {
  const res = fakeRes();
  const result = auth.login(res, { username: 'operator', password: 'wrong' });
  assert(result.ok === false, 'login should fail');
  assert(result.status === 401, `expected 401, got ${result.status}`);
  assert(!res.headers['Set-Cookie'], 'no cookie should be issued');
});

test('a failed sign-in returns a generic message and the access-request contact', () => {
  const result = auth.login(fakeRes(), { username: 'operator', password: 'wrong' });
  assert(
    result.body.contact === 'Carbon.MCP@ibm.com',
    `expected the Carbon MCP contact address, got ${result.body.contact}`
  );
  // Generic on purpose — it must never reveal WHICH field was wrong, which would
  // confirm valid usernames to someone guessing.
  assert(
    result.body.error === 'Username or password is incorrect.',
    `expected the generic failure message, got ${JSON.stringify(result.body.error)}`
  );
});

test('rejects a wrong username', () => {
  const result = auth.login(fakeRes(), { username: 'intruder', password: 'correct-horse-battery' });
  assert(result.status === 401, `expected 401, got ${result.status}`);
});

test('rejects a username that is a prefix of the real one', () => {
  const result = auth.login(fakeRes(), { username: 'oper', password: 'correct-horse-battery' });
  assert(result.status === 401, `expected 401, got ${result.status}`);
});

test('fails closed when credentials are not configured on the server', () => {
  const savedUser = process.env.CONSOLE_USERNAME;
  const savedPass = process.env.CONSOLE_PASSWORD;
  delete process.env.CONSOLE_USERNAME;
  delete process.env.CONSOLE_PASSWORD;
  try {
    const result = auth.login(fakeRes(), { username: 'operator', password: 'anything' });
    assert(result.status === 503, `expected 503, got ${result.status}`);
    assert(result.ok === false, 'login must not succeed without configured credentials');
  } finally {
    process.env.CONSOLE_USERNAME = savedUser;
    process.env.CONSOLE_PASSWORD = savedPass;
  }
});

test('verifies a freshly minted token', () => {
  const res = fakeRes();
  auth.login(res, { username: 'operator', password: 'correct-horse-battery' });
  const token = res.headers['Set-Cookie'].split(';')[0].split('=')[1];
  assert(auth.verifyToken(token) === true, 'a fresh token should verify');
});

test('rejects a tampered token', () => {
  const res = fakeRes();
  auth.login(res, { username: 'operator', password: 'correct-horse-battery' });
  const token = res.headers['Set-Cookie'].split(';')[0].split('=')[1];

  // Flip the final character of the MAC.
  const decoded = Buffer.from(token, 'base64url').toString('ascii');
  const flipped = decoded.slice(0, -1) + (decoded.endsWith('a') ? 'b' : 'a');
  const tampered = Buffer.from(flipped).toString('base64url');

  assert(auth.verifyToken(tampered) === false, 'a tampered token must be rejected');
});

test('rejects a token signed with a different key', () => {
  const res = fakeRes();
  auth.login(res, { username: 'operator', password: 'correct-horse-battery' });
  const token = res.headers['Set-Cookie'].split(';')[0].split('=')[1];

  // The signing key is read at verification time, not at module load, so it has
  // to stay swapped for the duration of the check — restoring it first would
  // hand verifyToken the very key the token was signed with.
  const saved = process.env.SESSION_SIGNING_KEY;
  process.env.SESSION_SIGNING_KEY = 'a-completely-different-key';
  try {
    assert(auth.verifyToken(token) === false, 'a foreign-signed token must be rejected');
  } finally {
    process.env.SESSION_SIGNING_KEY = saved;
  }
});

test('rejects an expired token', () => {
  // A one-second lifetime, with a token backdated past it. This is the behaviour
  // Carbon Migrate's original lacks: it verifies the MAC and never reads the
  // timestamp back, so a captured token there stays valid indefinitely.
  const shortLived = loadAuth({ ...CREDS, SESSION_MAX_AGE_SECONDS: '1' });

  const crypto = require('crypto');
  const id = crypto.randomBytes(16).toString('hex');
  const ts = String(Date.now() - 60_000); // issued a minute ago
  const mac = crypto
    .createHmac('sha256', 'test-signing-key')
    .update(`${id}:${ts}`)
    .digest('hex');
  const stale = Buffer.from(`${id}:${ts}:${mac}`).toString('base64url');

  assert(
    shortLived.verifyToken(stale) === false,
    'a correctly signed but expired token must be rejected'
  );
});

test('rejects malformed input without throwing', () => {
  for (const bad of [null, undefined, '', 'not-a-token', 'a:b', '!!!!', 'a:b:c:d']) {
    assert(auth.verifyToken(bad) === false, `expected rejection for ${JSON.stringify(bad)}`);
  }
});

test('hasValidSession bypasses the check when auth is not enforced', () => {
  const open = loadAuth({ ...CREDS, AUTH_REQUIRED: 'false' });
  assert(open.AUTH_REQUIRED === false, 'auth should not be enforced');
  assert(open.hasValidSession(fakeReq()) === true, 'a cookieless request should pass');
});

// ── Feature-flag semantics ────────────────────────────────────────────────
// Sign-in is opt-in. These pin the default down, because a regression here does
// not fail loudly — it silently exposes (or silently locks out) a deployment.

test('sign-in is OFF when AUTH_REQUIRED is unset — the default deployment', () => {
  const mod = loadAuth({ CONSOLE_USERNAME: 'operator', CONSOLE_PASSWORD: 'x' }, ['AUTH_REQUIRED']);
  assert(mod.AUTH_REQUIRED === false, 'the default must be an open console');
});

test('sign-in stays OFF in production unless explicitly enabled', () => {
  // The flag is deliberately not keyed to NODE_ENV: a security posture must be
  // chosen, not inferred from an unrelated variable.
  const mod = loadAuth(
    { CONSOLE_USERNAME: 'operator', CONSOLE_PASSWORD: 'x', NODE_ENV: 'production' },
    ['AUTH_REQUIRED']
  );
  assert(mod.AUTH_REQUIRED === false, 'NODE_ENV=production must not turn sign-in on');
});

test('common truthy spellings all enable sign-in', () => {
  // The default is off, so a typo while turning it ON is the dangerous mistake —
  // it leaves the console open while the operator believes it is protected.
  for (const value of ['true', 'TRUE', ' True ', '1', 'yes', 'on', 'enabled']) {
    const mod = loadAuth({ ...CREDS, AUTH_REQUIRED: value });
    assert(mod.AUTH_REQUIRED === true, `AUTH_REQUIRED=${JSON.stringify(value)} should enable`);
  }
});

test('common falsy spellings all leave sign-in off', () => {
  for (const value of ['false', 'FALSE', '0', 'no', 'off', 'disabled', '']) {
    const mod = loadAuth({ ...CREDS, AUTH_REQUIRED: value });
    assert(mod.AUTH_REQUIRED === false, `AUTH_REQUIRED=${JSON.stringify(value)} should not enable`);
  }
});

test('an unrecognised value leaves sign-in off and warns', () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const mod = loadAuth({ ...CREDS, AUTH_REQUIRED: 'maybe' });
    assert(mod.AUTH_REQUIRED === false, 'an unparseable value must not enable sign-in');
    assert(
      warnings.some((w) => w.includes('AUTH_REQUIRED')),
      'an unrecognised value must be reported, not silently ignored'
    );
  } finally {
    console.warn = originalWarn;
  }
});

test('session cookie sets HttpOnly, SameSite and Path', () => {
  const res = fakeRes();
  auth.login(res, { username: 'operator', password: 'correct-horse-battery' });
  const cookie = res.headers['Set-Cookie'];
  assert(cookie.includes('HttpOnly'), 'cookie must be HttpOnly so scripts cannot read it');
  assert(cookie.includes('SameSite=Strict'), 'cookie must be SameSite=Strict');
  assert(cookie.includes('Path=/'), 'cookie must apply to the whole app');
});

// Restore the environment for any subsequent test file in the same process.
for (const key of Object.keys(CREDS)) {
  if (originalEnv[key] === undefined) delete process.env[key];
  else process.env[key] = originalEnv[key];
}

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
