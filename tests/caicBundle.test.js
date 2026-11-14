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

// ── Rubric: severity mapping, finding shape and Not verified ─────────────────

console.log(
  '\n── Rubric: the skill and the caic prompt agree; core is untouched ─────'
);

const { buildCaicPrompt } = require('../src/profiles/caic/prompt');
const { buildReviewPrompt } = require('../src/reviewPrompt');

const skillText = fs.readFileSync(SKILL_FILE, 'utf8');
const caicPrompt = buildCaicPrompt({ owner: 'o', repo: 'r', agent: 'bob' });
const corePrompt = buildReviewPrompt({ owner: 'o', repo: 'r', agent: 'bob' });

// The text from a heading to the next heading of the same or a higher level.
function sectionOf(text, heading) {
  const start = text.indexOf(heading);
  assert.ok(start !== -1, `heading not found: ${heading}`);
  const rest = text.slice(start + heading.length);
  const end = rest.search(/\n(?:## |---\n)/);
  return end === -1 ? rest : rest.slice(0, end);
}

// A bullet that Prettier or the author wrapped is one bullet.
function bulletsOf(text) {
  return text
    .replace(/\n[ \t]+(?=\S)/g, ' ')
    .split('\n')
    .filter((l) => l.startsWith('- '))
    .map((l) => l.trim());
}

const MAPPING_BULLETS = bulletsOf(sectionOf(skillText, '## Severity'));

test('SKILL.md Severity section maps Blocker, Important, minor and Nit once', () => {
  assert.strictEqual(MAPPING_BULLETS.length, 6, MAPPING_BULLETS.join('\n'));
  const joined = MAPPING_BULLETS.join('\n');
  for (const pair of [
    '**Blocker** → `blocking`',
    '**Important** → `major`',
    '→ `minor`. A maintainability risk with evidence of functional impact',
    '**Nit** → `nit`',
  ]) {
    assert.ok(joined.includes(pair), `missing "${pair}"`);
  }
  assert.ok(joined.includes('If nobody pays, it is not a finding'));
  assert.ok(
    joined.includes(
      'A convention break costs what its consequence costs. It is not a Blocker by default.'
    )
  );
  assert.ok(joined.includes('never posted inline'), 'nits are never inline');
});

test('the caic prompt carries every severity mapping line from the skill word for word', () => {
  for (const line of MAPPING_BULLETS) {
    assert.ok(caicPrompt.includes(line), `prompt is missing: ${line}`);
  }
});

test('the rules ledger and docs/REVIEW_OUTPUT.md state the same mapping', () => {
  const ledger = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'profiles', 'caic', 'RULES-LEDGER.md'),
    'utf8'
  );
  const rows = [...ledger.matchAll(/^\| V\d +\| (.+?) +\|/gm)].map((m) => m[1]);
  assert.strictEqual(rows.length, MAPPING_BULLETS.length);
  MAPPING_BULLETS.forEach((bullet, i) => {
    assert.ok(rows[i].startsWith(bullet.slice(2)), `ledger V${i + 1}`);
  });
  const doc = fs.readFileSync(
    path.join(__dirname, '..', 'docs', 'REVIEW_OUTPUT.md'),
    'utf8'
  );
  for (const row of [
    /^\| Blocker +\| `blocking` +\|/m,
    /^\| Important +\| `major` +\|/m,
    /^\| \(none\) +\| `minor` +\| A maintainability risk with evidence of functional impact/m,
    /^\| Nit +\| `nit` +\|/m,
  ]) {
    assert.ok(row.test(doc), `docs/REVIEW_OUTPUT.md lacks ${row}`);
  }
});

test('the finding shape is required for minor and above, in both files', () => {
  assert.ok(
    skillText.includes(
      'A `minor`-or-above finding body reads in this order, on one line:'
    )
  );
  assert.ok(
    caicPrompt.includes(
      'For `minor`, `major`, or `blocking` findings, the body reads in this order, on one line:'
    )
  );
});

