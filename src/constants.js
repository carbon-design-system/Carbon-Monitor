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

const N_DAYS_SINCE_PR_CREATED = Number(
  process.env.GITHUB_AI_AGENT_DAYS_BACK || 21
);
const MAX_PRS_PER_RUN = Number(process.env.GITHUB_AI_AGENT_MAX_PRS || 10);

// PRs over this file count are skipped in auto mode and labelled AIReviewed.
// This is a review-quality cap, not a GitHub API limit — override via env var.
const MAX_FILES_PER_PR = Number(process.env.GITHUB_AI_AGENT_MAX_FILES || 300);

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
// Three-slice input budget breakdown (at default 140k):
//   Slice 1 — Prompt overhead   12,000 tokens  (buildReviewPrompt() measured at
//             41,064 chars ≈ 10,266 tokens + ~1,700 variability buffer)
//   Slice 2 — Issue context      5,000 tokens  (linked GitHub issue + parent;
//             real issues are ~468 tokens — 5k is a generous cap)
//   Slice 3 — Diff budget      123,000 tokens  → 492,000 chars @ 4 chars/token
//             ─────────────────────────────────
//             Total             140,000 tokens
//
// If the prompt is significantly extended in future, re-measure and update
// PROMPT_OVERHEAD_TOKENS accordingly.
const CHARS_PER_TOKEN = 4;
const MAX_INPUT_TOKENS = Number(
  process.env.GITHUB_AI_AGENT_MAX_INPUT_TOKENS || 140000
);
const PROMPT_OVERHEAD_TOKENS = 12000;
const ISSUE_CONTEXT_TOKENS = 5000;
// MAX_DIFF_CHARS always reserves the ISSUE_CONTEXT_TOKENS slice regardless of whether
// a linked issue is found for a given PR. This is intentional worst-case budgeting —
// the diff budget is always the reduced size so the token total never exceeds
// MAX_INPUT_TOKENS even when both a large diff and a large issue body are present.
const MAX_DIFF_CHARS =
  (MAX_INPUT_TOKENS - PROMPT_OVERHEAD_TOKENS - ISSUE_CONTEXT_TOKENS) *
  CHARS_PER_TOKEN;

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
  ISSUE_CONTEXT_TOKENS,
  MAX_PRS_PER_RUN,
  MAX_FILES_PER_PR,
};
