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
    }
  };
}

module.exports = { createGitHubClient };

// Made with Bob
