/**
 * Tests for /api/ready and the startup configuration check
 *
 * Covers:
 *  1. /api/ready is unauthenticated and 503s when the agent binary is missing
 *  2. After the first check the cached answer is returned at once and refreshed
 *     in the background; a present binary then gives 200
 *  3. A binary seen once stays ready if a later probe fails
 *  4. An invalid GITHUB_AI_AGENT_CLI gives 503 with the reason
 *  5. Missing tokens and Elasticsearch are warnings on a 200, never a 503
 *  6. checkStartup logs one line per missing variable, per mode
 *  7. /api/health is unchanged
 *  8. claude is probed by its own binary and needs ANTHROPIC_API_KEY
 */

process.env.CARBON_MONITOR_SKIP_DOTENV = '1';
process.env.AUTH_REQUIRED = 'true';
process.env.API_SECRET = 'supersecret';

const fs = require('fs');
const os = require('os');
const path = require('path');

const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-ready-'));
const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-ready-empty-'));
const fakeBob = path.join(binDir, 'bob');
const fakeClaude = path.join(binDir, 'claude');

const { handleRequest } = require('../src/api/server');
const { checkStartup, getStartupProblems } = require('../src/config/env');

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

function fakeRes() {
  return {
    statusCode: null,
    body: '',
    setHeader() {},
    writeHead(status) {
      this.statusCode = status;
    },
    end(chunk) {
      if (chunk) this.body += chunk;
    },
  };
}

async function get(url) {
  const res = fakeRes();
  await handleRequest(
    { method: 'GET', url, headers: { host: 'localhost' } },
    res
  );
  return { status: res.statusCode, json: JSON.parse(res.body) };
}

function withLogs(fn) {
  const lines = [];
  const original = console.warn;
  console.warn = (...args) => lines.push(args.join(' '));
  try {
    fn();
  } finally {
    console.warn = original;
  }
  return lines;
}

