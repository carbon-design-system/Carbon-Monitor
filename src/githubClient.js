/**
 * GitHub Client Module
 * Wraps all GitHub API operations for PR review automation
 */

const { SKIP_LABELS } = require('./constants');

const RATE_LIMIT_RETRIES = 2;
// A longer wait would hold the single-flight review loop; give up instead.
const RATE_LIMIT_MAX_WAIT_SECONDS = 60;

function rateLimitHandler(kind) {
  return (retryAfter, options, _octokit, retryCount) => {
    const again =
      retryCount < RATE_LIMIT_RETRIES &&
      retryAfter <= RATE_LIMIT_MAX_WAIT_SECONDS;
    console.warn(
      `[github] ${kind} on ${options.method} ${options.url}: ` +
        (again
          ? `retrying in ${retryAfter}s (${retryCount + 1}/${RATE_LIMIT_RETRIES})`
          : `giving up (wait ${retryAfter}s, attempt ${retryCount + 1})`)
    );
    return again;
  };
}

/**
 * Build an Octokit that retries transient errors and waits out short rate limits.
 * Only GET and HEAD are retried on 5xx: a retried POST after a 502 can post a
 * comment or review twice.
 * @param {Object} options - { auth, baseUrl, ...extra Octokit options }
 * @returns {Promise<Object>} Octokit instance
 */
async function createOctokit({ auth, baseUrl, ...extra }) {
  // The Octokit packages are ESM-only, so they load by dynamic import.
  const { Octokit } = await import('@octokit/rest');
  const { retry } = await import('@octokit/plugin-retry');
  const { throttling } = await import('@octokit/plugin-throttling');
  const ThrottledOctokit = Octokit.plugin(retry, throttling);
  const octokit = new ThrottledOctokit({
    auth,
    baseUrl,
    throttle: {
      onRateLimit: rateLimitHandler('primary rate limit'),
      onSecondaryRateLimit: rateLimitHandler('secondary rate limit'),
    },
    ...extra,
  });
  octokit.hook.before('request', (options) => {
    if (options.method !== 'GET' && options.method !== 'HEAD') {
      options.request = { ...options.request, retries: 0 };
    }
  });
  return octokit;
}

/**
 * Create a GitHub client for PR review operations
 * @param {Object} octokit - Initialized Octokit instance
 * @returns {Object} GitHub client with review operations
 */
