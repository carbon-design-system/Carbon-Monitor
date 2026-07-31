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
const MAX_PRS_PER_RUN = Number(process.env.GITHUB_AI_AGENT_MAX_PRS || 5);

// Token-based input budget.
//
// Currency for AI is tokens, not chars. The limit is expressed in tokens so
// operators can reason directly against the model's context window without
// having to mentally divide by 4.
//
// Budget derivation (Bob, 200k context window):
//   200,000 total
//   −  40,000 reserved for MCP tool calls during the review
//   −  20,000 reserved for agent output
//   = 140,000 default input token budget
//
// Overhead derivation:
//   buildReviewPrompt() measured at 41,064 chars ≈ 10,266 tokens.
//   +~1,700 for PR metadata wrapper variability → rounded up to 12,000.
//   If the prompt is significantly extended in future, re-measure and update
//   PROMPT_OVERHEAD_TOKENS accordingly.
//
// Effective diff budget: (MAX_INPUT_TOKENS − PROMPT_OVERHEAD_TOKENS) × CHARS_PER_TOKEN
const CHARS_PER_TOKEN = 4;
const MAX_INPUT_TOKENS = Number(process.env.GITHUB_AI_AGENT_MAX_INPUT_TOKENS || 140000);
const PROMPT_OVERHEAD_TOKENS = 12000;
const MAX_DIFF_CHARS = (MAX_INPUT_TOKENS - PROMPT_OVERHEAD_TOKENS) * CHARS_PER_TOKEN;

module.exports = {
  GITHUB_OWNER,
  GITHUB_REPO,
  REVIEW_LABEL,
  SKIP_LABELS,
  REVIEW_AGENT,
  N_DAYS_SINCE_PR_CREATED,
  MAX_DIFF_CHARS,
  MAX_INPUT_TOKENS,
  CHARS_PER_TOKEN,
  PROMPT_OVERHEAD_TOKENS,
  MAX_PRS_PER_RUN,
};

// Made with Bob
