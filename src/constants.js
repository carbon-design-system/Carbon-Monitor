/**
 * Constants Module
 * Centralized configuration with environment variable defaults
 */

const GITHUB_OWNER =
  process.env.GITHUB_AI_AGENT_OWNER || 'carbon-design-system';
const GITHUB_REPO = process.env.GITHUB_AI_AGENT_REPO || 'carbon';
const REVIEW_LABEL = process.env.GITHUB_AI_AGENT_REVIEW_LABEL || 'AIReviewed';
const SKIP_LABELS = ['DO NOT MERGE', 'status: WIP 👩‍💻'];
const REVIEW_AGENT = process.env.GITHUB_AI_AGENT_CLI || 'bob';

// Anything but 'pretty' means stream-json, so a typo never selects the legacy path.
const BOB_OUTPUT_FORMAT =
  process.env.BOB_OUTPUT_FORMAT === 'pretty' ? 'pretty' : 'stream-json';
// 0 or unset omits the flag; Bob 2.0.5 rejects --max-cost 0.
const BOB_MAX_COST = Number(process.env.BOB_MAX_COST) || 0;
const BOB_MAX_TURNS = Number(process.env.BOB_MAX_TURNS) || 0;
const BOB_DISABLE_TOOL_GROUPS = (
  process.env.BOB_DISABLE_TOOL_GROUPS || ''
).trim();

// Reviews in flight inside one batch; 1 restores sequential reviews.
const _concurrency = Number.parseInt(process.env.REVIEW_CONCURRENCY, 10);
const REVIEW_CONCURRENCY = Number.isFinite(_concurrency)
  ? Math.max(1, _concurrency)
  : 2;
// Bob alone gets a private HOME per review; other CLIs run one at a time.
const EFFECTIVE_REVIEW_CONCURRENCY =
  REVIEW_AGENT === 'bob' ? REVIEW_CONCURRENCY : 1;

const N_DAYS_SINCE_PR_CREATED = Number(
  process.env.GITHUB_AI_AGENT_DAYS_BACK || 21
);
const MAX_PRS_PER_RUN = Number(process.env.GITHUB_AI_AGENT_MAX_PRS || 10);

// PRs over this file count are skipped in auto mode and labelled AIReviewed.
// This is a review-quality cap, not a GitHub API limit — override via env var.
const MAX_FILES_PER_PR = Number(process.env.GITHUB_AI_AGENT_MAX_FILES || 300);

// Input budget is in tokens so it can be read against the model's context
// window. Prompt overhead is re-measured when the prompt grows; the derivation
// is in docs/CONFIGURATION.md.
const CHARS_PER_TOKEN = 4;
const MAX_INPUT_TOKENS = Number(
  process.env.GITHUB_AI_AGENT_MAX_INPUT_TOKENS || 140000
);
const PROMPT_OVERHEAD_TOKENS = 12000;
const ISSUE_CONTEXT_TOKENS = 5000;
// Reserves the issue slice even when no issue is linked, so the total never
// exceeds MAX_INPUT_TOKENS in the worst case.
const MAX_DIFF_CHARS =
  (MAX_INPUT_TOKENS - PROMPT_OVERHEAD_TOKENS - ISSUE_CONTEXT_TOKENS) *
  CHARS_PER_TOKEN;

module.exports = {
  GITHUB_OWNER,
  GITHUB_REPO,
  REVIEW_LABEL,
  SKIP_LABELS,
  REVIEW_AGENT,
  BOB_OUTPUT_FORMAT,
  BOB_MAX_COST,
  BOB_MAX_TURNS,
  BOB_DISABLE_TOOL_GROUPS,
  REVIEW_CONCURRENCY,
  EFFECTIVE_REVIEW_CONCURRENCY,
  N_DAYS_SINCE_PR_CREATED,
  MAX_DIFF_CHARS,
  MAX_INPUT_TOKENS,
  CHARS_PER_TOKEN,
  PROMPT_OVERHEAD_TOKENS,
  ISSUE_CONTEXT_TOKENS,
  MAX_PRS_PER_RUN,
  MAX_FILES_PER_PR,
};
