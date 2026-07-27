/**
 * Constants Module
 * Centralized configuration with environment variable defaults
 * Per spec lines 124-147
 */

const GITHUB_OWNER = process.env.GITHUB_AI_AGENT_OWNER || 'carbon-design-system';
const GITHUB_REPO = process.env.GITHUB_AI_AGENT_REPO || 'carbon';
const REVIEW_LABEL = process.env.GITHUB_AI_AGENT_REVIEW_LABEL || 'AIReviewed';
const SKIP_LABELS = ['DO NOT MERGE', 'status: WIP 👩‍💻'];
const REVIEW_AGENT = process.env.GITHUB_AI_AGENT_CLI || 'bob';

const N_DAYS_SINCE_PR_CREATED = Number(process.env.GITHUB_AI_AGENT_DAYS_BACK || 21);
const MAX_DIFF_CHARS = Number(process.env.GITHUB_AI_AGENT_MAX_DIFF_CHARS || 120000);
const MAX_PRS_PER_RUN = Number(process.env.GITHUB_AI_AGENT_MAX_PRS || 5);

module.exports = {
  GITHUB_OWNER,
  GITHUB_REPO,
  REVIEW_LABEL,
  SKIP_LABELS,
  REVIEW_AGENT,
  N_DAYS_SINCE_PR_CREATED,
  MAX_DIFF_CHARS,
  MAX_PRS_PER_RUN,
};

// Made with Bob
