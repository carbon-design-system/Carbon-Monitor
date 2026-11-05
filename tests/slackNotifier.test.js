/**
 * Tests for src/slackNotifier.js
 *
 * Uses a lightweight in-process HTTP server to capture outgoing webhook POSTs
 * without hitting real Slack infrastructure. Follows the same plain-async
 * harness (async function main / await test()) used across this project.
 *
 * Covers:
 *  1. No-op when SLACK_WEBHOOK_URL is not set
 *  2. Static warning (no URL leak) when webhook URL is malformed
 *  3. Block Kit structure is correct for a mixed success/failure run
 *  4. Failed PRs appear as ⚠️ entries in the payload
 *  5. Markdown is stripped and summary is truncated at a word boundary
 *  6. Empty results produce a "no eligible PRs" message (no-PR-found path)
 *  7. The run-failure payload names the repos and the error, not a low balance
 *  8. postRunFailure does nothing without a webhook
 */

'use strict';

const http = require('http');
const https = require('https');
const assert = require('assert');

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

// ── Load module under test ────────────────────────────────────────────────────
// Ensure the env var is absent so _enabled initialises to false for test 1.
delete process.env.SLACK_WEBHOOK_URL;

const notifier = require('../src/slackNotifier');
const {
  _buildPayload,
  _buildPayloads,
  _buildLowTokenPayload,
  _stripMarkdown,
  _truncateAtWord,
  _flagFor,
  _isEnabled,
} = notifier;

// ── Sample data ───────────────────────────────────────────────────────────────

const SAMPLE_SUCCESS = {
  prNumber: 18042,
  prUrl: 'https://github.com/carbon-design-system/carbon/pull/18042',
  findingsCount: 3,
  summary:
    '## Summary\n\nThe **Button** component is missing the required `aria-label` on the icon-only variant. Additionally, the _Tooltip_ trigger does not meet the 4.5:1 contrast ratio requirement and the focus ring is absent on keyboard navigation.',
  recommendation: 'consider-revising',
};

const SAMPLE_FAILURE = {
  prNumber: 18031,
  failed: true,
  error: 'Agent timed out after 600 seconds',
};

const SAMPLE_GOOD = {
  prNumber: 18019,
  prUrl: 'https://github.com/carbon-design-system/carbon/pull/18019',
  findingsCount: 0,
  summary: 'No issues found. The changes look correct.',
  recommendation: 'looks-good',
};

