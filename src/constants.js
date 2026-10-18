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

// Unset or blank takes the default; 0 omits the flag. A typo falls back to the default.
function capFromEnv(name, fallback) {
  const raw = (process.env[name] || '').trim();
  if (raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
const listFromEnv = (name, fallback) =>
  (process.env[name] || '').trim() || fallback;

const CLAUDE_MODEL =
  (process.env.CLAUDE_MODEL || '').trim() || 'claude-sonnet-5-5';
const CLAUDE_EFFORT = (process.env.CLAUDE_EFFORT || '').trim() || 'high';
// Anthropic says spend can pass the cap, so the default leaves headroom.
const CLAUDE_MAX_BUDGET_USD = capFromEnv('CLAUDE_MAX_BUDGET_USD', 5);
const CLAUDE_MAX_TURNS = capFromEnv('CLAUDE_MAX_TURNS', 60);
const CLAUDE_ALLOWED_TOOLS = listFromEnv(
  'CLAUDE_ALLOWED_TOOLS',
  'Read(./**),Glob,Grep,Skill(carbon-builder),mcp__carbon-mcp'
);
// Reads stay inside the bundle. The denies that guard the MCP bearer and the
// host (claude-config, ~, /proc) are appended by the Claude adapter, so an
// override of this list cannot drop them.
const CLAUDE_DISALLOWED_TOOLS = listFromEnv(
  'CLAUDE_DISALLOWED_TOOLS',
  'Bash,Edit,Write,MultiEdit,NotebookEdit,WebFetch,WebSearch,Agent'
);
// 0 or unset means unmetered.
const CLAUDE_MONTHLY_BUDGET_USD =
  Number(process.env.CLAUDE_MONTHLY_BUDGET_USD) || 0;
// Scheduled reviews pause below this percentage of the monthly budget.
const CLAUDE_BUDGET_LOW_PCT = capFromEnv('CLAUDE_BUDGET_LOW_PCT', 10);

// Reviews in flight inside one batch; 1 restores sequential reviews.
const _concurrency = Number.parseInt(process.env.REVIEW_CONCURRENCY, 10);
const REVIEW_CONCURRENCY = Number.isFinite(_concurrency)
  ? Math.max(1, _concurrency)
  : 2;

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
  CLAUDE_MODEL,
  CLAUDE_EFFORT,
  CLAUDE_MAX_BUDGET_USD,
  CLAUDE_MAX_TURNS,
  CLAUDE_ALLOWED_TOOLS,
  CLAUDE_DISALLOWED_TOOLS,
  CLAUDE_MONTHLY_BUDGET_USD,
  CLAUDE_BUDGET_LOW_PCT,
  REVIEW_CONCURRENCY,
  N_DAYS_SINCE_PR_CREATED,
  MAX_DIFF_CHARS,
  MAX_INPUT_TOKENS,
  CHARS_PER_TOKEN,
  PROMPT_OVERHEAD_TOKENS,
  ISSUE_CONTEXT_TOKENS,
  MAX_PRS_PER_RUN,
  MAX_FILES_PER_PR,
};

// A getter, not a value: src/agents requires this module, so it resolves lazily.
// An unknown agent runs one at a time; the readiness probe reports it.
Object.defineProperty(module.exports, 'EFFECTIVE_REVIEW_CONCURRENCY', {
  enumerable: true,
  get() {
    const agents = require('./agents');
    return agents.effectiveConcurrency(
      agents.find(REVIEW_AGENT),
      REVIEW_CONCURRENCY
    );
  },
});