function createGitHubClient(octokit) {
  return {
    /**
     * Fetch open PRs that don't have the review label
     * @param {Object} options - { owner, repo, daysBack, label }
     * @returns {Promise<Array>} Array of PR objects
     */
    async fetchReviewablePRs({ owner, repo, daysBack, label, maxPRs }) {
      try {
        const since = new Date();
        since.setDate(since.getDate() - daysBack);

        // Newest-created first, so every page after the cutoff can be skipped.
        // The map callback filters as it goes and stops paging once a page
        // reaches PRs older than the window, or already holds enough.
        let kept = 0;
        const filtered = await octokit.paginate(
          octokit.rest.pulls.list,
          {
            owner,
            repo,
            state: 'open',
            sort: 'created',
            direction: 'desc',
            per_page: 100,
          },
          (response, done) => {
            const page = response.data;
            const matches = page.filter((pr) => {
              if (pr.draft) return false;
              if (new Date(pr.created_at) < since) return false;
              if (
                pr.labels.some(
                  (l) => l.name === label || SKIP_LABELS.includes(l.name)
                )
              )
                return false;
              if (pr.user.type === 'Bot') return false;
              return true;
            });
            kept += matches.length;
            const last = page[page.length - 1];
            if (
              !last ||
              new Date(last.created_at) < since ||
              (maxPRs && kept >= maxPRs)
            )
              done();
            return matches;
          }
        );

        // Sort newest-first in code so the top-N slice is deterministic rather
        // than dependent on response order. Ties break by PR number (higher = newer).
        filtered.sort((a, b) => {
          const byCreated = new Date(b.created_at) - new Date(a.created_at);
          return byCreated !== 0 ? byCreated : b.number - a.number;
        });

        return maxPRs ? filtered.slice(0, maxPRs) : filtered;
      } catch (error) {
        console.error('Error fetching reviewable PRs:', error.message);
        throw error;
      }
    },

    /**
     * Fetch list of changed files in PR, each with its `patch` when GitHub has one
     * @param {Object} options - { owner, repo, pullNumber }
     * @returns {Promise<Array>} Array of file objects with additions/deletions
     */
    async fetchPRFiles({ owner, repo, pullNumber }) {
      try {
        const allFiles = [];
        let page = 1;
        // GitHub documents per_page up to 100, but in practice it sends no `patch` past the 70th file of a page
        const perPage = 70;
        while (true) {
          const { data: files } = await octokit.rest.pulls.listFiles({
            owner,
            repo,
            pull_number: pullNumber,
            per_page: perPage,
            page,
          });
          allFiles.push(...files);
          if (files.length < perPage) break;
          page++;
        }
        return allFiles;
      } catch (error) {
        console.error('Error fetching PR files:', error.message);
        throw error;
      }
    },

    /**
     * Post inline review comments on specific lines, as one review
     * @param {Object} options - { owner, repo, pullNumber, commitId, comments }
     * @returns {Promise<Object|null>} { id, comments: [{ path, position }] } for the comments posted, or null
     */
    async postReviewComments({ owner, repo, pullNumber, commitId, comments }) {
      try {
        if (!comments || comments.length === 0) {
          return null;
        }

        // Filter out comments that don't have required fields
        const validComments = comments.filter(
          (c) => c.path && c.position && c.body
        );

        if (validComments.length === 0) {
          return null;
        }

        // One review is one event and one notification, however many comments it carries
        const body = `Carbon Monitor inline findings (${validComments.length}). The summary and recommendation follow in a separate comment.`;
        try {
          const { data: review } = await octokit.rest.pulls.createReview({
            owner,
            repo,
            pull_number: pullNumber,
            commit_id: commitId,
            event: 'COMMENT',
            body,
            comments: validComments.map((c) => ({
              path: c.path,
              position: c.position,
              body: c.body,
            })),
          });
          console.log(
            `✅ Posted one review with ${validComments.length} inline comment(s)`
          );
          return {
            id: review.id,
            comments: validComments.map(({ path, position }) => ({
              path,
              position,
            })),
          };
        } catch (reviewError) {
          // 422 means GitHub created nothing and does not name the bad comment; anything else may have posted
          if (reviewError.status !== 422) throw reviewError;
          console.warn(
            `⚠️  Grouped review rejected (422: ${reviewError.message}) — posting inline comments one by one`
          );
          if (reviewError.response) {
            console.warn(
              '   Response data:',
              JSON.stringify(reviewError.response.data, null, 2)
            );
          }
        }

        const postedComments = [];
        let reviewId = null;
        for (const comment of validComments) {
          try {
            const { data: reviewComment } =
              await octokit.rest.pulls.createReviewComment({
                owner,
                repo,
                pull_number: pullNumber,
                commit_id: commitId,
                path: comment.path,
                body: comment.body,
                position: comment.position,
              });
            postedComments.push({
              path: comment.path,
              position: comment.position,
            });
            reviewId = reviewId ?? reviewComment.pull_request_review_id ?? null;
            console.log(
              `✅ Posted inline comment on ${comment.path}:${comment.position}`
            );
          } catch (commentError) {
            console.error(
              `⚠️  Failed to post comment on ${comment.path}:${comment.position}:`,
              commentError.message
            );
            if (commentError.response) {
              console.error(
                '   Response status:',
                commentError.response.status
              );
              console.error(
                '   Response data:',
                JSON.stringify(commentError.response.data, null, 2)
              );
            }
            // Continue with other comments even if one fails
          }
        }

        // Return null if no comments were successfully posted
        if (postedComments.length === 0) {
          console.error('❌ No inline comments were successfully posted');
          return null;
        }

        return { id: reviewId, comments: postedComments };
      } catch (error) {
        console.error('❌ Error posting review:', error.message);
        if (error.response) {
          console.error('Response status:', error.response.status);
          console.error(
            'Response data:',
            JSON.stringify(error.response.data, null, 2)
          );
        }
        console.error('Error posting review comments:', error.message);
        // Don't throw - inline comments are optional
        // Return null so caller knows it failed
        return null;
      }
    },

    /**
     * Post a summary comment on a PR
     * @param {Object} options - { owner, repo, pullNumber, body }
     * @returns {Promise<Object>} Comment object
     */
    async postSummaryComment({ owner, repo, pullNumber, body }) {
      try {
        const { data: comment } = await octokit.rest.issues.createComment({
          owner,
          repo,
          issue_number: pullNumber,
          body,
        });
        return comment;
      } catch (error) {
        console.error('Error posting summary comment:', error.message);
        throw error;
      }
    },

    /**
     * Add the review label to a PR
     * @param {Object} options - { owner, repo, pullNumber, label }
     * @returns {Promise<Array>} Updated labels
     */
    async addReviewedLabel({ owner, repo, pullNumber, label }) {
      try {
        const { data: labels } = await octokit.rest.issues.addLabels({
          owner,
          repo,
          issue_number: pullNumber,
          labels: [label],
        });
        return labels;
      } catch (error) {
        console.error('Error adding reviewed label:', error.message);
        throw error;
      }
    },

    /**
     * Fetch a single PR by number — no filtering applied
     * @param {Object} options - { owner, repo, pullNumber }
     * @returns {Promise<Object>} PR object
     */
    async fetchSinglePR({ owner, repo, pullNumber }) {
      const { data: pr } = await octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: pullNumber,
      });
      return pr;
    },

    /**
     * Fetch linked issue context from a PR body.
     * Parses the first Closes/Fixes/Resolves #N reference, fetches the issue,
     * and fetches its parent issue if parent_issue_url is present.
     * @param {Object} options - { owner, repo, prBody }
     * @returns {Promise<Object>} { found, subIssue, parentIssue }
     */
    async fetchLinkedIssueContext({ owner, repo, prBody }) {
      // Guard: null/undefined/empty PR body — no issue to fetch
      if (!prBody) return { found: false };

      try {
        // Parse first GitHub closing keyword reference (case-insensitive).
        // All 9 GitHub-documented forms: close, closes, closed, fix, fixes, fixed,
        // resolve, resolves, resolved. \b prevents partial-word matches (e.g. "hotfix").
        const match = prBody.match(
          /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/i
        );
        if (!match) {
          console.log('ℹ️  No linked issue found in PR body');
          return { found: false };
        }

        const issueNumber = parseInt(match[1], 10);
        console.log(`🔗 Fetching linked issue #${issueNumber}...`);

        const { data: subIssueData } = await octokit.rest.issues.get({
          owner,
          repo,
          issue_number: issueNumber,
        });

        const subIssue = {
          number: subIssueData.number,
          title: subIssueData.title,
          body: subIssueData.body || '',
        };

        // parent_issue_url is present in GitHub's sub-issues API response when the
        // issue is a child of another (e.g. a task under an epic). It is absent
        // (null/undefined) for standalone issues — the guard below handles both.
        // This branch is intentional and forward-compatible: do not remove it.
        // octokit.request() accepts the full URL directly, handling cross-repo parents.
        let parentIssue = null;
        if (subIssueData.parent_issue_url) {
          console.log(
            `🔗 Fetching parent issue from ${subIssueData.parent_issue_url}...`
          );
          try {
            const { data: parentData } = await octokit.request(
              subIssueData.parent_issue_url
            );
            parentIssue = {
              number: parentData.number,
              title: parentData.title,
              body: parentData.body || '',
            };
          } catch (parentError) {
            // Parent fetch failure is non-fatal — degrade gracefully with the
            // sub-issue context still intact rather than discarding everything.
            console.warn(
              `⚠️  Could not fetch parent issue context: ${parentError.message}`
            );
          }
        }

        return { found: true, subIssue, parentIssue };
      } catch (error) {
        console.warn(
          `⚠️  Could not fetch linked issue context: ${error.message}`
        );
        return { found: false };
      }
    },
  };
}

module.exports = { createGitHubClient, createOctokit, rateLimitHandler };