async function main() {
  console.log('\n🩺 Readiness and startup check tests\n');

  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  const realPath = process.env.PATH;
  const saved = {};
  for (const k of [
    'GITHUB_AI_AGENT_CLI',
    'GITHUB_AI_AGENT_TOKEN',
    'BOB_API_KEY',
    'ANTHROPIC_API_KEY',
    'ES_URL',
  ]) {
    saved[k] = process.env[k];
    delete process.env[k];
  }

  try {
    await test('503 without auth when the agent binary is missing', async () => {
      process.env.PATH = emptyDir;
      const { status, json } = await get('/api/ready');
      assert(status === 503, `expected 503, got ${status}`);
      assert(json.ready === false, 'ready should be false');
      assert(
        json.reasons.some((r) => r.includes("'bob'")),
        `reasons should name the agent: ${JSON.stringify(json.reasons)}`
      );
    });

    await test('a stale answer is returned at once and refreshed in the background', async () => {
      fs.writeFileSync(fakeBob, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      process.env.PATH = binDir;
      now += 6_000; // past the miss retry window
      const first = await get('/api/ready');
      assert(
        first.status === 503,
        `stale miss answers at once: ${first.status}`
      );
      let last = first;
      for (let i = 0; i < 60 && last.status !== 200; i++) {
        await new Promise((r) => setTimeout(r, 50));
        last = await get('/api/ready');
      }
      assert(
        last.status === 200,
        `expected 200 after refresh, got ${last.status}`
      );
      assert(last.json.ready === true, 'ready should be true');
      assert(
        last.json.warnings.some((w) => w.includes('ES_URL')),
        'Elasticsearch should be a warning'
      );
    });

    await test('a binary seen working stays ready if a later probe fails', async () => {
      fs.rmSync(fakeBob);
      now += 61_000; // past the cache window, so a refresh runs
      const { status } = await get('/api/ready');
      assert(status === 200, `expected 200, got ${status}`);
      await new Promise((r) => setTimeout(r, 300)); // let the failed refresh land
      const again = await get('/api/ready');
      assert(
        again.status === 200,
        `still ready after a miss, got ${again.status}`
      );
    });

    await test('an invalid agent is a 503 with the reason', async () => {
      process.env.GITHUB_AI_AGENT_CLI = 'not-an-agent';
      const { status, json } = await get('/api/ready');
      assert(status === 503, `expected 503, got ${status}`);
      assert(
        json.reasons.some((r) => r.includes('Invalid GITHUB_AI_AGENT_CLI')),
        JSON.stringify(json.reasons)
      );
      delete process.env.GITHUB_AI_AGENT_CLI;
    });

    await test('checkStartup logs one line per missing variable', () => {
      const lines = withLogs(() => {
        const problems = checkStartup({ mode: 'cli' });
        assert(problems.length === 2, `got ${JSON.stringify(problems)}`);
      });
      assert(lines.length === 2, `expected 2 lines, got ${lines.length}`);
      assert(lines[0].includes('GITHUB_AI_AGENT_TOKEN'), lines[0]);
      assert(lines[1].includes('BOB_API_KEY'), lines[1]);
      assert(getStartupProblems().length === 2, 'getStartupProblems');
    });

    await test('server mode adds the sign-in variables only when auth is required', () => {
      process.env.GITHUB_AI_AGENT_TOKEN = 't';
      process.env.BOB_API_KEY = 'k';
      let lines = withLogs(() => checkStartup({ mode: 'server' }));
      assert(lines.length === 0, 'open console needs nothing more');

      lines = withLogs(() =>
        checkStartup({
          mode: 'server',
          authRequired: true,
          bearerEnabled: true,
        })
      );
      assert(lines.length === 2, `expected CONSOLE_* x2, got ${lines.length}`);
      process.env.CONSOLE_USERNAME = 'u';
      process.env.CONSOLE_PASSWORD = 'p';
      lines = withLogs(() =>
        checkStartup({
          mode: 'server',
          authRequired: true,
          bearerEnabled: true,
        })
      );
      assert(lines.length === 0, 'API_SECRET and console creds are set');
      lines = withLogs(() => {
        const original = process.env.API_SECRET;
        delete process.env.API_SECRET;
        checkStartup({
          mode: 'server',
          authRequired: true,
          bearerEnabled: true,
        });
        process.env.API_SECRET = original;
      });
      assert(lines.length === 1 && lines[0].includes('API_SECRET'), lines[0]);
      delete process.env.CONSOLE_USERNAME;
      delete process.env.CONSOLE_PASSWORD;
    });

    await test('/api/ready reports startup problems as warnings with a 200', async () => {
      delete process.env.GITHUB_AI_AGENT_TOKEN;
      withLogs(() => checkStartup({ mode: 'cli' }));
      process.env.PATH = binDir;
      fs.writeFileSync(fakeBob, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      const { status, json } = await get('/api/ready');
      assert(status === 200, `expected 200, got ${status}`);
      assert(
        json.warnings.some((w) => w.includes('GITHUB_AI_AGENT_TOKEN')),
        JSON.stringify(json.warnings)
      );
    });

    await test('/api/health is still the plain liveness response', async () => {
      const { status, json } = await get('/api/health');
      assert(status === 200 && json.status === 'healthy', 'health unchanged');
      assert(!('ready' in json), 'health must not carry readiness');
    });

    await test('claude is probed by its own binary, and the reason names claude', async () => {
      process.env.GITHUB_AI_AGENT_CLI = 'claude';
      process.env.PATH = emptyDir;
      const missing = await get('/api/ready');
      assert(missing.status === 503, `expected 503, got ${missing.status}`);
      assert(
        missing.json.reasons.some((r) => r.includes("'claude'")),
        JSON.stringify(missing.json.reasons)
      );

      // A bob on PATH must not satisfy a claude deployment.
      fs.writeFileSync(fakeBob, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      process.env.PATH = binDir;
      now += 6_000;
      let last = await get('/api/ready');
      for (let i = 0; i < 8 && last.status === 503; i++) {
        await new Promise((r) => setTimeout(r, 50));
        last = await get('/api/ready');
      }
      assert(last.status === 503, `bob alone is not claude: ${last.status}`);

      fs.writeFileSync(fakeClaude, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      now += 6_000;
      for (let i = 0; i < 60 && last.status !== 200; i++) {
        await new Promise((r) => setTimeout(r, 50));
        last = await get('/api/ready');
      }
      assert(last.status === 200, `expected 200, got ${last.status}`);
    });

    await test('claude needs ANTHROPIC_API_KEY, not BOB_API_KEY', async () => {
      process.env.GITHUB_AI_AGENT_CLI = 'claude';
      process.env.GITHUB_AI_AGENT_TOKEN = 't';
      process.env.BOB_API_KEY = 'k';
      let problems = [];
      withLogs(() => {
        problems = checkStartup({ mode: 'cli' });
      });
      assert(
        problems.length === 1 && problems[0].startsWith('ANTHROPIC_API_KEY'),
        JSON.stringify(problems)
      );
      const { status, json } = await get('/api/ready');
      assert(status === 200, `a missing key is a warning, got ${status}`);
      assert(
        json.warnings.some((w) => w.includes('ANTHROPIC_API_KEY')),
        JSON.stringify(json.warnings)
      );

      process.env.ANTHROPIC_API_KEY = 'sk-test';
      delete process.env.BOB_API_KEY;
      withLogs(() => {
        problems = checkStartup({ mode: 'cli' });
      });
      assert(problems.length === 0, JSON.stringify(problems));
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.GITHUB_AI_AGENT_CLI;
    });
  } finally {
    Date.now = realNow;
    process.env.PATH = realPath;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(binDir, { recursive: true, force: true });
    fs.rmSync(emptyDir, { recursive: true, force: true });
  }

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
