/**
 * tests/profile.test.js — AC-16, AC-17
 *
 * AC-16: SKILL.md has `name` equal to the directory name and a non-empty
 *        `description`; given the file missing, checkRepos for a caic repo
 *        throws.
 * AC-17: Given a caic repo with GITHUB_AI_AGENT_CLI=claude, checkRepos fails
 *        with a message naming the repo; a core repo with Claude is accepted.
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

// ── Load profiles (clear require cache between env tests) ─────────────────────

function loadProfiles() {
  // Fresh copy each time, so a BY_REPO edit in one case does not leak into the next.
  delete require.cache[require.resolve('../src/profiles/index.js')];
  return require('../src/profiles/index.js');
}

// ── AC-16: SKILL.md frontmatter and checkRepos fail-fast ─────────────────────────
console.log(
  '\n── AC-16: skill file validation ───────────────────────────────'
);

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
    // checkRepos() throw, which is the other half of AC-16.
    console.log(
      '    ⚠️  skill not yet created — content check deferred to Task 7'
    );
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
    console.log(
      '    ⚠️  skill not yet created — content check deferred to Task 7'
    );
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

test('checkRepos(["carbon-ai-chat"], "bob") throws when the skill file is missing', () => {
  // Temporarily rename the skill file if it exists so we can test the throw.
  const exists = fs.existsSync(SKILL_FILE);
  if (exists) {
    fs.renameSync(SKILL_FILE, SKILL_FILE + '.bak');
  }
  try {
    const profiles = loadProfiles();
    let threw = false;
    try {
      profiles.checkRepos(['carbon-ai-chat'], 'bob');
    } catch (err) {
      threw = true;
      assert.ok(
        err.message.includes('caic-pr-review'),
        `Error should name the skill; got: ${err.message}`
      );
      assert.ok(
        err.message.includes('carbon-ai-chat'),
        `Error should name the repo; got: ${err.message}`
      );
    }
    assert.ok(
      threw,
      'checkRepos should throw when SKILL.md is missing for a caic repo'
    );
  } finally {
    if (exists) fs.renameSync(SKILL_FILE + '.bak', SKILL_FILE);
  }
});

// ── AC-17: caic + claude = startup error; core + claude = unchanged ───────────
console.log(
  '\n── AC-17: caic rejects Claude; core with Claude is unchanged ──'
);

test('checkRepos(["carbon","carbon-ai-chat"], "claude") throws and names carbon-ai-chat', () => {
  // Create a stub skill file so the check doesn't fail before the agent check.
  const skillExists = fs.existsSync(SKILL_FILE);
  if (!skillExists) {
    fs.mkdirSync(SKILL_DIR, { recursive: true });
    fs.writeFileSync(
      SKILL_FILE,
      '---\nname: caic-pr-review\ndescription: stub\n---\n'
    );
  }
  try {
    const profiles = loadProfiles();
    let threw = false;
    try {
      profiles.checkRepos(['carbon', 'carbon-ai-chat'], 'claude');
    } catch (err) {
      threw = true;
      assert.ok(
        err.message.includes('carbon-ai-chat'),
        `Error should name carbon-ai-chat; got: ${err.message}`
      );
      assert.ok(
        err.message.includes('Bob only'),
        `Error should say Bob only; got: ${err.message}`
      );
      assert.ok(
        err.message.includes('"claude"'),
        `Error should name the agent; got: ${err.message}`
      );
    }
    assert.ok(threw, 'caic repo with claude should throw');
  } finally {
    if (!skillExists) fs.rmSync(SKILL_FILE);
  }
});

test('checkRepos(["carbon"], "claude") does not throw', () => {
  const profiles = loadProfiles();
  profiles.checkRepos(['carbon'], 'claude');
});

test('checkRepos(["carbon","carbon-ai-chat"], "bob") does not throw', () => {
  const profiles = loadProfiles();
  profiles.checkRepos(['carbon', 'carbon-ai-chat'], 'bob');
});

test('forRepo("carbon") is the core profile with Claude and Bob alike', () => {
  const profiles = loadProfiles();
  assert.strictEqual(profiles.forRepo('carbon').id, 'core');
  assert.strictEqual(profiles.forRepo('carbon'), profiles.CORE);
});

test('forRepo("carbon-ai-chat") is the caic profile', () => {
  const profiles = loadProfiles();
  assert.strictEqual(profiles.forRepo('carbon-ai-chat').id, 'caic');
  assert.strictEqual(profiles.forRepo('carbon-ai-chat'), profiles.CAIC);
});

test('forRepo returns core for an unknown repo', () => {
  const profiles = loadProfiles();
  assert.strictEqual(profiles.forRepo('some-other-repo'), profiles.CORE);
});

for (const inherited of ['constructor', 'toString', '__proto__']) {
  test(`forRepo("${inherited}") is core, not an inherited object member`, () => {
    const profiles = loadProfiles();
    assert.strictEqual(profiles.forRepo(inherited), profiles.CORE);
  });
}

test('BY_REPO is the exported mutable map the eval wrapper edits', () => {
  const profiles = loadProfiles();
  assert.strictEqual(profiles.BY_REPO['carbon-ai-chat'], profiles.CAIC);
  profiles.BY_REPO['scratch-repo'] = profiles.CAIC;
  assert.strictEqual(profiles.forRepo('scratch-repo'), profiles.CAIC);
});

test('the registry no longer exports resolve', () => {
  const profiles = loadProfiles();
  assert.strictEqual(profiles.resolve, undefined);
});

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}  Failed: ${failed}`);
if (failed > 0) process.exit(1);