test('L2 is Important in both files: a convention break with no named consequence', () => {
  assert.ok(skillText.includes('**L2 (Important):**'));
  assert.ok(caicPrompt.includes('**L2 (Important → major):**'));
  assert.ok(!/L2 \(Blocker/.test(skillText + caicPrompt));
});

test('neither file still says minor is unused, or grades size and weakened proofs as flat Blockers', () => {
  for (const [name, text] of [
    ['SKILL.md', skillText],
    ['prompt', caicPrompt],
  ]) {
    assert.ok(!/minor.{0,20}is not used/.test(text), `${name}: minor unused`);
    assert.ok(!/> 400: Blocker/.test(text), `${name}: size Blocker`);
  }
});

const ORIENTATION_LABELS = [
  '**What this block does:**',
  '**Context:**',
  '**What this test is for:**',
  '**Why this line matters:**',
];

test('SKILL.md and the caic prompt both carry the four orientation labels and the order', () => {
  for (const label of ORIENTATION_LABELS) {
    assert.ok(skillText.includes(label), `SKILL.md missing ${label}`);
    assert.ok(caicPrompt.includes(label), `prompt missing ${label}`);
  }
  assert.ok(/Orient.*Diagnose.*Cost.*Fix/s.test(skillText));
  assert.ok(
    /Orientation.*What is wrong.*What it costs.*The fix/s.test(caicPrompt)
  );
});

test('SKILL.md and the caic prompt both carry the Not verified rule', () => {
  assert.ok(skillText.includes('`Not verified: <path or behavior>`'));
  assert.ok(caicPrompt.includes('`Not verified: <path or behavior>`'));
  assert.ok(caicPrompt.includes('never write "Not verified: nothing"'));
});

test('core prompt has none of the caic rubric', () => {
  for (const needle of [
    ...ORIENTATION_LABELS,
    'Not verified',
    'costs if it merges as written',
    'If nobody pays',
    'Blocker** → `blocking`',
  ]) {
    assert.ok(!corePrompt.includes(needle), `core prompt contains: ${needle}`);
  }
});

test('the caic prompt carries the fix field rule and drops the finding count', () => {
  assert.ok(
    caicPrompt.includes(
      "Write a surgical fix that is the smallest change that resolves the finding, at the lines quoted. Don't make unecesseary changes, or add prose."
    )
  );
  assert.ok(
    caicPrompt.includes(
      'Do not state how many findings there are or list them by severity; the harness renders that.'
    )
  );
  assert.ok(caicPrompt.includes('"fix": ['));
  assert.ok(caicPrompt.includes('each `fix` line included'));
  assert.ok(caicPrompt.includes('no recommendations, no finding counts;'));
  assert.ok(!caicPrompt.includes('count and severity of findings'));
  // The fix rule sits after the caic body rule it refers back to
  assert.ok(
    caicPrompt.indexOf('**body field rule:**') <
      caicPrompt.indexOf('**fix field rule:**')
  );
});

test('every profile prompt carries the shared output contract verbatim', () => {
  const { SHARED_OUTPUT_CONTRACT } = require('../src/promptContract');
  const profiles = require('../src/profiles');
  const prompts = [
    ['core (bob)', buildReviewPrompt({ owner: 'o', repo: 'r', agent: 'bob' })],
    [
      'core (claude)',
      buildReviewPrompt({ owner: 'o', repo: 'r', agent: 'claude' }),
    ],
  ];
  for (const profile of new Set(Object.values(profiles.BY_REPO))) {
    prompts.push([
      profile.id,
      buildReviewPrompt({ owner: 'o', repo: 'r', agent: 'bob', profile }),
    ]);
  }
  assert.ok(
    prompts.some(([id]) => id === 'caic'),
    'caic was not checked'
  );
  for (const [id, prompt] of prompts) {
    for (const [key, text] of Object.entries(SHARED_OUTPUT_CONTRACT)) {
      assert.ok(prompt.includes(text), `${id} prompt is missing ${key}`);
    }
  }
});

test('X rules: the telemetry rule appears once, and X1 to X12 run without a gap', () => {
  const x = sectionOf(skillText, '## What is NOT a finding (X rules)');
  const ids = [...x.matchAll(/- \*\*X(\d+)\*\*/g)].map((m) => Number(m[1]));
  assert.deepStrictEqual(
    ids,
    Array.from({ length: 12 }, (_, i) => i + 1)
  );
  const rules = x.split('\n- **X').filter((r) => r.includes('telemetry.yml'));
  assert.strictEqual(rules.length, 1, 'X1 and the old X6 are one rule');
});

test('X5: a claim that depends on Carbon behaviour is Cat 1 whatever its wording, and is discarded, not relabelled, without evidence', () => {
  const flat = (s) => s.replace(/\s+/g, ' ');
  const x = sectionOf(skillText, '## What is NOT a finding (X rules)');
  const x5 = flat(x.split('\n- **X').find((r) => r.startsWith('5**')) || '');
  assert.ok(x5, 'X5 present');
  const prompt = flat(caicPrompt);
  for (const phrase of [
    'what the claim depends on, not how it is worded',
    'what a slot renders as',
    'never file it one level down',
    'not indexed in MCP',
  ]) {
    assert.ok(x5.includes(phrase), `X5 says: ${phrase}`);
    assert.ok(prompt.includes(phrase), `prompt says: ${phrase}`);
  }
  assert.ok(x5.includes('never relabel it Cat 2'));
  assert.ok(prompt.includes('Never relabel it Category 2'));
  // The category test itself carries the rule, next to the two definitions.
  assert.ok(
    prompt.includes(
      'a rendering, layout or behaviour concern that is only true if a Carbon element works a certain way is Category 1'
    )
  );
  // An unreachable MCP omits the Cat 1 finding; the old wording kept it on model memory.
  assert.ok(!prompt.includes('used model memory'));
  assert.ok(prompt.includes('omit it and note in summaryMarkdown'));
});

test('the refute rule files an unconfirmed Blocker one level down', () => {
  const w = sectionOf(skillText, '## Section W — Finding wording');
  assert.ok(/refute/i.test(w));
  assert.ok(w.includes('file it as Important'));
  assert.ok(w.includes('what you did not read'));
  assert.ok(caicPrompt.includes('file it as Important'));
});

test('three checklists, each under ten lines, and the prompt carries them', () => {
  const e = sectionOf(skillText, '## Section E — Checklists by file type');
  const parts = e.split(/\n\*\*(?=Code changes|Tests|Docs and text)/);
  assert.strictEqual(parts.length, 4, 'intro plus three checklists');
  for (const part of parts.slice(1)) {
    const bullets = bulletsOf(part);
    assert.ok(bullets.length > 0 && bullets.length < 10, part.slice(0, 20));
    for (const b of bullets) {
      assert.ok(caicPrompt.includes(b), `prompt is missing: ${b}`);
    }
  }
  assert.ok(caicPrompt.includes('Checklists by file type'));
});

test('large diffs: the skill ranks files by risk, and size stays a finding under Z', () => {
  const r = sectionOf(skillText, '## Section R — Large diffs');
  assert.ok(/rank the files by risk/i.test(r));
  assert.ok(r.includes('Every file still gets its catalogue line'));
  const z = sectionOf(skillText, '## Section Z — PR size (Cat 2, Important)');
  assert.ok(z.includes('**Size is a finding.**'));
  assert.ok(caicPrompt.includes('rank the files by risk per line'));
  assert.ok(caicPrompt.includes('Size is a finding'));
});

test('dependencies are P1, so Z1 is only the size rule', () => {
  assert.ok(skillText.includes('**P1 (Important):**'));
  assert.ok(!skillText.includes('**Z1 (Important)'));
  assert.ok(caicPrompt.includes('**P1 (Important'));
  assert.ok(!caicPrompt.includes('**Z1 (Important'));
});

test('no file points at a spec this branch does not carry', () => {
  assert.ok(!skillText.includes('specs/'));
  assert.ok(!caicPrompt.includes('specs/'));
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
      'profiles.forRepo("carbon-ai-chat") returns extraSkills with caic-pr-review',
      async () => {
        const profiles = require('../src/profiles');
        const profile = profiles.forRepo('carbon-ai-chat');
        assert.strictEqual(profile.id, 'caic');
        assert.ok(Array.isArray(profile.extraSkills));
        assert.strictEqual(profile.extraSkills.length, 1);
        assert.strictEqual(profile.extraSkills[0].name, 'caic-pr-review');
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
