/**
 * Tests for the agent and spend tiles in src/api/healthChecks.js
 *
 * Fake CLIs on PATH stand in for the real ones; nothing here reaches a network.
 *
 * Covers:
 *  1. Bob's tile keeps every string it had under the old `bob` id
 *  2. Claude's tile is labelled by the adapter and checks ANTHROPIC_API_KEY
 *  3. A missing or slow binary is reported by the adapter's product name
 *  4. runAll registers the Bobcoins tile for Bob and the spend tile otherwise
 *  5. The spend tile: unmetered, within budget, low, and exhausted
 *  6. The GitHub tile probes every configured repo and names the first failure
 *  7. The profile tile fails when a repo's profile cannot run with the agent
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-health-'));
const binDir = path.join(sandbox, 'bin');
fs.mkdirSync(binDir);
process.env.HOME = sandbox;
process.env.CREDIT_LEDGER_PATH = path.join(sandbox, 'ledger.jsonl');
delete process.env.ES_URL;
process.env.GITHUB_AI_AGENT_REPOS = 'carbon,carbon-ai-chat';
delete process.env.GITHUB_AI_AGENT_OWNER;
delete process.env.GITHUB_AI_AGENT_REPO;
for (const k of [
  'GITHUB_AI_AGENT_TOKEN',
  'BOB_API_KEY',
  'BOB_TEAM_ID',
  'ANTHROPIC_API_KEY',
  'GITHUB_AI_AGENT_CLI',
  'BOB_CHECK_TIMEOUT_MS',
]) {
  delete process.env[k];
}

const health = require('../src/api/healthChecks');
const constants = require('../src/constants');

const realPath = process.env.PATH;
const script = (name, body) =>
  fs.writeFileSync(path.join(binDir, name), `#!/bin/sh\n${body}\n`, {
    mode: 0o755,
  });

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

function useAgent(id) {
  process.env.GITHUB_AI_AGENT_CLI = id;
}

async function main() {
  console.log('\n🩺 Agent and spend health tile tests\n');

  await test('Bob: the tile is `agent`, labelled and worded as `bob` was', async () => {
    script('bob', 'echo 2.0.5');
    process.env.PATH = binDir;
    useAgent('bob');

    process.env.BOB_API_KEY = 'k';
    assert.deepStrictEqual(await health.checkAgent(), {
      id: 'agent',
      label: 'Bob Shell CLI',
      status: 'succeeded',
      detail: 'v2.0.5 — API key configured',
      hint: null,
    });

    process.env.BOB_TEAM_ID = 'team-1';
    assert.strictEqual((await health.checkAgent()).hint, 'Team team-1');
    delete process.env.BOB_TEAM_ID;

    delete process.env.BOB_API_KEY;
    assert.deepStrictEqual(await health.checkAgent(), {
      id: 'agent',
      label: 'Bob Shell CLI',
      status: 'failed',
      detail: 'v2.0.5 — not authenticated',
      hint:
        'BOB_API_KEY is not set. Bob falls back to browser SSO, which cannot ' +
        'complete in a container, so reviews will fail.',
    });
  });

  await test('Bob: a missing binary and a slow one read as before', async () => {
    useAgent('bob');
    process.env.PATH = path.join(sandbox, 'empty');
    assert.deepStrictEqual(await health.checkAgent(), {
      id: 'agent',
      label: 'Bob Shell CLI',
      status: 'failed',
      detail: 'Not found on PATH',
      hint: 'spawn bob ENOENT',
    });

    script('bob', 'sleep 5');
    process.env.PATH = `${binDir}:/bin:/usr/bin`;
    process.env.BOB_CHECK_TIMEOUT_MS = '200';
    const slow = await health.checkAgent();
    delete process.env.BOB_CHECK_TIMEOUT_MS;
    assert.strictEqual(slow.status, 'caution-major');
    assert.strictEqual(slow.detail, 'Did not respond within 0s');
    assert.strictEqual(
      slow.hint,
      'Bob is installed but slow to start. Raise BOB_CHECK_TIMEOUT_MS, or give the container more CPU.'
    );
  });

  await test('Claude: the tile is labelled by the adapter and needs ANTHROPIC_API_KEY', async () => {
    script('claude', 'echo "2.1.302 (Claude Code)"');
    process.env.PATH = binDir;
    useAgent('claude');

    process.env.ANTHROPIC_API_KEY = 'sk-test';
    process.env.BOB_TEAM_ID = 'ignored';
    assert.deepStrictEqual(await health.checkAgent(), {
      id: 'agent',
      label: 'Claude Code CLI',
      status: 'succeeded',
      detail: 'v2.1.302 (Claude Code) — API key configured',
      hint: null,
    });
    delete process.env.BOB_TEAM_ID;

    delete process.env.ANTHROPIC_API_KEY;
    process.env.BOB_API_KEY = 'a bob key does not authenticate claude';
    const unauth = await health.checkAgent();
    delete process.env.BOB_API_KEY;
    assert.strictEqual(unauth.status, 'failed');
    assert.strictEqual(
      unauth.detail,
      'v2.1.302 (Claude Code) — not authenticated'
    );
    assert.match(unauth.hint, /^ANTHROPIC_API_KEY is not set/);
    assert.ok(!/SSO|BOB/.test(unauth.hint), unauth.hint);
  });

  await test('Claude: a missing binary names the product', async () => {
    useAgent('claude');
    process.env.PATH = path.join(sandbox, 'empty');
    const missing = await health.checkAgent();
    assert.strictEqual(missing.label, 'Claude Code CLI');
    assert.strictEqual(missing.detail, 'Not found on PATH');

    script('claude', 'echo broken >&2; exit 3');
    process.env.PATH = binDir;
    const broken = await health.checkAgent();
    assert.strictEqual(broken.detail, 'Failed to run');
    assert.strictEqual(broken.hint, 'broken');
  });

  await test('runAll: Bobcoins for Bob, spend for Claude, agent tile for both', async () => {
    script('bob', 'echo 2.0.5');
    script('claude', 'echo 2.1.302');
    process.env.PATH = binDir;

    useAgent('bob');
    const bob = await health.runAll();
    assert.deepStrictEqual(
      bob.checks.map((c) => c.id),
      ['agent', 'profiles', 'bobcoins', 'carbon-mcp', 'github', 'elasticsearch']
    );

    useAgent('claude');
    const claude = await health.runAll();
    assert.deepStrictEqual(
      claude.checks.map((c) => c.id),
      ['agent', 'profiles', 'spend', 'carbon-mcp', 'github', 'elasticsearch']
    );
    assert.strictEqual(claude.checks[2].label, 'Spend');
  });

  // ── GitHub tile: every configured repository is probed ─────────────────────
  // `repos` maps a repo name to { status, delay, body, message }; the default is
  // a 200 with push access.
  async function withGithub(repos, fn) {
    let inFlight = 0;
    let maxInFlight = 0;
    const seen = [];
    const server = http.createServer((req, res) => {
      const repo = /^\/repos\/[^/]+\/([^/]+)$/.exec(req.url)?.[1];
      const respond = (status, body) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.url === '/rate_limit') {
        return respond(200, {
          resources: { core: { remaining: 4900, limit: 5000 } },
        });
      }
      const spec = repos[repo] || {};
      seen.push(repo);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      setTimeout(() => {
        inFlight--;
        respond(
          spec.status || 200,
          spec.body || { permissions: { push: true }, message: spec.message }
        );
      }, spec.delay || 0);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    process.env.GITHUB_AI_AGENT_TOKEN = 'token';
    process.env.GITHUB_API_BASE_URL = `http://127.0.0.1:${server.address().port}`;
    try {
      return await fn({ seen, maxInFlight: () => maxInFlight });
    } finally {
      delete process.env.GITHUB_AI_AGENT_TOKEN;
      delete process.env.GITHUB_API_BASE_URL;
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  }

  await test('GitHub: every repo is probed together, and all OK reads as before with the repos named', async () => {
    await withGithub(
      { carbon: { delay: 100 }, 'carbon-ai-chat': { delay: 100 } },
      async (probe) => {
        const tile = await health.checkGitHub();
        assert.deepStrictEqual(tile, {
          id: 'github',
          label: 'GitHub',
          status: 'succeeded',
          detail: '4900/5000 API calls remaining',
          hint: 'Monitoring carbon, carbon-ai-chat',
        });
        assert.deepStrictEqual([...probe.seen].sort(), [
          'carbon',
          'carbon-ai-chat',
        ]);
        assert.strictEqual(probe.maxInFlight(), 2, 'probed concurrently');
      }
    );
  });

  await test('GitHub: one of two repos failing fails the tile and names the repo and the reason', async () => {
    await withGithub({ 'carbon-ai-chat': { status: 404 } }, async () => {
      const tile = await health.checkGitHub();
      assert.strictEqual(tile.status, 'failed');
      assert.strictEqual(
        tile.detail,
        'carbon-ai-chat: 404 (token cannot see this repository)'
      );
      assert.ok(/fine-grained token/.test(tile.hint), tile.hint);
    });
  });

  await test('GitHub: with two failures the first in list order is reported, whichever answers first', async () => {
    await withGithub(
      {
        carbon: {
          status: 403,
          message: 'Resource protected by SAML SSO',
          delay: 150,
        },
        'carbon-ai-chat': { status: 404 },
      },
      async () => {
        const tile = await health.checkGitHub();
        assert.strictEqual(
          tile.detail,
          'carbon: not SSO-authorized for carbon-design-system'
        );
        assert.ok(tile.hint.includes('/orgs/carbon-design-system/sso'));
      }
    );
  });

  await test('GitHub: a rejected token, another 403 and a server error each name the repo', async () => {
    const detail = async (spec) =>
      withGithub(
        { 'carbon-ai-chat': spec },
        async () => (await health.checkGitHub()).detail
      );
    assert.strictEqual(
      await detail({ status: 401 }),
      'carbon-ai-chat: token rejected'
    );
    assert.strictEqual(
      await detail({ status: 403, message: 'Forbidden' }),
      'carbon-ai-chat: access forbidden'
    );
    assert.strictEqual(
      await detail({ status: 502 }),
      'carbon-ai-chat: HTTP 502'
    );
  });

  await test('GitHub: an unreachable host fails the tile naming the first repo', async () => {
    await withGithub({}, async () => {
      process.env.GITHUB_API_BASE_URL = 'http://127.0.0.1:1';
      const tile = await health.checkGitHub();
      assert.strictEqual(tile.status, 'failed');
      assert.strictEqual(tile.detail, 'carbon: unreachable');
    });
  });

  await test('GitHub: a repo the token can read but not label is a warning that names it', async () => {
    await withGithub(
      { 'carbon-ai-chat': { body: { permissions: { pull: true } } } },
      async () => {
        const tile = await health.checkGitHub();
        assert.strictEqual(tile.status, 'caution-major');
        assert.strictEqual(
          tile.detail,
          'Read-only on carbon-design-system/carbon-ai-chat'
        );
      }
    );
  });

  await test('GitHub: no token is still one failure, before any probe', async () => {
    delete process.env.GITHUB_AI_AGENT_TOKEN;
    const tile = await health.checkGitHub();
    assert.strictEqual(tile.detail, 'No token configured');
  });

  // ── Profile tile ────────────────────────────────────────────────────────────
  await test('profiles: Bob can run every configured repo, and the tile lists each profile', async () => {
    useAgent('bob');
    assert.deepStrictEqual(await health.checkProfiles(), {
      id: 'profiles',
      label: 'Review profiles',
      status: 'succeeded',
      detail: 'carbon: core, carbon-ai-chat: caic',
      hint: null,
    });
  });

  await test('profiles: the caic profile with Claude is a FAILED tile carrying the error', async () => {
    useAgent('claude');
    const tile = await health.checkProfiles();
    assert.strictEqual(tile.id, 'profiles');
    assert.strictEqual(tile.status, 'failed');
    assert.strictEqual(
      tile.detail,
      'carbon-ai-chat uses the caic profile, which runs on Bob only (GITHUB_AI_AGENT_CLI is "claude").'
    );
    script('claude', 'echo 2.1.302');
    process.env.PATH = binDir;
    const all = await health.runAll();
    const found = all.checks.find((c) => c.id === 'profiles');
    assert.strictEqual(found.status, 'failed');
    assert.strictEqual(all.overall, 'failed');
  });

  await test('profiles: with no agent named the default (Bob) is checked', async () => {
    delete process.env.GITHUB_AI_AGENT_CLI;
    assert.strictEqual((await health.checkProfiles()).status, 'succeeded');
  });

  await test('spend tile: unmetered shows the month so far and says why there is no percentage', async () => {
    useAgent('claude');
    const now = new Date().toISOString();
    fs.writeFileSync(
      process.env.CREDIT_LEDGER_PATH,
      [
        { at: now, coinsSpent: 1.25, costUnit: 'usd' },
        { at: now, coinsSpent: 0.5, source: 'claude-result' },
        { at: now, coinsSpent: 40, costUnit: 'bobcoins' },
        { at: '2020-01-01T00:00:00.000Z', coinsSpent: 99, costUnit: 'usd' },
      ]
        .map((e) => JSON.stringify(e))
        .join('\n') + '\n'
    );
    const tile = await health.checkSpend();
    assert.deepStrictEqual(tile, {
      id: 'spend',
      label: 'Spend',
      status: 'succeeded',
      detail: '$1.75 spent this month',
      hint: 'From the local ledger. No monthly budget set (CLAUDE_MONTHLY_BUDGET_USD).',
    });
  });

  await test('spend tile: a budget shows what is left, warns below the low-water mark and fails at zero', async () => {
    useAgent('claude');
    try {
      constants.CLAUDE_MONTHLY_BUDGET_USD = 10;
      const ok = await health.checkSpend();
      assert.strictEqual(ok.status, 'succeeded');
      assert.strictEqual(ok.detail, '$1.75 spent this month of $10');
      assert.strictEqual(ok.hint, 'From the local ledger. 83% remaining.');

      constants.CLAUDE_MONTHLY_BUDGET_USD = 1.9;
      const low = await health.checkSpend();
      assert.strictEqual(low.status, 'caution-major');
      assert.match(
        low.hint,
        /8% remaining — below 10% of the monthly budget\./
      );

      constants.CLAUDE_BUDGET_LOW_PCT = 5;
      const fine = await health.checkSpend();
      assert.strictEqual(fine.status, 'succeeded', 'the Claude mark, not Bob');
      constants.CLAUDE_BUDGET_LOW_PCT = 10;

      constants.CLAUDE_MONTHLY_BUDGET_USD = 1.5;
      const spent = await health.checkSpend();
      assert.strictEqual(spent.status, 'failed');
    } finally {
      constants.CLAUDE_MONTHLY_BUDGET_USD = 0;
      constants.CLAUDE_BUDGET_LOW_PCT = 10;
    }
  });

  process.env.PATH = realPath;
  fs.rmSync(sandbox, { recursive: true, force: true });
  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
