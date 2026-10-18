#!/usr/bin/env node
// Remove the reviewing account's own output from a test PR: its summary
// comments, inline comments, pending reviews and the review label. Submitted
// review events stay, GitHub's API cannot delete them. Dry run by default.
//
//   node scripts/clean-test-pr.js <pr-number>            # count only
//   node scripts/clean-test-pr.js <pr-number> --delete   # remove
//
// Owner, repo, token and label come from .env like every other script here.
require('../src/loadEnv');
const { createOctokit } = require('../src/githubClient');

const [, , prArg, mode = '--dry-run'] = process.argv;
if (!prArg) {
  console.error('usage: node scripts/clean-test-pr.js <pr-number> [--delete]');
  process.exit(2);
}
const owner = process.env.GITHUB_AI_AGENT_OWNER;
const repo = process.env.GITHUB_AI_AGENT_REPO;
const pull_number = Number(prArg);
const label = process.env.GITHUB_AI_AGENT_REVIEW_LABEL || 'AIReviewed';
const act = mode === '--delete';

(async () => {
  const octokit = await createOctokit({
    auth: process.env.GITHUB_AI_AGENT_TOKEN,
    baseUrl: process.env.GITHUB_API_BASE_URL || undefined,
  });
  const { data: me } = await octokit.rest.users.getAuthenticated();
  const mine = (list) =>
    list.filter((c) => c.user && c.user.login === me.login);
  const issueComments = mine(
    await octokit.paginate(octokit.rest.issues.listComments, {
      owner,
      repo,
      issue_number: pull_number,
      per_page: 100,
    })
  );
  const reviewComments = mine(
    await octokit.paginate(octokit.rest.pulls.listReviewComments, {
      owner,
      repo,
      pull_number,
      per_page: 100,
    })
  );
  const reviews = mine(
    await octokit.paginate(octokit.rest.pulls.listReviews, {
      owner,
      repo,
      pull_number,
      per_page: 100,
    })
  );
  const pending = reviews.filter((r) => r.state === 'PENDING');
  const { data: pr } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number,
  });
  const hasLabel = pr.labels.some((l) => l.name === label);

  console.log(`${me.login} on ${owner}/${repo}#${pull_number} "${pr.title}"`);
  console.log(
    `summary comments: ${issueComments.length} | inline comments: ${reviewComments.length} | review events: ${reviews.length} (${pending.length} pending) | label ${label}: ${hasLabel}`
  );
  if (!act) {
    console.log('dry run; add --delete to remove the comments and the label');
    return;
  }

  for (const c of reviewComments) {
    await octokit.rest.pulls.deleteReviewComment({
      owner,
      repo,
      comment_id: c.id,
    });
  }
  console.log(`deleted ${reviewComments.length} inline comments`);
  for (const c of issueComments) {
    await octokit.rest.issues.deleteComment({ owner, repo, comment_id: c.id });
  }
  console.log(`deleted ${issueComments.length} summary comments`);
  for (const r of pending) {
    await octokit.rest.pulls.deletePendingReview({
      owner,
      repo,
      pull_number,
      review_id: r.id,
    });
  }
  console.log(
    `deleted ${pending.length} pending reviews; ${reviews.length - pending.length} submitted review events stay`
  );
  if (hasLabel) {
    await octokit.rest.issues.removeLabel({
      owner,
      repo,
      issue_number: pull_number,
      name: label,
    });
    console.log(`removed ${label}`);
  }
})().catch((e) => {
  console.error('failed:', e.message);
  process.exit(1);
});
