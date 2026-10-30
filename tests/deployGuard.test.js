'use strict';
// tests/deployGuard.test.js — AC-19
//
// Runs scripts/deployGuard.sh check_deploy_target via zsh.
// Skipped when zsh is unavailable (e.g. some CI environments).

const { execFileSync, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ── skip if zsh is missing ────────────────────────────────────────────────────
const ZSH = (() => {
  try {
    execFileSync('which', ['zsh'], { stdio: 'pipe' });
    return 'zsh';
  } catch {
    return null;
  }
})();

if (!ZSH) {
  console.log('⚠ zsh not found — deployGuard tests skipped (run locally)');
  process.exit(0);
}

// ── helpers ───────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function assert(label, ok) {
  if (ok) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.error(`  ❌ ${label}`);
    failed++;
  }
}

/**
 * Run the guard function in an isolated zsh snippet.
 *
 * @param {object} liveEnv  - env vars the stub ibmcloud will report (or null → app not found)
 * @param {object} fileEnv  - env vars set in the "env file" (GITHUB_AI_AGENT_REPO etc.)
 * @param {object} [extra]  - extra shell env (e.g. DEPLOY_ALLOW_TARGET_CHANGE)
 * @returns {{ code, stdout, stderr }}
 */
function runGuard(liveEnv, fileEnv, extra = {}) {
  // Build a fake JSON blob that ibmcloud would return. The awk in the guard
  // only looks for "name" / "value" pairs in a flat scan — matching CE JSON.
  const buildJson = (env) => {
    if (!env) return ''; // empty → app not found
    const pairs = Object.entries(env)
      .map(([k, v]) => `    {"name":"${k}","value":"${v}"}`)
      .join(',\n');
    return `{"spec":{"template":{"spec":{"containers":[{"env":[${pairs}]}]}}}}`;
  };

  const liveJson = buildJson(liveEnv);

  // Write a stub ibmcloud script to a temp dir
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-test-'));
  const stubPath = path.join(tmpDir, 'ibmcloud');
  fs.writeFileSync(
    stubPath,
    '#!/bin/sh\n' +
      // ibmcloud ce app get --name X --output json → $1=ce $2=app $3=get $6=--output
      'if [ "$1" = "ce" ] && [ "$2" = "app" ] && [ "$3" = "get" ] && [ "$6" = "--output" ]; then\n' +
      (liveJson
        ? "  printf '%s\\n' " + JSON.stringify(liveJson) + '\n  exit 0\n'
        : '  exit 1\n') + // non-zero → app not found
      'fi\n' +
      'exit 0\n'
  );
  fs.chmodSync(stubPath, 0o755);

  const guardPath = path.resolve(__dirname, '../scripts/deployGuard.sh');

  // Build a self-contained zsh snippet: define die/warn, source the guard, call
  // check_deploy_target, capture outcome.
  // Build the snippet using string concat to avoid template-literal expansion of $PATH.
  const snippet = [
    '#!/usr/bin/env zsh',
    'set -euo pipefail',
    'export PATH=' + JSON.stringify(tmpDir) + ':$PATH',
    "RED=''; GRN=''; YLW=''; BLU=''; CLR=''",
    'warn(){ print -r -- "WARN: $*" >&2; }',
    'die(){ print -r -- "DIE: $*" >&2; exit 1; }',
    'source ' + JSON.stringify(guardPath),
    'check_deploy_target \\',
    '  "my-app" \\',
    '  ' + JSON.stringify(fileEnv.GITHUB_AI_AGENT_REPO || 'carbon') + ' \\',
    '  ' + JSON.stringify(fileEnv.REVIEW_PROFILE || '') + ' \\',
    '  ' + JSON.stringify(fileEnv.ES_INDEX_PREFIX || ''),
  ].join('\n');

  const result = spawnSync(ZSH, ['-c', snippet], {
    env: { ...process.env, ...extra, PATH: `${tmpDir}:${process.env.PATH}` },
    encoding: 'utf8',
  });

  fs.rmSync(tmpDir, { recursive: true, force: true });

  return {
    code: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

// ── tests ─────────────────────────────────────────────────────────────────────

console.log(
  '\n── AC-19: deploy guard ──────────────────────────────────────────────'
);

// 1. App does not exist → guard passes (no ibmcloud output, exit 1 from stub)
{
  const r = runGuard(null, { GITHUB_AI_AGENT_REPO: 'carbon' });
  assert('app does not exist → proceeds (exit 0)', r.code === 0);
}

// 2. Matching values → proceeds
{
  const live = {
    GITHUB_AI_AGENT_REPO: 'carbon',
    REVIEW_PROFILE: 'core',
    ES_INDEX_PREFIX: '',
  };
  const file = {
    GITHUB_AI_AGENT_REPO: 'carbon',
    REVIEW_PROFILE: 'core',
    ES_INDEX_PREFIX: '',
  };
  const r = runGuard(live, file);
  assert('matching values → proceeds (exit 0)', r.code === 0);
  assert('matching values → no DIE output', !r.stderr.includes('DIE:'));
}

// 3. Repo mismatch → aborts
{
  const live = {
    GITHUB_AI_AGENT_REPO: 'carbon',
    REVIEW_PROFILE: '',
    ES_INDEX_PREFIX: '',
  };
  const file = {
    GITHUB_AI_AGENT_REPO: 'carbon-ai-chat',
    REVIEW_PROFILE: '',
    ES_INDEX_PREFIX: '',
  };
  const r = runGuard(live, file);
  assert('repo mismatch → exit non-zero', r.code !== 0);
  assert(
    'repo mismatch → DIE message mentions GITHUB_AI_AGENT_REPO',
    r.stderr.includes('GITHUB_AI_AGENT_REPO')
  );
}

// 4. Profile mismatch → aborts
{
  const live = {
    GITHUB_AI_AGENT_REPO: 'carbon',
    REVIEW_PROFILE: 'core',
    ES_INDEX_PREFIX: '',
  };
  const file = {
    GITHUB_AI_AGENT_REPO: 'carbon',
    REVIEW_PROFILE: 'caic',
    ES_INDEX_PREFIX: '',
  };
  const r = runGuard(live, file);
  assert('profile mismatch → exit non-zero', r.code !== 0);
  assert(
    'profile mismatch → DIE message mentions REVIEW_PROFILE',
    r.stderr.includes('REVIEW_PROFILE')
  );
}

// 5. ES_INDEX_PREFIX mismatch → aborts
{
  const live = {
    GITHUB_AI_AGENT_REPO: 'carbon',
    REVIEW_PROFILE: '',
    ES_INDEX_PREFIX: '',
  };
  const file = {
    GITHUB_AI_AGENT_REPO: 'carbon',
    REVIEW_PROFILE: '',
    ES_INDEX_PREFIX: 'carbon-monitor-caic',
  };
  const r = runGuard(live, file);
  assert('prefix mismatch → exit non-zero', r.code !== 0);
  assert(
    'prefix mismatch → DIE message mentions ES_INDEX_PREFIX',
    r.stderr.includes('ES_INDEX_PREFIX')
  );
}

// 6. Mismatch + DEPLOY_ALLOW_TARGET_CHANGE=1 → proceeds with warning
{
  const live = {
    GITHUB_AI_AGENT_REPO: 'carbon',
    REVIEW_PROFILE: 'core',
    ES_INDEX_PREFIX: '',
  };
  const file = {
    GITHUB_AI_AGENT_REPO: 'carbon-ai-chat',
    REVIEW_PROFILE: 'caic',
    ES_INDEX_PREFIX: 'carbon-monitor-caic',
  };
  const r = runGuard(live, file, { DEPLOY_ALLOW_TARGET_CHANGE: '1' });
  assert(
    'DEPLOY_ALLOW_TARGET_CHANGE=1 + mismatch → proceeds (exit 0)',
    r.code === 0
  );
  assert(
    'DEPLOY_ALLOW_TARGET_CHANGE=1 + mismatch → WARN emitted',
    r.stderr.includes('WARN:')
  );
}

// 7. Empty REVIEW_PROFILE in live and env both normalize to "core" → not a mismatch
{
  const live = { GITHUB_AI_AGENT_REPO: 'carbon', ES_INDEX_PREFIX: '' }; // no REVIEW_PROFILE key
  const file = {
    GITHUB_AI_AGENT_REPO: 'carbon',
    REVIEW_PROFILE: 'core',
    ES_INDEX_PREFIX: '',
  };
  const r = runGuard(live, file);
  assert(
    'empty live REVIEW_PROFILE vs core env → not a mismatch (exit 0)',
    r.code === 0
  );
}

// ── summary ───────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}  Failed: ${failed}`);
if (failed > 0) process.exit(1);
