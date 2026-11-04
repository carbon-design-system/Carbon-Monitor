'use strict';
// tests/caicBundle.test.js — AC-15, AC-16
//
// Verifies that when the caic profile is resolved and a Bob bundle is prepared,
// .bob/skills/ holds exactly carbon-builder and caic-pr-review.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ── helpers ───────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function test(label, fn) {
  try {
    fn();
    console.log(`  ✅ ${label}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ ${label}`);
    console.error(`     ${err.message}`);
    failed++;
  }
}

async function testAsync(label, fn) {
  try {
    await fn();
    console.log(`  ✅ ${label}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ ${label}`);
    console.error(`     ${err.message}`);
    failed++;
  }
}

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'caicbundle-test-'));
}

// ── imports ───────────────────────────────────────────────────────────────────
const agents = require('../src/agents');
const bob = agents.get('bob');

// ── AC-16 (full): skill SKILL.md content ─────────────────────────────────────

console.log(
  '\n── AC-16: caic-pr-review SKILL.md content ───────────────────────────'
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

test('SKILL.md exists at the expected path', () => {
  assert.ok(fs.existsSync(SKILL_FILE), `SKILL.md not found at ${SKILL_FILE}`);
});

test('SKILL.md name: field equals "caic-pr-review"', () => {
  const content = fs.readFileSync(SKILL_FILE, 'utf8');
  const m = content.match(/^name:\s*(.+)$/m);
  assert.ok(m, 'SKILL.md must have a name: field in frontmatter');
  assert.strictEqual(m[1].trim().replace(/'/g, ''), 'caic-pr-review');
});

test('SKILL.md description: field is non-empty', () => {
  const content = fs.readFileSync(SKILL_FILE, 'utf8');
  const m = content.match(/^description:\s*(.+)$/m);
  assert.ok(m, 'SKILL.md must have a description: field');
  assert.ok(m[1].trim().length > 0, 'description must not be empty');
});

// ── AC-15: Bob bundle skill set ────────────────────────────────────────────────

console.log(
  '\n── AC-15: Bob bundle for caic profile holds exactly carbon-builder + caic-pr-review ──'
);

// Build a minimal carbon-builder stub (the real source is ~/.bob/skills/carbon-builder,
// which may not be present in CI; use a stub with the same structure).
const cbSource = tmp();
const cbRefs = path.join(cbSource, 'refs');
fs.mkdirSync(cbRefs, { recursive: true });
fs.writeFileSync(
  path.join(cbSource, 'SKILL.md'),
  '---\nname: carbon-builder\ndescription: stub\n---\n'
);
fs.writeFileSync(path.join(cbRefs, 'stub.md'), 'stub');

const SKILL_SOURCE = path.join(
  __dirname,
  '..',
  'src',
  'profiles',
  'caic',
  'skills',
  'caic-pr-review'
);
const extraSkills = [{ name: 'caic-pr-review', source: SKILL_SOURCE }];
const rules = '# test rules\n';
const saved = process.env.BOB_API_KEY;
process.env.BOB_API_KEY = 'test-key';

(async () => {
  try {
    const bundleDir = tmp();
    await bob.prepareBundle(bundleDir, {
      rules,
      skillSource: cbSource,
      extraSkills,
    });

    const skillsDir = path.join(bundleDir, '.bob', 'skills');

    await testAsync('skills directory exists', async () => {
      assert.ok(fs.existsSync(skillsDir), '.bob/skills/ must exist');
    });

    await testAsync(
      '.bob/skills/ holds exactly carbon-builder and caic-pr-review',
      async () => {
        const entries = fs.readdirSync(skillsDir).sort();
        assert.deepStrictEqual(
          entries,
          ['carbon-builder', 'caic-pr-review'].sort(),
          `Expected exactly carbon-builder and caic-pr-review; got: ${entries.join(', ')}`
        );
      }
    );

    await testAsync(
      'caic-pr-review SKILL.md is present in bundle',
      async () => {
        const target = path.join(skillsDir, 'caic-pr-review', 'SKILL.md');
        assert.ok(
          fs.existsSync(target),
          'caic-pr-review/SKILL.md not found in bundle'
        );
      }
    );

    await testAsync(
      'caic-pr-review SKILL.md in bundle has name: caic-pr-review',
      async () => {
        const content = fs.readFileSync(
          path.join(skillsDir, 'caic-pr-review', 'SKILL.md'),
          'utf8'
        );
        assert.ok(
          content.includes('name: caic-pr-review'),
          'name field must be caic-pr-review'
        );
      }
    );

    await testAsync('carbon-builder is present in bundle', async () => {
      assert.ok(
        fs.existsSync(path.join(skillsDir, 'carbon-builder', 'SKILL.md')),
        'carbon-builder/SKILL.md not found in bundle'
      );
    });

    await testAsync(
      'profiles.resolve("bob") with REVIEW_PROFILE=caic returns extraSkills with caic-pr-review',
      async () => {
        const saved_rp = process.env.REVIEW_PROFILE;
        process.env.REVIEW_PROFILE = 'caic';
        try {
          const profiles = require('../src/profiles');
          const profile = profiles.resolve('bob');
          assert.strictEqual(profile.id, 'caic');
          assert.ok(Array.isArray(profile.extraSkills));
          assert.strictEqual(profile.extraSkills.length, 1);
          assert.strictEqual(profile.extraSkills[0].name, 'caic-pr-review');
        } finally {
          if (saved_rp === undefined) delete process.env.REVIEW_PROFILE;
          else process.env.REVIEW_PROFILE = saved_rp;
        }
      }
    );
  } finally {
    if (saved === undefined) delete process.env.BOB_API_KEY;
    else process.env.BOB_API_KEY = saved;

    // ── summary ───────────────────────────────────────────────────────────────
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`Passed: ${passed}  Failed: ${failed}`);
    if (failed > 0) process.exit(1);
  }
})();
