/**
 * Phase 0a — Characterization tests (AC-1 to AC-6)
 *
 * These tests run against unmodified code and pin the current behaviour of the
 * core profile as snapshots. A later change that alters a snapshot must include
 * a stated reason in the commit message.
 *
 * Run mode:
 *   UPDATE=1 node tests/characterization.core.test.js   — writes snapshots
 *   node tests/characterization.core.test.js            — asserts against them
 *
 * All tests run with no .env. Environment variables that affect output
 * (GITHUB_AI_AGENT_OWNER, GITHUB_AI_AGENT_REPO) are unset before each call.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ── Stubs that prevent network / disk side effects ───────────────────────────

// Prevent esClient from touching Elasticsearch during bundle build.
require('../src/observability/esClient').esCall = async () => {};

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'characterization');

const UPDATE = process.env.UPDATE === '1';

// ── Helpers ──────────────────────────────────────────────────────────────────

function snapshotPath(name) {
  return path.join(FIXTURE_DIR, name);
}

function readSnapshot(name) {
  return fs.readFileSync(snapshotPath(name), 'utf8');
}

function writeSnapshot(name, content) {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  fs.writeFileSync(snapshotPath(name), content, 'utf8');
}

function assertSnapshot(name, actual) {
  if (UPDATE) {
    writeSnapshot(name, actual);
    console.log(`  📸 snapshot written: ${name}`);
    return;
  }
  const expected = readSnapshot(name);
  assert.strictEqual(
    actual,
    expected,
    `Snapshot mismatch for ${name}. Run with UPDATE=1 to refresh (needs a stated reason).`
  );
}

// ── Test runner ───────────────────────────────────────────────────────────────

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

// ── Source modules (loaded after stubs) ───────────────────────────────────────

const {
  buildReviewPrompt,
  formatSummaryComment,
  formatLooksGoodComment,
  formatNotReviewedComment,
} = require('../src/reviewPrompt');
const { classify } = require('../src/reviewCoverage');
const {
  parseReviewOutput,
  computeRecommendation,
} = require('../src/reviewParser');

// ── Model-output corpus ───────────────────────────────────────────────────────

const CORPUS = [
  {
    name: 'empty-findings',
    input: [
      '[src/index.js:1] — some concern — Category 2 — pending',
      'discarded: no issue',
      'BEGIN_REVIEW_JSON',
      '{"summaryMarkdown":"Looks good.","findings":[]}',
      'END_REVIEW_JSON',
    ].join('\n'),
  },
  {
    name: 'single-major',
    input: [
      '[src/Button.js:10] — missing aria-label — Category 2 — pending',
      'confirmed finding — missing aria-label',
      'BEGIN_REVIEW_JSON',
      JSON.stringify({
        summaryMarkdown: 'One issue.',
        findings: [
          {
            severity: 'major',
            file: 'src/Button.js',
            line: 10,
            title: 'Missing aria-label',
            body: 'Add aria-label.',
            carbonVerified: false,
            verificationSource: 'not-carbon-specific',
          },
        ],
      }),
      'END_REVIEW_JSON',
    ].join('\n'),
  },
  {
    name: 'not-carbon-specific-passes',
    input: [
      '[src/comp.ts:5] — hardcoded cds-- — Category 2 — pending',
      'confirmed finding — hardcoded cds--',
      'BEGIN_REVIEW_JSON',
      JSON.stringify({
        summaryMarkdown: 'Convention issue.',
        findings: [
          {
            severity: 'major',
            file: 'src/comp.ts',
            line: 5,
            title: 'Hardcoded cds-- prefix',
            body: 'Use $prefix.',
            carbonVerified: false,
            verificationSource: 'not-carbon-specific',
          },
        ],
      }),
      'END_REVIEW_JSON',
    ].join('\n'),
  },
  {
    name: 'no-catalogue',
    input: [
      'BEGIN_REVIEW_JSON',
      '{"summaryMarkdown":"No catalogue.","findings":[]}',
      'END_REVIEW_JSON',
    ].join('\n'),
  },
];

// ── classify() corpus ─────────────────────────────────────────────────────────

const CLASSIFY_CORPUS = [
  // Generated (class 2)
  'dist/index.js',
  'es/button/index.js',
  'lib/utils.js',
  '__snapshots__/button.snap',
  'src/button.snap',
  'src/button.min.js',
  'src/button.min.css',
  'src/button.map',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  // Support (class 1)
  '__tests__/button.test.js',
  '__testfixtures__/input.md',
  'src/button.test.js',
  'src/button.spec.js',
  'src/button-test.js',
  'src/button.stories.js',
  'src/README.md',
  'docs/guide.txt',
  'src/notes.rst',
  'src/CHANGELOG.mdx',
  // Source (class 0)
  'src/button.js',
  'src/components/Modal.tsx',
  'packages/react/src/index.ts',
  'src/styles.scss',
  'src/figma.config.ts',
  'src/api/server.js',
  'package.json',
  // Edge: snapshot under __tests__ — generated wins (class 2)
  '__tests__/button.snap',
];

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const COMMIT = 'abc1234def56';

  // ── AC-1: Core prompt ───────────────────────────────────────────────────────
  console.log(
    '\n── AC-1: core prompt ──────────────────────────────────────────'
  );

  await test('buildReviewPrompt (bob) produces the pinned snapshot', () => {
    const prompt = buildReviewPrompt({
      owner: 'carbon-design-system',
      repo: 'carbon',
      agent: 'bob',
    });
    assertSnapshot('core-prompt-bob.md', prompt);
  });

  await test('buildReviewPrompt (claude) produces the pinned snapshot', () => {
    const prompt = buildReviewPrompt({
      owner: 'carbon-design-system',
      repo: 'carbon',
      agent: 'claude',
    });
    assertSnapshot('core-prompt-claude.md', prompt);
  });

  // ── AC-2: Bob bundle file set ───────────────────────────────────────────────
  console.log(
    '\n── AC-2: Bob bundle file set ──────────────────────────────────'
  );

  await test('Bob bundle holds carbon-builder and the rules file', async () => {
    const skillSource = path.join(
      __dirname,
      '..',
      '.bob',
      'skills',
      'carbon-builder'
    );
    if (!fs.existsSync(skillSource)) {
      console.log('    ⚠️  carbon-builder skill not present — skipping');
      return;
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'char-bob-'));
    try {
      const bob = require('../src/agents/bob');
      const savedKey = process.env.BOB_API_KEY;
      process.env.BOB_API_KEY = 'test-key';
      try {
        await bob.prepareBundle(tmpDir, { rules: '# rules\n', skillSource });
      } finally {
        if (savedKey === undefined) delete process.env.BOB_API_KEY;
        else process.env.BOB_API_KEY = savedKey;
      }

      function walk(dir, base, out = []) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full, base, out);
          else out.push(path.relative(base, full));
        }
        return out.sort();
      }

      const publicFiles = walk(tmpDir, tmpDir).filter((f) => f !== '.env');
      assertSnapshot(
        'bob-bundle-files.json',
        JSON.stringify(publicFiles, null, 2)
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ── AC-3: Parser corpus ─────────────────────────────────────────────────────
  console.log(
    '\n── AC-3: parser corpus ────────────────────────────────────────'
  );

  for (const { name, input } of CORPUS) {
    await test(`parser snapshot: ${name}`, () => {
      const result = parseReviewOutput(input);
      assertSnapshot(`parser-${name}.json`, JSON.stringify(result, null, 2));
    });
  }

  await test('computeRecommendation grid snapshot', () => {
    const grid = [];
    for (const blocking of [0, 1]) {
      for (const major of [0, 1, 2]) {
        for (const minor of [0, 1]) {
          for (const nit of [0, 1]) {
            const findings = [
              ...Array(blocking).fill({ severity: 'blocking' }),
              ...Array(major).fill({ severity: 'major' }),
              ...Array(minor).fill({ severity: 'minor' }),
              ...Array(nit).fill({ severity: 'nit' }),
            ];
            const { recommendation } = computeRecommendation(findings, {
              hasCatalogue: true,
            });
            grid.push({ blocking, major, minor, nit, recommendation });
          }
        }
      }
    }
    assertSnapshot('recommendation-grid.json', JSON.stringify(grid, null, 2));
  });

  // ── AC-4: Comment text ──────────────────────────────────────────────────────
  console.log(
    '\n── AC-4: comment text ─────────────────────────────────────────'
  );

  const baseSummary = {
    agent: 'bob',
    agentName: 'IBM Bob',
    summaryMarkdown: 'Everything looks good.',
    prNumber: 42,
    commitSha: COMMIT,
    recommendation: 'looks-good',
    recommendationRationale: 'No issues found.',
  };

  await test('formatSummaryComment (looks-good) snapshot', () => {
    assertSnapshot('summary-looks-good.md', formatSummaryComment(baseSummary));
  });

  await test('formatSummaryComment header is [AI agent review \u2014 Carbon grounded]', () => {
    const text = formatSummaryComment(baseSummary);
    assert.ok(
      text.startsWith('[AI agent review \u2014 Carbon grounded]'),
      `Header mismatch. Got: ${text.substring(0, 80)}`
    );
  });

  await test('formatSummaryComment includes "Carbon verification:" line', () => {
    const text = formatSummaryComment(baseSummary);
    assert.ok(
      text.includes('Carbon verification:'),
      'Expected "Carbon verification:" line'
    );
  });

  await test('formatLooksGoodComment snapshot', () => {
    const text = formatLooksGoodComment({
      agent: 'bob',
      agentName: 'IBM Bob',
      summaryMarkdown: 'Clean PR.',
      commitSha: COMMIT,
    });
    assertSnapshot('looks-good-comment.md', text);
  });

  await test('formatLooksGoodComment header is [AI agent review \u2014 Carbon grounded]', () => {
    const text = formatLooksGoodComment({
      agent: 'bob',
      agentName: 'IBM Bob',
      summaryMarkdown: 'Clean PR.',
      commitSha: COMMIT,
    });
    assert.ok(
      text.startsWith('[AI agent review \u2014 Carbon grounded]'),
      `Header mismatch. Got: ${text.substring(0, 80)}`
    );
  });

  await test('formatNotReviewedComment snapshot', () => {
    const coverage = {
      files_total: 5,
      files_reviewed: 0,
      files_omitted: 5,
      diff_chars_total: 1000,
      diff_chars_reviewed: 0,
      partial: true,
      beyond_listing: 0,
      omitted: [{ filename: 'big.js', reason: 'over-budget' }],
    };
    const text = formatNotReviewedComment({
      commitSha: COMMIT,
      coverage,
      filesUrl: 'https://github.com/o/r/pull/1/files',
    });
    assertSnapshot('not-reviewed-comment.md', text);
  });

  await test('formatNotReviewedComment header is [AI agent review \u2014 Carbon grounded]', () => {
    const coverage = {
      files_total: 1,
      files_reviewed: 0,
      files_omitted: 1,
      diff_chars_total: 100,
      diff_chars_reviewed: 0,
      partial: true,
      beyond_listing: 0,
      omitted: [],
    };
    const text = formatNotReviewedComment({
      commitSha: COMMIT,
      coverage,
      filesUrl: 'https://github.com/o/r/pull/1/files',
    });
    assert.ok(
      text.startsWith('[AI agent review \u2014 Carbon grounded]'),
      `Header mismatch. Got: ${text.substring(0, 80)}`
    );
  });

  // ── AC-5: ES name literals ──────────────────────────────────────────────────
  console.log(
    '\n── AC-5: Elasticsearch name literals ──────────────────────────'
  );

  await test('hardcoded ES name literals match the pinned snapshot', () => {
    // These are the literal strings that Task 5 must produce when ES_INDEX_PREFIX is empty.
    const literals = {
      'eventService.js currentIndex prefix': 'carbon-monitor-events-',
      'spend.js EVENTS_INDEX': 'carbon-monitor-events-*',
      'server.js CREDIT_EVENTS_INDEX': 'carbon-monitor-events-*',
      'scheduleManager.js ES_INDEX': 'carbon-monitor-schedule',
      'scheduleManager.js ES_DOC_ID': 'singleton',
      'mcpConnection.js MCP_STATE_INDEX default': 'carbon-monitor-mcp-state',
      'mcpConnection.js MCP_STATE_DOC_ID default': 'connection',
      'init-index.js ALIAS': 'carbon-monitor-events',
      'init-index.js TEMPLATE': 'carbon-monitor-events-template',
      'init-index.js ILM_NAME': 'carbon-monitor-events-ilm',
    };
    assertSnapshot('es-name-literals.json', JSON.stringify(literals, null, 2));
  });

  // ── AC-6: classify() corpus ─────────────────────────────────────────────────
  console.log(
    '\n── AC-6: classify() corpus ────────────────────────────────────'
  );

  await test('classify() corpus matches pinned snapshot', () => {
    const results = CLASSIFY_CORPUS.map((f) => ({
      file: f,
      class: classify(f),
    }));
    assertSnapshot('classify-corpus.json', JSON.stringify(results, null, 2));
  });

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(60)}`);
  if (UPDATE) {
    console.log(`📸 Snapshots written to ${FIXTURE_DIR}`);
  }
  console.log(`Passed: ${passed}  Failed: ${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
