#!/usr/bin/env node
/**
 * create-oversized-test-pr.js
 *
 * Creates a test PR with 3 dummy files and NO ORIGINAL_FILES.json. Carbon
 * Monitor treats it like a real repo PR and takes the diff from GitHub's file
 * patches. Set GITHUB_AI_AGENT_MAX_FILES=2 to get a partial review with just
 * 3 files: two reviewed, one listed as not reviewed.
 *
 * Usage:
 *   GITHUB_AI_AGENT_TOKEN=ghp_... node scripts/create-oversized-test-pr.js
 */

'use strict';

require('dotenv').config();

const GITHUB_TOKEN = process.env.GITHUB_AI_AGENT_TOKEN;
const OWNER = process.env.TEST_PR_OWNER;
const REPO = process.env.TEST_PR_REPO;
const BASE_BRANCH = 'main';
const HEAD_BRANCH = `test/oversized-pr-gate-${Date.now()}`;
const STALE_BRANCH_PREFIX = 'test/oversized-pr-gate-';

if (!GITHUB_TOKEN) {
  console.error('❌  GITHUB_AI_AGENT_TOKEN is not set');
  process.exit(1);
}
if (!OWNER || !REPO) {
  console.error(
    '❌  TEST_PR_OWNER and TEST_PR_REPO are not set (use a scratch repo, never the one being reviewed)'
  );
  process.exit(1);
}

// ── Dummy file contents ───────────────────────────────────────────────────────

const FILE_A = `// dummy-a.js — oversized PR gate test file\nexport const a = 1;\n`;
const FILE_B = `// dummy-b.js — oversized PR gate test file\nexport const b = 2;\n`;
const FILE_C = `// dummy-c.js — oversized PR gate test file\nexport const c = 3;\n`;

// ── GitHub API helper ─────────────────────────────────────────────────────────

async function ghFetch(path, options = {}) {
  const url = `https://api.github.com${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      'User-Agent': 'carbon-monitor-test-pr',
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  if (!res.ok) {
    throw new Error(
      `GitHub API ${options.method || 'GET'} ${path} → ${res.status}: ${JSON.stringify(data)}`
    );
  }
  return data;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🚀 Creating partial-review test PR in ${OWNER}/${REPO}`);
  console.log(`   Branch: ${HEAD_BRANCH}\n`);

  // 0. Close stale PRs from previous runs
  console.log('🧹 Closing stale test PRs...');
  const openPRs = await ghFetch(
    `/repos/${OWNER}/${REPO}/pulls?state=open&per_page=100`
  );
  const stale = openPRs.filter((p) =>
    p.head.ref.startsWith(STALE_BRANCH_PREFIX)
  );
  if (stale.length === 0) console.log('   No stale PRs found');
  for (const p of stale) {
    await ghFetch(`/repos/${OWNER}/${REPO}/pulls/${p.number}`, {
      method: 'PATCH',
      body: { state: 'closed' },
    });
    console.log(`   ✅ Closed PR #${p.number} (${p.head.ref})`);
  }

  // 1. Get base branch SHA
  console.log('\n📌 Getting base branch SHA...');
  const baseRef = await ghFetch(
    `/repos/${OWNER}/${REPO}/git/ref/heads/${BASE_BRANCH}`
  );
  const baseSha = baseRef.object.sha;
  console.log(`   Base SHA: ${baseSha}`);

  // 2. Create branch
  console.log(`\n🌿 Creating branch ${HEAD_BRANCH}...`);
  await ghFetch(`/repos/${OWNER}/${REPO}/git/refs`, {
    method: 'POST',
    body: { ref: `refs/heads/${HEAD_BRANCH}`, sha: baseSha },
  });
  console.log('   ✅ Branch created');

  // 3. Create blobs — 3 dummy files, NO ORIGINAL_FILES.json
  console.log('\n📝 Creating blobs...');
  const [blobA, blobB, blobC] = await Promise.all([
    ghFetch(`/repos/${OWNER}/${REPO}/git/blobs`, {
      method: 'POST',
      body: { content: FILE_A, encoding: 'utf-8' },
    }),
    ghFetch(`/repos/${OWNER}/${REPO}/git/blobs`, {
      method: 'POST',
      body: { content: FILE_B, encoding: 'utf-8' },
    }),
    ghFetch(`/repos/${OWNER}/${REPO}/git/blobs`, {
      method: 'POST',
      body: { content: FILE_C, encoding: 'utf-8' },
    }),
  ]);
  console.log('   ✅ Blobs created');

  // 4. Create tree
  const tree = await ghFetch(`/repos/${OWNER}/${REPO}/git/trees`, {
    method: 'POST',
    body: {
      base_tree: baseSha,
      tree: [
        {
          path: 'test/dummy-a.js',
          mode: '100644',
          type: 'blob',
          sha: blobA.sha,
        },
        {
          path: 'test/dummy-b.js',
          mode: '100644',
          type: 'blob',
          sha: blobB.sha,
        },
        {
          path: 'test/dummy-c.js',
          mode: '100644',
          type: 'blob',
          sha: blobC.sha,
        },
      ],
    },
  });

  // 5. Create commit
  const commit = await ghFetch(`/repos/${OWNER}/${REPO}/git/commits`, {
    method: 'POST',
    body: {
      message: 'test: partial review, 3 dummy files, no ORIGINAL_FILES.json',
      tree: tree.sha,
      parents: [baseSha],
    },
  });
  console.log(`   Commit SHA: ${commit.sha}`);

  // 6. Update branch ref
  await ghFetch(`/repos/${OWNER}/${REPO}/git/refs/heads/${HEAD_BRANCH}`, {
    method: 'PATCH',
    body: { sha: commit.sha, force: false },
  });
  console.log('   ✅ Branch updated');

  // 7. Open PR
  console.log('\n📬 Opening pull request...');
  const pr = await ghFetch(`/repos/${OWNER}/${REPO}/pulls`, {
    method: 'POST',
    body: {
      title: 'test: partial review, 3 dummy files',
      head: HEAD_BRANCH,
      base: BASE_BRANCH,
      body: `> **Partial-review test PR** — created by \`scripts/create-oversized-test-pr.js\`.\n> This PR has no \`ORIGINAL_FILES.json\` so Carbon Monitor treats it like a real repo PR.\n> Set \`GITHUB_AI_AGENT_MAX_FILES=2\` and run a review to see a partial-review comment that lists one file as not reviewed.`,
    },
  });

  console.log(`\n✅ PR created: ${pr.html_url}`);
  console.log(`   PR number:  #${pr.number}`);
  console.log('\n💡 To test a partial review:');
  console.log('   1. Set GITHUB_AI_AGENT_MAX_FILES=2 in .env');
  console.log(
    `   2. Set GITHUB_AI_AGENT_OWNER=${OWNER} and GITHUB_AI_AGENT_REPO=${REPO} in .env`
  );
  console.log('   3. Review the PR');
  console.log(
    `   4. Expect: a "Partial review: 2 of 3 changed files reviewed" note on PR #${pr.number}, with one file under "Over the 2-file cap"\n`
  );
}

main().catch((err) => {
  console.error('\n❌ Fatal error:', err.message);
  process.exit(1);
});
