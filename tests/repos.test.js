'use strict';

// GITHUB_AI_AGENT_REPOS parsing in src/constants.js.

const assert = require('assert');

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

const KEYS = ['GITHUB_AI_AGENT_REPOS', 'GITHUB_AI_AGENT_REPO'];

// Loads constants.js fresh under the given env, restoring the env afterwards.
function load(env) {
  const saved = {};
  for (const k of KEYS) saved[k] = process.env[k];
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, env);
  const key = require.resolve('../src/constants.js');
  delete require.cache[key];
  try {
    return require('../src/constants.js');
  } finally {
    delete require.cache[key];
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

console.log(
  '\n── GITHUB_AI_AGENT_REPOS ──────────────────────────────────────'
);

test('unset gives ["carbon"]', () => {
  assert.deepStrictEqual(load({}).GITHUB_REPOS, ['carbon']);
});

test('only GITHUB_AI_AGENT_REPO=foo gives ["foo"]', () => {
  assert.deepStrictEqual(load({ GITHUB_AI_AGENT_REPO: 'foo' }).GITHUB_REPOS, [
    'foo',
  ]);
});

test('the plural variable wins over the singular one', () => {
  const c = load({
    GITHUB_AI_AGENT_REPOS: 'a,b',
    GITHUB_AI_AGENT_REPO: 'foo',
  });
  assert.deepStrictEqual(c.GITHUB_REPOS, ['a', 'b']);
});

test('entries are trimmed and deduplicated, keeping first-seen order', () => {
  const c = load({ GITHUB_AI_AGENT_REPOS: 'carbon, carbon-ai-chat ,carbon' });
  assert.deepStrictEqual(c.GITHUB_REPOS, ['carbon', 'carbon-ai-chat']);
});

test('owner/name throws, naming the entry', () => {
  assert.throws(
    () => load({ GITHUB_AI_AGENT_REPOS: 'carbon,owner/x' }),
    (err) =>
      err.message ===
      'GITHUB_AI_AGENT_REPOS takes repo names under GITHUB_AI_AGENT_OWNER, not owner/name: "owner/x"'
  );
});

test('a comma-only list throws the empty-list error', () => {
  assert.throws(
    () => load({ GITHUB_AI_AGENT_REPOS: ', ,' }),
    (err) =>
      err.message ===
      'At least one non-empty repository name is required in GITHUB_AI_AGENT_REPOS or GITHUB_AI_AGENT_REPO.'
  );
});

test('a whitespace-only singular fallback throws the empty-list error', () => {
  assert.throws(
    () => load({ GITHUB_AI_AGENT_REPO: '   ' }),
    (err) =>
      err.message ===
      'At least one non-empty repository name is required in GITHUB_AI_AGENT_REPOS or GITHUB_AI_AGENT_REPO.'
  );
});

test('MAX_PRS_PER_REPO replaces MAX_PRS_PER_RUN', () => {
  const c = load({});
  assert.strictEqual(typeof c.MAX_PRS_PER_REPO, 'number');
  assert.strictEqual(c.MAX_PRS_PER_RUN, undefined);
  assert.strictEqual(c.GITHUB_REPO, undefined);
});

console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}  Failed: ${failed}`);
if (failed > 0) process.exit(1);
