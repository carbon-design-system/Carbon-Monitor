/**
 * GitHub Client Module
 * Wraps all GitHub API operations for PR review automation
 */

const { SKIP_LABELS } = require('./constants');

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

        const { data: prs } = await octokit.rest.pulls.list({
          owner,
          repo,
          state: 'open',
          sort: 'created',
          direction: 'desc',
          per_page: 100
        });

        // Filter out PRs that should not be reviewed
        const filtered = prs.filter(pr => {
          if (pr.draft) return false;
          if (new Date(pr.created_at) < since) return false;
          if (pr.labels.some(l => l.name === label || SKIP_LABELS.includes(l.name))) return false;
          if (pr.user.type === 'Bot') return false;
          return true;
        });

        return maxPRs ? filtered.slice(0, maxPRs) : filtered;
      } catch (error) {
        console.error('Error fetching reviewable PRs:', error.message);
        throw error;
      }
    },

    /**
     * Fetch unified diff for a PR
     * @param {Object} options - { owner, repo, pullNumber }
     * @returns {Promise<string>} Unified diff text
     */
    async fetchPRDiff({ owner, repo, pullNumber }) {
      try {
        const { data: diff } = await octokit.rest.pulls.get({
          owner,
          repo,
          pull_number: pullNumber,
          mediaType: {
            format: 'diff'
          }
        });
        return diff;
      } catch (error) {
        console.error('Error fetching PR diff:', error.message);
        throw error;
      }
    },

    /**
     * Fetch list of changed files in PR
     * @param {Object} options - { owner, repo, pullNumber }
     * @returns {Promise<Array>} Array of file objects with additions/deletions
     */
    async fetchPRFiles({ owner, repo, pullNumber }) {
      try {
        const allFiles = [];
        let page = 1;
        while (true) {
          const { data: files } = await octokit.rest.pulls.listFiles({
            owner,
            repo,
            pull_number: pullNumber,
            per_page: 100,
            page
          });
          allFiles.push(...files);
          if (files.length < 100) break;
          page++;
        }
        return allFiles;
      } catch (error) {
        console.error('Error fetching PR files:', error.message);
        throw error;
      }
    },

    /**
     * Post inline review comments on specific lines
     * @param {Object} options - { owner, repo, pullNumber, commitId, comments }
     * @returns {Promise<Object>} Review object
     */
    async postReviewComments({ owner, repo, pullNumber, commitId, comments }) {
      try {
        if (!comments || comments.length === 0) {
          return null;
        }

        // Filter out comments that don't have required fields
        const validComments = comments.filter(c => c.path && c.position && c.body);

        if (validComments.length === 0) {
          return null;
        }

        // Post inline comments individually to ensure they appear on specific lines
        // Using createReview with event: 'COMMENT' groups them in summary
        // Instead, post each comment individually using createReviewComment
        const postedComments = [];
        for (const comment of validComments) {
          try {
            const { data: reviewComment } = await octokit.rest.pulls.createReviewComment({
              owner,
              repo,
              pull_number: pullNumber,
              commit_id: commitId,
              path: comment.path,
              body: comment.body,
              position: comment.position
            });
            postedComments.push(reviewComment);
            console.log(`✅ Posted inline comment on ${comment.path}:${comment.position}`);
          } catch (commentError) {
            console.error(`⚠️  Failed to post comment on ${comment.path}:${comment.position}:`, commentError.message);
            if (commentError.response) {
              console.error('   Response status:', commentError.response.status);
              console.error('   Response data:', JSON.stringify(commentError.response.data, null, 2));
            }
            // Continue with other comments even if one fails
          }
        }
        
        // Return null if no comments were successfully posted
        if (postedComments.length === 0) {
          console.error('❌ No inline comments were successfully posted');
          return null;
        }
        
        // Return a summary object similar to createReview response
        const review = {
          id: postedComments.length > 0 ? postedComments[0].pull_request_review_id : null,
          comments: postedComments
        };

        return review;
      } catch (error) {
        console.error('❌ Error posting review:', error.message);
        if (error.response) {
          console.error('Response status:', error.response.status);
          console.error('Response data:', JSON.stringify(error.response.data, null, 2));
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
          body
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
          labels: [label]
        });
        return labels;
      } catch (error) {
        console.error('Error adding reviewed label:', error.message);
        throw error;
      }
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
        const match = prBody.match(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/i);
        if (!match) {
          console.log('ℹ️  No linked issue found in PR body');
          return { found: false };
        }

        const issueNumber = parseInt(match[1], 10);
        console.log(`🔗 Fetching linked issue #${issueNumber}...`);

        const { data: subIssueData } = await octokit.rest.issues.get({
          owner,
          repo,
          issue_number: issueNumber
        });

        const subIssue = {
          number: subIssueData.number,
          title: subIssueData.title,
          body: subIssueData.body || ''
        };

        // parent_issue_url is present in GitHub's sub-issues API response when the
        // issue is a child of another (e.g. a task under an epic). It is absent
        // (null/undefined) for standalone issues — the guard below handles both.
        // This branch is intentional and forward-compatible: do not remove it.
        // octokit.request() accepts the full URL directly, handling cross-repo parents.
        let parentIssue = null;
        if (subIssueData.parent_issue_url) {
          console.log(`🔗 Fetching parent issue from ${subIssueData.parent_issue_url}...`);
          try {
            const { data: parentData } = await octokit.request(subIssueData.parent_issue_url);
            parentIssue = {
              number: parentData.number,
              title: parentData.title,
              body: parentData.body || ''
            };
          } catch (parentError) {
            // Parent fetch failure is non-fatal — degrade gracefully with the
            // sub-issue context still intact rather than discarding everything.
            console.warn(`⚠️  Could not fetch parent issue context: ${parentError.message}`);
          }
        }

        return { found: true, subIssue, parentIssue };

      } catch (error) {
        console.warn(`⚠️  Could not fetch linked issue context: ${error.message}`);
        return { found: false };
      }
    }
  };
}

module.exports = { createGitHubClient };

// Made with Bob
