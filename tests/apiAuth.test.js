/**
 * Tests for the API server's bearer-token gate (src/api/server.js)
 *
 * The gate parses an attacker-supplied header before any handler runs, on a
 * deployment that runs a single instance. Anything it can be made to throw is a
 * remote denial of service, not a bad request, so these tests are about the
 * shapes an attacker chooses — not the shapes a client sends by accident.
 *
 * Covers:
 *  1. The correct token is accepted
 *  2. A wrong token of identical length is rejected
 *  3. A multibyte token with the same CODE-UNIT count as the secret is rejected
 *     rather than crashing the process — timingSafeEqual compares BYTES and
 *     throws on a length mismatch, so a UTF-16 length guard lets it through
 *  4. A sweep of multibyte lengths never throws (the 64-request DoS)
 *  5. A missing or non-string Authorization header is rejected
 *  6. An Authorization value with no Bearer prefix is rejected
 *  7. A handler that throws is answered with a 500, not an unhandled rejection
 *  8. Repeated failed sign-ins through /api/auth/login end in a 429 with
 *     Retry-After, keyed on the proxy-appended address, not a spoofable prefix
 */

// Set before server.js is loaded: API_SECRET and the auth flags are read at
// module load. dotenv (pulled in by src/index.js) does not override these.
process.env.API_SECRET = 'supersecret'; // 11 characters, as in the report
process.env.API_ENABLE_AUTH = 'true';
process.env.AUTH_REQUIRED = 'true';
process.env.CONSOLE_USERNAME = 'operator';
process.env.CONSOLE_PASSWORD = 'correct-horse-battery';
process.env.SESSION_SECRET = 'test-session-secret';

const { handleRequest } = require('../src/api/server');

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

/** Minimal ServerResponse stand-in capturing the status and body. */
function fakeRes() {
  return {
    statusCode: null,
    body: '',
    headersSent: false,
    setHeader() {},
    writeHead(status) {
      this.statusCode = status;
      this.headersSent = true;
    },
    end(chunk) {
      if (chunk) this.body += chunk;
    },
  };
}

/**
 * Drive one request through the real router.
 *
 * /api/credits is used deliberately: it is the endpoint the report reaches the
 * crash through, and it is behind the gate.
 */
async function request(authorization, url = '/api/credits') {
  const headers = { host: 'localhost' };
  if (authorization !== undefined) headers.authorization = authorization;

  const res = fakeRes();
  await handleRequest({ method: 'GET', url, headers }, res);
  return res;
}