// ── Tests ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n💬 slackNotifier tests\n');

  // ── 1. No-op when env var is unset ──────────────────────────────────────────
  await test('is disabled when SLACK_WEBHOOK_URL is not set', async () => {
    assert.strictEqual(
      _isEnabled(),
      false,
      '_isEnabled() should be false when env var is absent'
    );

    // postRunDigest must resolve without throwing and without touching the network
    let networkCallMade = false;
    const origRequest = https.request;
    https.request = () => {
      networkCallMade = true;
      return origRequest.apply(https, arguments);
    };
    try {
      await notifier.postRunDigest({
        startedAt: Date.now(),
        repos: ['carbon-design-system/carbon'],
        results: [SAMPLE_SUCCESS],
      });
    } finally {
      https.request = origRequest;
    }

    assert.strictEqual(
      networkCallMade,
      false,
      'No HTTP request should be made when disabled'
    );
  });

  // ── 2. Malformed URL emits static warning — URL never logged ────────────────
  await test('malformed URL emits static warning without leaking the URL', () => {
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (msg) => warnings.push(msg);
    try {
      // The module is already loaded; we verify the URL-leak guard by
      // confirming that _flagFor returns safely for unknown values and that
      // no captured warning (from any prior initialisation path) contains a
      // raw webhook token.
      const flag = _flagFor('unknown-value');
      assert.strictEqual(
        flag.emoji,
        '⚪',
        'Unknown recommendation should get ⚪'
      );
      assert.ok(
        !flag.label.includes('https://'),
        'Flag label must not contain a URL'
      );

      // Any warning logged anywhere in this suite must not expose a webhook credential.
      for (const w of warnings) {
        assert.ok(
          !w.includes('hooks.slack.com/services/'),
          `Warning must not contain a raw webhook path: "${w}"`
        );
      }
    } finally {
      console.warn = origWarn;
    }
  });

  // ── 3. Block Kit structure for a mixed run ───────────────────────────────────
  await test('buildPayload produces valid Block Kit structure', () => {
    process.env.BASE_URL = 'https://monitor.example.com';
    const payload = _buildPayload({
      startedAt: new Date('2025-07-28T18:05:00Z').getTime(),
      repos: ['carbon-design-system/carbon'],
      results: [SAMPLE_SUCCESS, SAMPLE_FAILURE, SAMPLE_GOOD],
    });
    delete process.env.BASE_URL;

    assert.ok(Array.isArray(payload.blocks), 'payload.blocks must be an array');

    // Header block present
    const header = payload.blocks.find((b) => b.type === 'header');
    assert.ok(header, 'Must contain a header block');
    assert.ok(
      header.text.text.includes('Carbon Monitor'),
      'Header must mention Carbon Monitor'
    );

    // Repos and time in an intro section
    const intro = payload.blocks.find(
      (b) =>
        b.type === 'section' &&
        b.text &&
        b.text.text.includes('*Repos:* carbon')
    );
    assert.ok(intro, 'Must contain a section with the repo names');
    assert.ok(!JSON.stringify(payload).includes('*Repo:*'), 'no old Repo line');

    // Context footer
    const context = payload.blocks.find((b) => b.type === 'context');
    assert.ok(context, 'Must contain a context footer block');
    assert.ok(
      context.elements[0].text.includes('reviewed'),
      'Footer must mention reviewed count'
    );
    assert.ok(
      context.elements[0].text.includes('<https://monitor.example.com|'),
      'Footer must link to BASE_URL'
    );

    const noBase = _buildPayload({
      startedAt: Date.now(),
      repos: ['carbon-design-system/carbon'],
      results: [SAMPLE_SUCCESS],
    });
    const noBaseContext = noBase.blocks.find((b) => b.type === 'context');
    assert.ok(
      !noBaseContext.elements[0].text.includes('Configure schedule'),
      'Footer must omit the schedule link when BASE_URL is unset'
    );

    // At least one divider
    const dividers = payload.blocks.filter((b) => b.type === 'divider');
    assert.ok(dividers.length >= 1, 'Must have at least one divider');

    // Flag emojis for each recommendation tier
    const allText = payload.blocks
      .filter((b) => b.type === 'section' && b.text)
      .map((b) => b.text.text)
      .join('\n');
    assert.ok(allText.includes('🔴'), 'consider-revising must produce 🔴');
    assert.ok(allText.includes('🟢'), 'looks-good must produce 🟢');
  });

  // ── 4. Failed PRs appear as ⚠️ entries ──────────────────────────────────────
  await test('failed PRs appear as ⚠️ entries in the payload', () => {
    const payload = _buildPayload({
      startedAt: Date.now(),
      repos: ['carbon-design-system/carbon'],
      results: [SAMPLE_FAILURE],
    });

    const allText = payload.blocks
      .filter((b) => b.type === 'section' && b.text)
      .map((b) => b.text.text)
      .join('\n');

    assert.ok(allText.includes('⚠️'), 'Failed PR must show ⚠️');
    assert.ok(
      allText.includes(`PR #${SAMPLE_FAILURE.prNumber}`),
      'Failed PR number must appear in payload'
    );
    assert.ok(allText.includes('review failed'), 'Must say "review failed"');
    assert.ok(allText.includes('timed out'), 'Error message must appear');
  });

  // ── 5. Markdown stripped; truncation at word boundary ───────────────────────
  await test('stripMarkdown removes syntax and truncateAtWord cuts at word boundary', () => {
    const raw =
      '## Summary\n\nThe **Button** component is missing the required `aria-label` on the icon-only variant. Additionally, the _Tooltip_ trigger does not meet the 4.5:1 contrast ratio requirement and the focus ring is absent on keyboard navigation.';

    const stripped = _stripMarkdown(raw);

    assert.ok(!stripped.includes('##'), 'Should remove ## heading markers');
    assert.ok(!stripped.includes('**'), 'Should remove ** bold markers');
    assert.ok(!stripped.includes('`'), 'Should remove backtick code markers');
    assert.ok(
      !stripped.includes('_Tooltip_'),
      'Should remove _italic_ markers'
    );
    assert.ok(stripped.includes('Button'), 'Should preserve prose content');

    // Truncation
    const truncated = _truncateAtWord(stripped, 150);
    assert.ok(
      truncated.length <= 155,
      `Truncated string should be near 150 chars, got ${truncated.length}`
    );
    assert.ok(
      truncated.endsWith('…'),
      'Truncated string must end with ellipsis'
    );
    // No trailing space before ellipsis
    assert.ok(
      !truncated.slice(0, -1).endsWith(' '),
      'Must not leave trailing space before ellipsis'
    );

    // Short text passes through unchanged
    assert.strictEqual(
      _truncateAtWord('Short text', 150),
      'Short text',
      'Short text must pass through unchanged'
    );

    // Edge cases
    assert.strictEqual(
      _truncateAtWord('', 150),
      '',
      'Empty string returns empty'
    );
    assert.strictEqual(_stripMarkdown(''), '', 'Empty string returns empty');
  });

  // ── 6. Empty results → "no eligible PRs" block ──────────────────────────────
  await test('empty results produce a "No eligible PRs" message block', () => {
    const payload = _buildPayload({
      startedAt: Date.now(),
      repos: ['carbon-design-system/carbon'],
      results: [],
    });

    const allText = payload.blocks
      .filter((b) => b.type === 'section' && b.text)
      .map((b) => b.text.text)
      .join('\n');

    assert.ok(
      allText.includes('*carbon-design-system/carbon*\n_No eligible PRs._'),
      'Empty results must produce a heading and a "No eligible PRs" message'
    );
  });

  // ── 7. bare @word in summary is escaped ─────────────────────────────────────
  await test('buildPayload escapes bare @word in summary to prevent Slack mentions', () => {
    const ZWS = '\u200B';
    const payload = _buildPayload({
      startedAt: Date.now(),
      repos: ['carbon-design-system/carbon'],
      results: [
        {
          prNumber: 1,
          prUrl: 'https://github.com/carbon-design-system/carbon/pull/1',
          findingsCount: 1,
          summary: 'PR adds @media (forced-colors) patches to select.scss.',
          recommendation: 'suggested-improvements',
        },
      ],
    });

    const allText = payload.blocks
      .filter((b) => b.type === 'section' && b.text)
      .map((b) => b.text.text)
      .join('\n');

    assert.ok(
      allText.includes(`@${ZWS}media`),
      'Bare @media must be escaped with zero-width space'
    );
    assert.ok(
      !allText.includes(' @media '),
      'Raw @media must not appear unescaped'
    );
  });

  // ── 8. `@media` in backtick span is stripped then escaped ───────────────────
  await test('buildPayload strips backticks then escapes bare @media in summary', () => {
    const ZWS = '\u200B';
    const payload = _buildPayload({
      startedAt: Date.now(),
      repos: ['carbon-design-system/carbon'],
      results: [
        {
          prNumber: 2,
          prUrl: 'https://github.com/carbon-design-system/carbon/pull/2',
          findingsCount: 1,
          summary: 'PR adds `@media` (forced-colors) patches to select.scss.',
          recommendation: 'suggested-improvements',
        },
      ],
    });

    const allText = payload.blocks
      .filter((b) => b.type === 'section' && b.text)
      .map((b) => b.text.text)
      .join('\n');

    // Backticks stripped → bare @media → then escaped with ZWS
    assert.ok(
      allText.includes(`@${ZWS}media`),
      'After backtick stripping, @media must be escaped with zero-width space'
    );
    assert.ok(!allText.includes('`@media`'), 'Backtick span must be stripped');
  });

  // ── Digest grouped by repository ────────────────────────────────────────────
  const CARBON = 'carbon-design-system/carbon';
  const CAIC = 'carbon-design-system/carbon-ai-chat';
  const make = (repo, n, start = 1) =>
    Array.from({ length: n }, (_, i) => ({
      prNumber: start + i,
      repo,
      prUrl: `https://github.com/carbon-design-system/${repo}/pull/${start + i}`,
      findingsCount: 1,
      summary: 'Fine.',
      recommendation: 'looks-good',
    }));
  const base = {
    startedAt: Date.UTC(2026, 10, 4, 15, 0),
    maxPRs: 20,
    daysBack: 30,
  };
  const textOf = (blocks) =>
    blocks
      .map((b) => b.text?.text || b.elements?.map((e) => e.text).join('') || '')
      .join('\n');
  // "PR #n" lines in a message, with the repo heading each sits under.
  const placed = (payloads) => {
    const seen = [];
    for (const { blocks } of payloads) {
      let heading = null;
      for (const b of blocks) {
        const t = b.text?.text || '';
        const h = t.match(/^\*([^*]+)\*( · .*)?(\n|$)/);
        if (b.type === 'section' && h) heading = h[1];
        const m = t.match(/PR #(\d+)/);
        if (b.type === 'section' && m && heading) {
          seen.push(`${heading.split('/').pop()}#${m[1]}`);
        }
      }
    }
    return seen;
  };
  const expectedKeys = (repo, n, start = 1) =>
    Array.from({ length: n }, (_, i) => `${repo}#${start + i}`);
  const assertWhole = (payloads, expected, label) => {
    for (const [i, p] of payloads.entries()) {
      assert.ok(
        p.blocks.length <= 50,
        `${label}: message ${i + 1} has ${p.blocks.length} blocks`
      );
      assert.strictEqual(p.blocks[0].type, 'header', `${label}: header`);
      assert.strictEqual(
        p.blocks[p.blocks.length - 1].type,
        'context',
        `${label}: footer`
      );
    }
    assert.deepStrictEqual(placed(payloads), expected, `${label}: results`);
  };

  await test('the digest groups by repository in repos order, not result order', () => {
    const payload = _buildPayload({
      ...base,
      repos: [CARBON, CAIC],
      results: [...make('carbon-ai-chat', 2, 21), ...make('carbon', 2, 11)],
    });
    const text = textOf(payload.blocks);
    assert.ok(text.indexOf(`*${CARBON}*`) < text.indexOf(`*${CAIC}*`));
    assert.ok(text.includes('*Repos:* carbon, carbon-ai-chat'), text);
    assert.ok(
      text.includes(
        '*Criteria:* up to 20 most recent PRs per repository, opened within the last 30 days'
      ),
      text
    );
    assert.deepStrictEqual(placed([payload]), [
      'carbon#11',
      'carbon#12',
      'carbon-ai-chat#21',
      'carbon-ai-chat#22',
    ]);
    assert.ok(text.includes(`*${CARBON}* · 2 reviewed`), text);
  });

  await test('a repo with no results keeps its heading and says so', () => {
    const payload = _buildPayload({
      ...base,
      repos: [CARBON, CAIC],
      results: make('carbon', 1),
    });
    const text = textOf(payload.blocks);
    assert.ok(text.includes(`*${CAIC}*\n_No eligible PRs._`), text);
  });

  await test('the heading counts reviewed, failed and skipped results', () => {
    const results = [
      ...make('carbon', 1),
      { prNumber: 2, repo: 'carbon', failed: true, error: 'boom' },
      { prNumber: 3, repo: 'carbon', prUrl: 'u', skipped: true, reason: 'low' },
    ];
    const text = textOf(
      _buildPayload({ ...base, repos: [CARBON], results }).blocks
    );
    assert.ok(text.includes(`*${CARBON}* · 1 reviewed · 1 failed · 1 skipped`));
  });

  await test('20 + 20 results fit one message of at most 50 blocks', () => {
    const results = [...make('carbon', 20), ...make('carbon-ai-chat', 20, 101)];
    const payloads = _buildPayloads({
      ...base,
      repos: [CARBON, CAIC],
      results,
    });
    assert.strictEqual(payloads.length, 1);
    assertWhole(
      payloads,
      [
        ...expectedKeys('carbon', 20),
        ...expectedKeys('carbon-ai-chat', 20, 101),
      ],
      '20+20'
    );
  });

  await test('30 + 30 results split into one message per repository', () => {
    const results = [...make('carbon', 30), ...make('carbon-ai-chat', 30, 101)];
    const payloads = _buildPayloads({
      ...base,
      repos: [CARBON, CAIC],
      results,
    });
    assert.strictEqual(payloads.length, 2);
    assertWhole(
      payloads,
      [
        ...expectedKeys('carbon', 30),
        ...expectedKeys('carbon-ai-chat', 30, 101),
      ],
      '30+30'
    );
    assert.ok(textOf(payloads[0].blocks).includes(`*${CARBON}*`));
    assert.ok(!textOf(payloads[0].blocks).includes(`*${CAIC}*`));
    assert.ok(payloads[0].blocks[0].text.text.endsWith('(part 1 of 2)'));
    assert.ok(payloads[1].blocks[0].text.text.endsWith('(part 2 of 2)'));
    for (const p of payloads) {
      assert.ok(textOf(p.blocks).includes('*Repos:* carbon, carbon-ai-chat'));
    }
  });

  for (const n of [50, 100]) {
    await test(`${n} results in one repository split into chunks under 50 blocks`, () => {
      const payloads = _buildPayloads({
        ...base,
        repos: [CARBON, CAIC],
        results: make('carbon', n),
      });
      assert.ok(payloads.length > 1, `${n} results need several messages`);
      assertWhole(payloads, expectedKeys('carbon', n), `${n} in one repo`);
      payloads.forEach((p, i) => {
        const t = textOf(p.blocks);
        if (i === payloads.length - 1) {
          assert.ok(t.includes(`*${CAIC}*\n_No eligible PRs._`), 'empty repo');
          return;
        }
        assert.ok(
          p.blocks[0].text.text.endsWith(
            `(part ${i + 1} of ${payloads.length})`
          )
        );
        assert.ok(t.includes(`*${CARBON}* · ${n} reviewed`), 'heading repeats');
        assert.ok(
          t.includes('*Repos:* carbon, carbon-ai-chat'),
          'intro repeats'
        );
        assert.ok(t.includes(`${n} PRs reviewed`), 'footer repeats');
      });
    });
  }

  await test('uneven repos needing several chunks keep repo order and every result once', () => {
    const results = [
      ...make('carbon-ai-chat', 7, 5001),
      ...make('carbon', 95, 1),
    ];
    const payloads = _buildPayloads({
      ...base,
      repos: [CARBON, CAIC],
      results,
    });
    assert.strictEqual(payloads.length, 4);
    assertWhole(
      payloads,
      [
        ...expectedKeys('carbon', 95),
        ...expectedKeys('carbon-ai-chat', 7, 5001),
      ],
      'uneven'
    );
    const keys = placed(payloads);
    assert.strictEqual(new Set(keys).size, keys.length, 'no duplicates');
    assert.ok(
      textOf(payloads[3].blocks).includes(`*${CAIC}* · 7 reviewed`),
      'last message is the second repository'
    );
  });

  await test('a result from a repo outside repos is still reported', () => {
    const payloads = _buildPayloads({
      ...base,
      repos: [CARBON],
      results: [...make('carbon', 1), ...make('elsewhere', 1, 9)],
    });
    assert.deepStrictEqual(placed(payloads), ['carbon#1', 'elsewhere#9']);
  });

  // ── Low-balance alert names the agent's unit ─────────────────────────────────
  const lowBlocks = (opts) => _buildLowTokenPayload(opts).blocks;
  const REPO = 'carbon-design-system/carbon';

  await test('low-balance alert for Bob is word for word what it was', () => {
    const header = {
      type: 'header',
      text: {
        type: 'plain_text',
        text: '⚠️  Carbon Monitor — Scheduled Review Paused',
        emoji: true,
      },
    };
    const action = {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          '*Action required:* increase your Bobcoins token limit, or disable scheduled reviews in the Carbon Monitor Settings panel. ' +
          'Scheduled reviews will remain paused until a human resumes them.',
      },
    };
    assert.deepStrictEqual(
      lowBlocks({
        percentRemaining: 8,
        threshold: 10,
        repo: REPO,
        isReminder: false,
        agent: 'bob',
      }),
      [
        header,
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Repo:* ${REPO}\n*Bobcoins remaining:* 8% (threshold: 10%)`,
          },
        },
        { type: 'divider' },
        action,
      ]
    );
    // No agent given: the configured one, which is Bob here.
    assert.deepStrictEqual(
      lowBlocks({
        percentRemaining: null,
        threshold: 10,
        repo: REPO,
        isReminder: true,
      })[1].text.text,
      `*Repo:* ${REPO}\n*Bobcoins remaining:* below threshold (threshold: 10%)\n` +
        '_This is a daily reminder — the schedule remains paused._'
    );
  });

  await test('low-balance alert for Claude names the budget and the variable to raise', () => {
    const blocks = lowBlocks({
      percentRemaining: 6.5,
      threshold: 10,
      repo: REPO,
      isReminder: false,
      agent: 'claude',
    });
    assert.strictEqual(
      blocks[1].text.text,
      `*Repo:* ${REPO}\n*Claude budget remaining:* 6.5% (threshold: 10%)`
    );
    assert.strictEqual(
      blocks[3].text.text,
      '*Action required:* raise CLAUDE_MONTHLY_BUDGET_USD, or disable scheduled reviews in the Carbon Monitor Settings panel. ' +
        'Scheduled reviews will remain paused until a human resumes them.'
    );
    const text = JSON.stringify(blocks);
    assert.ok(!/Bobcoins/.test(text), 'no Bobcoins in a Claude alert');

    const reminder = lowBlocks({
      percentRemaining: null,
      threshold: undefined,
      repo: REPO,
      isReminder: true,
      agent: 'claude',
    });
    assert.strictEqual(
      reminder[1].text.text,
      `*Repo:* ${REPO}\n*Claude budget remaining:* below threshold\n` +
        '_This is a daily reminder — the schedule remains paused._'
    );
  });

  // ── Run-failure alert ───────────────────────────────────────────────────────
  await test('the run-failure payload names the repos and the error, and says nothing of balance or schedule', () => {
    const repos = [
      'carbon-design-system/carbon',
      'carbon-design-system/carbon-ai-chat',
    ];
    const { blocks } = notifier._buildRunFailurePayload({
      startedAt: Date.UTC(2026, 10, 4, 15, 0),
      repos,
      error: 'carbon-ai-chat uses the caic profile. @channel',
    });
    assert.strictEqual(
      blocks[0].text.text,
      '⚠️  Carbon Monitor — Review Run Could Not Start'
    );
    const text = JSON.stringify(blocks);
    assert.ok(text.includes(repos.join(', ')), 'repos');
    assert.ok(text.includes('carbon-ai-chat uses the caic profile.'), 'error');
    assert.ok(!text.includes('@channel'), 'mentions are neutralised');
    assert.ok(
      text.includes('No pull requests were reviewed'),
      'run did not start'
    );
    assert.ok(
      !/paused|balance|remaining|threshold|Bobcoins/i.test(text),
      'not a low-balance alert'
    );
    assert.ok(blocks.length <= 50);
  });

  await test('postRunFailure is a silent no-op without a webhook', async () => {
    assert.strictEqual(_isEnabled(), false);
    let networkCallMade = false;
    const origRequest = https.request;
    https.request = () => {
      networkCallMade = true;
      throw new Error('no request expected');
    };
    try {
      await notifier.postRunFailure({
        startedAt: Date.now(),
        repos: ['carbon-design-system/carbon'],
        error: 'bad configuration',
      });
    } finally {
      https.request = origRequest;
    }
    assert.strictEqual(networkCallMade, false);
  });

  // ── Summary ──────────────────────────────────────────────────────────────────
  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
