#!/usr/bin/env node
'use strict';
// scripts/create-caic-eval-prs.js
//
// Creates all 26 eval PRs defined in evals/caic/manifest.json on the scratch
// repo Chance-Gong/caic-pr-review-test via the GitHub API (gh CLI).
//
// NEVER run this without the user's explicit go-ahead.
//
// Usage:
//   node scripts/create-caic-eval-prs.js            # create all 26
//   node scripts/create-caic-eval-prs.js A1 A2 B1   # create specific PRs
//   node scripts/create-caic-eval-prs.js --pilot     # create pilot set (A1 A9 B1 C2)
//
// Pushes branches via HTTPS using the `gh` CLI login (not SSH).
// Requires: gh (authenticated), git (with HTTPS credential helper or GITHUB_TOKEN).

const { execSync, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const MANIFEST = require('../evals/caic/manifest.json');
const REPO = MANIFEST.repo;
const BASE_REF = MANIFEST.baseRef;

// ── parse args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const PILOT_IDS = ['A1', 'A9', 'B1', 'C2'];
let targetIds;
if (args.includes('--pilot')) {
  targetIds = new Set(PILOT_IDS);
  console.log(`Pilot mode: creating ${PILOT_IDS.join(', ')}`);
} else if (args.length > 0) {
  targetIds = new Set(args);
} else {
  targetIds = null; // all
}

const prs = targetIds
  ? MANIFEST.prs.filter((p) => targetIds.has(p.id))
  : MANIFEST.prs;

if (prs.length === 0) {
  console.error('No matching PRs found. Check the IDs against manifest.json.');
  process.exit(1);
}

console.log(`Creating ${prs.length} PR(s) on ${REPO}:`);
prs.forEach((p) => console.log(`  ${p.id}: ${p.title}`));
console.log('');

// ── helpers ───────────────────────────────────────────────────────────────────
function run(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf8', stdio: 'pipe', ...opts });
}

function ghApi(endpoint, method = 'GET', body = null) {
  const args = ['api', endpoint, '--method', method];
  if (body) {
    args.push('--input', '-');
  }
  const result = spawnSync('gh', args, {
    encoding: 'utf8',
    input: body ? JSON.stringify(body) : undefined,
  });
  if (result.status !== 0) {
    throw new Error(`gh api ${endpoint} failed:\n${result.stderr}`);
  }
  return result.stdout ? JSON.parse(result.stdout) : null;
}

// Get the current SHA of base ref
function getBaseSha() {
  const ref = ghApi(`repos/${REPO}/git/ref/heads/${BASE_REF}`);
  return ref.object.sha;
}

// Get file SHA for update (returns null if file doesn't exist)
function getFileSha(filePath) {
  try {
    const r = ghApi(`repos/${REPO}/contents/${filePath}`);
    return r.sha;
  } catch {
    return null;
  }
}

// Create or update a file on a branch via the GitHub API
function upsertFile(branch, filePath, content, message) {
  const encoded = Buffer.from(content).toString('base64');
  const sha = getFileSha(filePath);
  // The default branch has the file — but we're on a new branch, so the file
  // already exists there too (branches start from main). We need the sha.
  const body = {
    message,
    content: encoded,
    branch,
  };
  if (sha) body.sha = sha;
  ghApi(`repos/${REPO}/contents/${filePath}`, 'PUT', body);
}

// Create a branch from base SHA
function createBranch(branch, sha) {
  try {
    ghApi(`repos/${REPO}/git/refs`, 'POST', {
      ref: `refs/heads/${branch}`,
      sha,
    });
    console.log(`  → created branch ${branch}`);
  } catch (err) {
    if (
      err.message.includes('already exists') ||
      err.message.includes('Reference already exists')
    ) {
      console.log(`  → branch ${branch} already exists, reusing`);
    } else {
      throw err;
    }
  }
}

// Open a PR
function createPr(branch, title, body) {
  try {
    const pr = ghApi(`repos/${REPO}/pulls`, 'POST', {
      title,
      head: branch,
      base: BASE_REF,
      body,
    });
    return pr.number;
  } catch (err) {
    if (
      err.message.includes('already exists') ||
      err.message.includes('A pull request already exists')
    ) {
      console.log(`  → PR already exists for ${branch}`);
      // Find existing PR number
      const prs = ghApi(
        `repos/${REPO}/pulls?head=Chance-Gong:${branch}&state=open`
      );
      return prs && prs.length > 0 ? prs[0].number : null;
    }
    throw err;
  }
}

// ── main ──────────────────────────────────────────────────────────────────────
(async () => {
  const baseSha = getBaseSha();
  console.log(`Base SHA (${BASE_REF}): ${baseSha}\n`);

  const results = [];

  for (const pr of prs) {
    console.log(`\n[${pr.id}] ${pr.title}`);
    try {
      // 1. Create branch
      createBranch(pr.branch, baseSha);

      // 2. Apply each file change via GitHub API (no local clone needed)
      for (const change of pr.changes) {
        upsertFile(
          pr.branch,
          change.path,
          change.content,
          `${pr.id}: ${pr.title}`
        );
        console.log(`  → updated ${change.path}`);
      }

      // 3. Open the PR
      const prNumber = createPr(pr.branch, pr.title, pr.description || '');
      console.log(`  ✅ PR #${prNumber}: ${pr.title}`);
      results.push({ id: pr.id, prNumber, branch: pr.branch, status: 'ok' });
    } catch (err) {
      console.error(`  ❌ ${pr.id} failed: ${err.message}`);
      results.push({
        id: pr.id,
        branch: pr.branch,
        status: 'error',
        error: err.message,
      });
    }
  }

  console.log(
    '\n── Summary ──────────────────────────────────────────────────────'
  );
  for (const r of results) {
    const icon = r.status === 'ok' ? '✅' : '❌';
    const detail = r.status === 'ok' ? `PR #${r.prNumber}` : r.error;
    console.log(`  ${icon} ${r.id}: ${detail}`);
  }

  const failed = results.filter((r) => r.status !== 'ok');
  if (failed.length > 0) {
    console.error(`\n${failed.length} PR(s) failed.`);
    process.exit(1);
  }

  console.log(`\nDone. ${results.length} PR(s) created on ${REPO}.`);
  console.log(`Next: run the 4-PR pilot with:`);
  console.log(`  REVIEW_PROFILE=caic node src/index.js --pr <A1-number>`);
  console.log(`Then check the credit ledger for cost per review.`);
})();
