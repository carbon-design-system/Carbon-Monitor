#!/usr/bin/env node
'use strict';
// evals/caic/runner.js
//
// Drives the real Carbon Monitor pipeline against the scratch repo's eval PRs.
// Records results to evals/caic/results/<run-id>.json.
//
// Usage:
//   node evals/caic/runner.js --profile caic --pr 1 2 3   # run specific PR numbers
//   node evals/caic/runner.js --profile caic --manifest   # run all open PRs matching manifest branches
//   node evals/caic/runner.js --profile core --pr 1 2 3   # compare run with core profile
//
// Requires: .env loaded (or env vars set), GITHUB_AI_AGENT_OWNER=Chance-Gong,
//           GITHUB_AI_AGENT_REPOS=caic-pr-review-test (GITHUB_AI_AGENT_REPO
//           works only when REPOS is unset).
//
// The runner does NOT set GITHUB_AI_AGENT_OWNER/REPOS — the caller is
// responsible for pointing at the scratch repo in their env or .env, and the
// target list must be that one repo.
//
// After each review, reads the credit ledger to get cost per review.
// Prints a cost summary for the pilot gate.

const path = require('path');
const fs = require('fs');
const { execSync, spawnSync } = require('child_process');

// Load env only when run directly
require('../../src/loadEnv');

const MANIFEST = require('./manifest.json');
const REPO = MANIFEST.repo;

// ── parse args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const RUN_ALL_MANIFEST = args.includes('--manifest');
const prIdx = args.indexOf('--pr');
let prNumbers = [];
if (prIdx !== -1) {
  prNumbers = args
    .slice(prIdx + 1)
    .filter((a) => !a.startsWith('--'))
    .map(Number)
    .filter((n) => n > 0);
}

if (!RUN_ALL_MANIFEST && prNumbers.length === 0) {
  console.error(
    'Usage: node evals/caic/runner.js --pr <n> [<n> ...] | --manifest'
  );
  process.exit(1);
}

const profileIdx = args.indexOf('--profile');
const profile = profileIdx === -1 ? 'core' : args[profileIdx + 1];
if (!['core', 'caic'].includes(profile)) {
  console.error('--profile must be core or caic.');
  process.exit(1);
}