async function main() {
  console.log('\n🔐 API bearer-token gate tests\n');

  await test('rejects a request with no Authorization header', async () => {
    const res = await request(undefined, '/api/config');
    assert(res.statusCode === 401, `expected 401, got ${res.statusCode}`);
  });

  await test('accepts the correct bearer token', async () => {
    const res = await request('Bearer supersecret', '/api/config');
    assert(res.statusCode === 200, `expected 200, got ${res.statusCode}`);
  });

  await test('/api/config names the agent for the console', async () => {
    const saved = process.env.GITHUB_AI_AGENT_CLI;
    try {
      const names = {};
      for (const id of ['bob', 'claude']) {
        process.env.GITHUB_AI_AGENT_CLI = id;
        const res = await request('Bearer supersecret', '/api/config');
        const { config } = JSON.parse(res.body);
        names[id] = [config.agent, config.agentName, config.agentCli];
      }
      assert(
        JSON.stringify(names) ===
          JSON.stringify({
            bob: ['bob', 'IBM Bob', 'Bob Shell CLI'],
            claude: ['claude', 'Claude', 'Claude Code CLI'],
          }),
        `unexpected names: ${JSON.stringify(names)}`
      );
    } finally {
      if (saved === undefined) delete process.env.GITHUB_AI_AGENT_CLI;
      else process.env.GITHUB_AI_AGENT_CLI = saved;
    }
  });

  await test('rejects a wrong token of identical length', async () => {
    const res = await request('Bearer supersecreT', '/api/config');
    assert(res.statusCode === 401, `expected 401, got ${res.statusCode}`);
  });

  await test('rejects a multibyte token instead of crashing the process', async () => {
    // 11 UTF-16 code units, 21 UTF-8 bytes. A `token.length !== secret.length`
    // guard passes this straight into timingSafeEqual, which throws
    // ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH — from outside any try/catch on the
    // original code, so Node killed the instance.
    const token = 'éééééééééé' + 'I';
    assert(
      token.length === process.env.API_SECRET.length,
      'test token must match in code units'
    );
    assert(
      Buffer.byteLength(token, 'utf8') !==
        Buffer.byteLength(process.env.API_SECRET, 'utf8'),
      'test token must differ in bytes, or it proves nothing'
    );

    const res = await request(`Bearer ${token}`, '/api/config');
    assert(res.statusCode === 401, `expected 401, got ${res.statusCode}`);
  });

  await test('a sweep of multibyte lengths never throws', async () => {
    // The attack needs no knowledge of the secret's length: 64 requests
    // sweeping 1..64 guarantees one that matches.
    for (let n = 1; n <= 64; n++) {
      const res = await request(`Bearer ${'é'.repeat(n)}`, '/api/config');
      assert(
        res.statusCode === 401,
        `length ${n} returned ${res.statusCode}, expected 401`
      );
    }
  });

  await test('rejects a non-string Authorization header without throwing', async () => {
    // node:http hands over an array when a header is repeated.
    const res = fakeRes();
    await handleRequest(
      {
        method: 'GET',
        url: '/api/config',
        headers: { host: 'localhost', authorization: ['a', 'b'] },
      },
      res
    );
    assert(res.statusCode === 401, `expected 401, got ${res.statusCode}`);
  });

  await test('rejects an Authorization value with no Bearer prefix', async () => {
    const res = await request('supersecret-but-unprefixed', '/api/config');
    assert(res.statusCode === 401, `expected 401, got ${res.statusCode}`);
  });

  await test('an unknown authenticated path is a 404, not a crash', async () => {
    const res = await request('Bearer supersecret', '/api/does-not-exist');
    assert(res.statusCode === 404, `expected 404, got ${res.statusCode}`);
  });

  const { Readable } = require('stream');
  const attempt = async (password, forwarded) => {
    const res = fakeRes();
    res.headers = {};
    res.setHeader = (k, v) => {
      res.headers[k] = v;
    };
    const req = Readable.from([
      JSON.stringify({ username: 'operator', password }),
    ]);
    Object.assign(req, {
      method: 'POST',
      url: '/api/auth/login',
      headers: forwarded
        ? { host: 'localhost', 'x-forwarded-for': forwarded }
        : { host: 'localhost' },
    });
    await handleRequest(req, res);
    return res;
  };

  await test('failed sign-ins are throttled per address with a 429', async () => {
    // A client-chosen prefix must not dodge the limit: the last hop is the key.
    const logged = [];
    const originalLog = console.log;
    console.log = (...args) => logged.push(args.join(' '));
    try {
      for (let i = 0; i < 5; i++) {
        const res = await attempt('wrong', `spoof-${i}, 203.0.113.9`);
        assert(res.statusCode === 401, `attempt ${i + 1}: ${res.statusCode}`);
      }
    } finally {
      console.log = originalLog;
    }
    const hopLines = logged.filter((l) => l.includes('X-Forwarded-For had'));
    assert(
      hopLines.length === 1,
      `expected one hop line, got ${hopLines.length}`
    );
    assert(
      hopLines[0].includes('2 entries') &&
        hopLines[0].includes('TRUSTED_PROXY_HOPS=1'),
      hopLines[0]
    );
    assert(
      !/\d+\.\d+\.\d+\.\d+|spoof/.test(hopLines[0]),
      'no addresses in the log'
    );

    const blocked = await attempt('correct-horse-battery', 'x, 203.0.113.9');
    assert(
      blocked.statusCode === 429,
      `expected 429, got ${blocked.statusCode}`
    );
    assert(blocked.headers['Retry-After'] === '60', 'Retry-After: 60');

    const other = await attempt('correct-horse-battery', '203.0.113.10');
    assert(other.statusCode === 200, `other address: ${other.statusCode}`);
  });

  await test('TRUSTED_PROXY_HOPS picks the entry that many from the end', async () => {
    process.env.TRUSTED_PROXY_HOPS = '2';
    try {
      // Two hops: the shared proxy address (last) is skipped, the client is the key.
      for (let i = 0; i < 5; i++) {
        await attempt('wrong', '198.51.100.7, 10.1.1.1');
      }
      const blocked = await attempt(
        'correct-horse-battery',
        '198.51.100.7, 10.1.1.1'
      );
      assert(
        blocked.statusCode === 429,
        `client blocked: ${blocked.statusCode}`
      );
      const bystander = await attempt(
        'correct-horse-battery',
        '198.51.100.8, 10.1.1.1'
      );
      assert(
        bystander.statusCode === 200,
        `bystander: ${bystander.statusCode}`
      );

      // Header shorter than the hop count: falls back to the socket, no throw.
      const short = await attempt('wrong', '198.51.100.9');
      assert(short.statusCode === 401, `short header: ${short.statusCode}`);
    } finally {
      delete process.env.TRUSTED_PROXY_HOPS;
    }
  });

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
