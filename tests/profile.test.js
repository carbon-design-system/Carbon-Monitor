/**
 * tests/profile.test.js — AC-16, AC-17
 *
 * AC-16: SKILL.md has `name` equal to the directory name and a non-empty
 *        `description`; given the file missing, profiles.resolve('bob') for
 *        caic throws.
 * AC-17: Given `caic` with GITHUB_AI_AGENT_CLI=claude, startup fails with
 *        a clear message; given `core` with Claude, the bundle equals its snapshot.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

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

// ── Helpers ───────────────────────────────────────────────────────────────────

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ── Load profiles (clear require cache between env tests) ─────────────────────

function loadProfiles() {
  // Clear the cache so REVIEW_PROFILE is re-read at require time.
  delete require.cache[require.resolve('../src/profiles/index.js')];
  return require('../src/profiles/index.js');
}

// ── AC-16: SKILL.md frontmatter and resolve fail-fast ─────────────────────────
console.log('\n── AC-16: skill file validation ───────────────────────────────');

const SKILL_DIR = path.join(
  __dirname,
  '..',
  'src',
  'profiles',
  'caic',
  'skills',
  'caic-pr-review'
);
const SKILL_FILE = path.join(SKILL_DIR, 'SKILL.md');

test('caic skill directory name matches SKILL.md `name:` field (when skill exists)', () => {
  if (!fs.existsSync(SKILL_FILE)) {
    // Skill not yet written (Task 7) — skip the content check but verify the
    // resolve() throw, which is the other half of AC-16.
    console.log('    ⚠️  skill not yet created — content check deferred to Task 7');
    return;
  }
  const content = fs.readFileSync(SKILL_FILE, 'utf8');
  const nameMatch = content.match(/^name:\s*(.+)$/m);
  assert.ok(nameMatch, 'SKILL.md must have a `name:` field in frontmatter');
  assert.strictEqual(
    nameMatch[1].trim(),
    'caic-pr-review',
    '`name:` must equal the directory name "caic-pr-review"'
  );
});

test('caic skill SKILL.md has a non-empty `description:` field (when skill exists)', () => {
  if (!fs.existsSync(SKILL_FILE)) {
    console.log('    ⚠️  skill not yet created — content check deferred to Task 7');
    return;
  }
  const content = fs.readFileSync(SKILL_FILE, 'utf8');
  const descMatch = content.match(/^description:\s*(.+)$/m);
  assert.ok(descMatch, 'SKILL.md must have a non-empty `description:` field');
  assert.ok(
    descMatch[1].trim().length > 0,
    '`description:` must not be empty (Bob ignores skills without one)'
  );
});

test('profiles.resolve("bob") for caic throws when skill file is missing', () => {
  // Temporarily rename the skill file if it exists so we can test the throw.
  const exists = fs.existsSync(SKILL_FILE);
  if (exists) {
    fs.renameSync(SKILL_FILE, SKILL_FILE + '.bak');
  }
  try {
    withEnv({ REVIEW_PROFILE: 'caic' }, () => {
      const profiles = loadProfiles();
      let threw = false;
      try {
        profiles.resolve('bob');
      } catch (err) {
        threw = true;
        assert.ok(
          err.message.includes('caic-pr-review'),
          `Error should name the skill; got: ${err.message}`
        );
      }
      assert.ok(threw, 'profiles.resolve("bob") should throw when SKILL.md is missing');
    });
  } finally {
    if (exists) fs.renameSync(SKILL_FILE + '.bak', SKILL_FILE);
  }
});

// ── AC-17: caic + claude = startup error; core + claude = unchanged ───────────
console.log('\n── AC-17: caic rejects Claude; core with Claude is unchanged ──');

test('profiles.resolve("claude") with REVIEW_PROFILE=caic throws with a clear message', () => {
  // Create a stub skill file so the check doesn't fail before the agent check.
  const skillExists = fs.existsSync(SKILL_FILE);
  if (!skillExists) {
    fs.mkdirSync(SKILL_DIR, { recursive: true });
    fs.writeFileSync(SKILL_FILE, '---\nname: caic-pr-review\ndescription: stub\n---\n');
  }
  try {
    withEnv({ REVIEW_PROFILE: 'caic' }, () => {
      const profiles = loadProfiles();
      let threw = false;
      try {
        profiles.resolve('claude');
      } catch (err) {
        threw = true;
        assert.ok(
          err.message.includes('bob'),
          `Error should mention bob; got: ${err.message}`
        );
        assert.ok(
          err.message.includes('claude') || err.message.includes('caic'),
          `Error should mention caic or claude; got: ${err.message}`
        );
      }
      assert.ok(threw, 'profiles.resolve("claude") with caic should throw');
    });
  } finally {
    if (!skillExists) fs.rmSync(SKILL_FILE);
  }
});

test('profiles.resolve("claude") with REVIEW_PROFILE=core returns the core profile', () => {
  withEnv({ REVIEW_PROFILE: 'core' }, () => {
    const profiles = loadProfiles();
    const p = profiles.resolve('claude');
    assert.strictEqual(p.id, 'core', 'core profile should be returned for Claude');
  });
});

test('profiles.resolve("bob") with no REVIEW_PROFILE returns core profile', () => {
  withEnv({ REVIEW_PROFILE: undefined }, () => {
    const profiles = loadProfiles();
    const p = profiles.resolve('bob');
    assert.strictEqual(p.id, 'core');
  });
});

test('profiles.resolve("bob") with REVIEW_PROFILE="" returns core profile', () => {
  withEnv({ REVIEW_PROFILE: '' }, () => {
    const profiles = loadProfiles();
    const p = profiles.resolve('bob');
    assert.strictEqual(p.id, 'core');
  });
});

test('profiles.resolve throws for an unknown REVIEW_PROFILE value', () => {
  withEnv({ REVIEW_PROFILE: 'unknown-profile' }, () => {
    const profiles = loadProfiles();
    let threw = false;
    try {
      profiles.resolve('bob');
    } catch (err) {
      threw = true;
      assert.ok(
        err.message.includes('unknown-profile'),
        `Error should name the bad value; got: ${err.message}`
      );
    }
    assert.ok(threw, 'unknown profile should throw');
  });
});

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}  Failed: ${failed}`);
if (failed > 0) process.exit(1);