// constants.js applies the plural-variable precedence, so the singular
// variable never overrides a configured list.
let owner;
let targets;
try {
  ({
    GITHUB_OWNER: owner,
    GITHUB_REPOS: targets,
  } = require('../../src/constants'));
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
const repo = targets[0];

// Refuse before spawning anything: a wrong target would post on a real repo.
if (targets.length !== 1 || `${owner}/${repo}` !== MANIFEST.repo) {
  console.error(
    `The eval reviews only ${MANIFEST.repo}, but the target is ${targets.map((r) => `${owner}/${r}`).join(', ')}.`
  );
  console.error(
    '   Set GITHUB_AI_AGENT_OWNER=Chance-Gong GITHUB_AI_AGENT_REPOS=caic-pr-review-test'
  );
  process.exit(1);
}

// ── resolve PR list when --manifest is used ───────────────────────────────────
async function resolveManifestPrs() {
  const { Octokit } = require('@octokit/rest');
  const octokit = new Octokit({ auth: process.env.GITHUB_AI_AGENT_TOKEN });
  const [repoOwner, repoName] = MANIFEST.repo.split('/');
  const { data } = await octokit.pulls.list({
    owner: repoOwner,
    repo: repoName,
    state: 'open',
    per_page: 100,
  });
  const branchSet = new Set(MANIFEST.prs.map((p) => p.branch));
  return data.filter((pr) => branchSet.has(pr.head.ref)).map((pr) => pr.number);
}

// ── run one PR via run-one.js ───────────────────────────────────────────────
function runReview(prNumber) {
  console.log(
    `\n── Running PR #${prNumber} (profile=${profile}) ──────────────────`
  );
  const result = spawnSync(
    process.execPath,
    [
      path.resolve(__dirname, 'run-one.js'),
      '--profile',
      profile,
      '--pr',
      String(prNumber),
    ],
    {
      env: { ...process.env },
      stdio: 'inherit',
      timeout: 10 * 60 * 1000, // 10 min per review
    }
  );
  return result.status === 0;
}

// ── read credit ledger for last N entries ─────────────────────────────────────
function readLastCosts(n) {
  const ledgerPath =
    process.env.CREDIT_LEDGER_PATH ||
    path.join(
      os.tmpdir ? os.tmpdir() : '/tmp',
      'carbon-monitor-credit-ledger.jsonl'
    );
  if (!fs.existsSync(ledgerPath)) return [];
  const lines = fs
    .readFileSync(ledgerPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean);
  return lines
    .slice(-n)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

// ── read ES events for this run ───────────────────────────────────────────────
// (Optional — only works when ES is configured)
async function fetchRunEvents(correlationIds) {
  if (!process.env.ES_URL) return [];
  try {
    const { Client } = require('@elastic/elasticsearch');
    const esClient = require('../../src/observability/esClient').getClient();
    const { body } = await esClient.search({
      index: 'carbon-monitor*',
      body: {
        query: {
          terms: { correlation_id: correlationIds },
        },
        size: 200,
      },
    });
    return body.hits.hits.map((h) => h._source);
  } catch {
    return [];
  }
}

// ── scoring helper ────────────────────────────────────────────────────────────
function scoreReviews(results, manifestPrs) {
  const byBranch = {};
  for (const mp of manifestPrs) {
    byBranch[mp.branch] = mp;
  }
  // This is a stub — real scoring happens with the ES events + human review.
  // The runner records raw results; a human scores recall and false positives.
  return results;
}

// ── main ──────────────────────────────────────────────────────────────────────
const os = require('os');

(async () => {
  let toRun = prNumbers;
  if (RUN_ALL_MANIFEST) {
    console.log('Resolving open PRs matching manifest branches...');
    toRun = await resolveManifestPrs();
    console.log(
      `Found ${toRun.length} open manifest PR(s): ${toRun.join(', ')}`
    );
  }

  if (toRun.length === 0) {
    console.error('No PRs to run.');
    process.exit(1);
  }

  const runId = `${profile}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const resultsDir = path.resolve(__dirname, 'results');
  fs.mkdirSync(resultsDir, { recursive: true });

  const runRecord = {
    runId,
    profile,
    repo: `${owner}/${repo}`,
    prs: toRun,
    startedAt: new Date().toISOString(),
    reviews: [],
  };

  for (const prNum of toRun) {
    const ok = runReview(prNum);
    runRecord.reviews.push({ prNumber: prNum, success: ok });
  }

  runRecord.finishedAt = new Date().toISOString();

  // Append ledger costs
  const costs = readLastCosts(toRun.length);
  runRecord.ledgerCosts = costs;
  if (costs.length > 0) {
    const total = costs.reduce((s, c) => s + (c.cost || 0), 0);
    const mean = total / costs.length;
    runRecord.meanCostPerReview = mean;
    runRecord.totalCost = total;
    console.log(
      `\n── Cost summary ──────────────────────────────────────────────`
    );
    console.log(`  Reviews: ${costs.length}`);
    console.log(
      `  Mean cost per review: ${mean.toFixed(2)} (units: ${costs[0]?.unit || 'unknown'})`
    );
    console.log(`  Total for this run: ${total.toFixed(2)}`);
    const full52 = mean * 52;
    console.log(`  Projected total for 52 reviews: ${full52.toFixed(2)}`);
    console.log(
      `\n  ⚠  Pilot gate: confirm the projected cost is acceptable before running all 26 PRs.`
    );
  }

  const outPath = path.join(resultsDir, `${runId}.json`);
  fs.writeFileSync(outPath, JSON.stringify(runRecord, null, 2));
  console.log(`\nResults written to: ${outPath}`);

  const failed = runRecord.reviews.filter((r) => !r.success);
  if (failed.length > 0) {
    console.error(
      `\n${failed.length} review(s) failed: PR #${failed.map((r) => r.prNumber).join(', #')}`
    );
    process.exit(1);
  }
  console.log(`\n✅ All ${toRun.length} review(s) complete.`);
})();
