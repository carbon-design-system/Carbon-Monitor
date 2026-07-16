/**
 * Format review comments according to Carbon PR review spec
 */

/**
 * Estimate token usage for a PR review
 *
 * @param {Object} options
 * @param {string} options.prompt - Review prompt text
 * @param {string} options.diff - PR diff content
 * @param {string} options.agentOutput - Agent's output
 * @returns {Object} - { input: number, output: number, total: number }
 */
function estimateTokenUsage({ prompt, diff, agentOutput }) {
  const CHARS_PER_TOKEN = 4;
  const inputChars  = (prompt?.length || 0) + (diff?.length || 0);
  const outputChars = agentOutput?.length || 0;
  const inputTokens  = Math.ceil(inputChars  / CHARS_PER_TOKEN);
  const outputTokens = Math.ceil(outputChars / CHARS_PER_TOKEN);
  return { input: inputTokens, output: outputTokens, total: inputTokens + outputTokens };
}

// ---------------------------------------------------------------------------
// Recommendation labels and submitter-facing advice copy
// ---------------------------------------------------------------------------

const RECOMMENDATION_LABELS = {
  'consider-revising':     'Consider Revising',
  'suggested-improvements':'Suggested Improvements',
  'looks-good':            'Looks Good'
};

const RECOMMENDATION_ADVICE = {
  'consider-revising':
    'There are issues in this PR that should be addressed before merging. ' +
    'Please review the findings below — the blocking and major items include specific suggestions on what to change.',
  'suggested-improvements':
    'This PR is on the right track. The findings below are suggestions worth considering before or shortly after merging — ' +
    'none are hard blockers, but addressing them would improve correctness or maintainability.',
  'looks-good':
    'No blocking or major issues were found. Any nit-level notes below are entirely optional and provided for completeness.'
};

const SEVERITY_GUIDANCE = {
  blocking: 'Should be resolved before this ships.',
  major:    'Worth addressing before merge.',
  minor:    'Consider addressing — not a hard blocker.',
  nit:      'Optional — provided for completeness.'
};

// ---------------------------------------------------------------------------
// formatInlineComment
// ---------------------------------------------------------------------------

/**
 * Format inline review comment for a specific finding.
 * Verification evidence is intentionally omitted — the header line in the
 * summary comment communicates connection status for the whole review.
 *
 * @param {Object} finding
 * @returns {string}
 */
function formatInlineComment(finding) {
  const guidance = SEVERITY_GUIDANCE[finding.severity] || '';
  let comment = `**${finding.title}**\n\n`;
  comment += `> **[${finding.severity}]** ${guidance}\n\n`;
  comment += finding.body + '\n';
  return comment;
}

// ---------------------------------------------------------------------------
// formatSummaryComment
// ---------------------------------------------------------------------------

/**
 * Format summary comment with spec-compliant template.
 *
 * @param {Object}  options
 * @param {string}  options.agent
 * @param {string}  options.summaryMarkdown
 * @param {number}  options.prNumber
 * @param {string}  options.commitSha
 * @param {Array}   [options.inlineFindings]
 * @param {Array}   [options.summaryFindings]
 * @param {Object}  [options.tokenUsage]
 * @param {Object}  [options.carbonVerification]   - { skillConnected, mcpConnected }
 * @param {string}  [options.recommendation]
 * @param {string}  [options.recommendationRationale]
 * @param {Array}   [options.findingsTable]
 * @returns {string}
 */
function formatSummaryComment({
  agent,
  summaryMarkdown,
  prNumber,
  commitSha,
  inlineFindings       = [],
  summaryFindings      = [],
  tokenUsage           = null,
  carbonVerification   = null,
  recommendation       = 'looks-good',
  recommendationRationale = '',
  findingsTable        = []
}) {
  const recLabel  = RECOMMENDATION_LABELS[recommendation] || recommendation;
  const recAdvice = RECOMMENDATION_ADVICE[recommendation] || '';
  const cv = carbonVerification || {};

  // ── Header ─────────────────────────────────────────────────────────────
  let comment = `[AI agent review — Carbon grounded] · **${recLabel}**\n\n`;
  comment += `Reviewed by: ${agent} · Commit: ${commitSha.substring(0, 7)}\n`;

  // Single-line verification status — connected/disconnected per source
  const skillStatus = cv.skillConnected ? 'Carbon Builder Skill connected' : 'Carbon Builder Skill disconnected';
  const mcpStatus   = cv.mcpConnected   ? 'Carbon MCP connected'           : 'Carbon MCP disconnected';
  comment += `Carbon verification: ${skillStatus} · ${mcpStatus}.\n\n`;

  // ── Recommendation section ─────────────────────────────────────────────
  comment += `## Recommendation\n\n`;
  if (recommendationRationale) {
    comment += `${recommendationRationale}\n\n`;
  }
  comment += `${recAdvice}\n\n`;

  // ── Findings table ─────────────────────────────────────────────────────
  if (findingsTable && findingsTable.length > 0) {
    comment += `## Findings\n\n`;
    comment += `| Area | Category | Severity | Finding | File |\n`;
    comment += `|------|----------|----------|---------|------|\n`;
    for (const row of findingsTable) {
      const safe = v => String(v || '').replace(/[|\n\r]/g, ' ').trim();
      comment += `| ${safe(row.area)} | ${safe(row.category)} | ${safe(row.severity)} | ${safe(row.title)} | ${safe(row.file)} |\n`;
    }
    comment += '\n';
  }

  // ── Agent summary ──────────────────────────────────────────────────────
  comment += `## Summary\n\n`;
  comment += summaryMarkdown + '\n\n';

  // ── Additional findings that couldn't be posted inline ─────────────────
  if (summaryFindings && summaryFindings.length > 0) {
    comment += `## Additional Findings\n\n`;
    comment += `The following findings could not be mapped to specific lines in the diff:\n\n`;

    summaryFindings.forEach((finding, index) => {
      const guidance = SEVERITY_GUIDANCE[finding.severity] || '';
      comment += `### ${index + 1}. ${finding.title}\n\n`;
      comment += `**File:** \`${finding.file}\``;
      if (finding.line) comment += ` (Line ${finding.line})`;
      comment += `\n**Severity:** ${finding.severity} — ${guidance}\n\n`;
      comment += finding.body + '\n\n';
      comment += '---\n\n';
    });
  }

  // ── Review artifacts ────────────────────────────────────────────────────
  comment += `Review artifacts:\n\n`;
  comment += `- PR: #${prNumber}\n`;
  comment += `- Commit: ${commitSha.substring(0, 7)}\n`;
  comment += `- Agent: ${agent}\n`;
  if (inlineFindings  && inlineFindings.length  > 0) comment += `- Inline comments: ${inlineFindings.length}\n`;
  if (summaryFindings && summaryFindings.length > 0) comment += `- Summary findings: ${summaryFindings.length}\n`;

  // ── Token usage ─────────────────────────────────────────────────────────
  if (tokenUsage) {
    comment += `\n---\n\n`;
    comment += `**Estimated Token Usage:**\n`;
    comment += `- Input tokens: ~${tokenUsage.input.toLocaleString()}\n`;
    comment += `- Output tokens: ~${tokenUsage.output.toLocaleString()}\n`;
    comment += `- Total tokens: ~${tokenUsage.total.toLocaleString()}\n`;
    comment += `\n*Note: Token estimates are approximate and based on character count (1 token ≈ 4 characters).*\n`;
  }

  return comment;
}

// ---------------------------------------------------------------------------
// buildReviewPrompt
// ---------------------------------------------------------------------------

/**
 * Build the prompt for the AI agent.
 *
 * @param {Object}  options
 * @param {string}  options.owner
 * @param {string}  options.repo
 * @param {boolean} [options.skillRefsAvailable=true]
 * @returns {string}
 */
function buildReviewPrompt({ owner, repo, skillRefsAvailable = true }) {
  const SKILL_REF_PATH = '.bob/skills/carbon-builder/references';

  // ── Step 2 verification instructions (inlined once, referenced by name) ──

  const step2SkillBlock = skillRefsAvailable
    ? `**Step 2a — Read Carbon Builder Skill files first (mandatory before any MCP call):**
Files at \`${SKILL_REF_PATH}/\` — use your file-read tool to physically open the relevant file:
- \`implementation-guardrails.md\` — component/API correctness, accessibility, tokens (start here)
- \`framework-rules.md\` — React vs Web Components, SCSS, spacing tokens
- \`common-pitfalls.md\` — Web Components styling, missing style imports

Find text directly relevant to the finding. Copy verbatim into \`skillEvidence\` as \`"filename: 'exact sentence'"\`.
Set \`skillConnected: true\`, \`skillProof\` = same verbatim sentence.
Then proceed to Step 2b — never stop here.`
    : `**Step 2a — Skill files NOT available.** Set \`skillConnected: false\`. Proceed to Step 2b.`;

  const step2McpBlock = `**Step 2b — Carbon MCP (after Step 2a, for every Category 1 item):**
Call carbon-mcp tools (server: \`carbon-mcp\`). Prefer \`code_search\` (size:2) then \`docs_search\` (size:3).
When \`example_omitted:true\`, follow \`requery_hint\` (size:1) before falling back.
Stop after 2 calls for the same prop. If MCP succeeds: set \`mcpConnected:true\`, copy a verbatim snippet into \`mcpEvidence\` and \`mcpProof\`.
If ALL calls fail (network error): set \`mcpConnected:false\` — post the finding using skill evidence only (set \`verificationSource:"carbon-builder-skill"\`).
Tool-specific "no results" ≠ network failure — try a different query first.`;

  return `You are an agentic PR reviewer for ${owner}/${repo}.

**OUTPUT CONTRACT:**
- Keep ALL reasoning, step narration, and MCP call details inside \`<think>\` tags.
- Outside \`<think>\`, write ONLY: catalogue lines, NO-FINDINGS/SKIP lines, and the final JSON block.
- Do not call attempt_completion. Writing the JSON between BEGIN_REVIEW_JSON / END_REVIEW_JSON IS completion.
- Do not end your response without the JSON block, even when findings is empty.

---

## Step 1 — Catalogue the diff

Read PR_REVIEW_REQUEST.md (contains PR description, changed files, and full diff). Do not read pr.json, files.json, or diff.patch separately.

For each suspicious item write one line:
\`[file:line] — [what you saw] — [Cat1|Cat2] — pending\`

Cat1 = about whether a specific Carbon element accepts a specific attribute/prop/variant → must verify.
Cat2 = generic correctness, accessibility omission, or diff-visible markup issue → no MCP needed.

For files with no issues: \`NO-FINDINGS [filename] — [reason]\`
For test fixtures/runners: \`SKIP [filename] — [fixture|test]\`

Only review SOURCE CODE files in "Changed Files". Skip bundle files (dist/, es/, lib/, .min.js).
Config/tooling files (.figma.ts, .config.ts, storybook, .scss, .css) ARE source — review them.

**Rubric — check each changed file for:**
| # | Check | Cat |
|---|-------|-----|
| 1 | Attribute on wrong element in parent/child pair | 1 |
| 2 | Variant block emits markup identical to default | 2 |
| 3 | Interactive child element missing aria-label | 2 |
| 4 | Module comment contradicts TODO in same file | 2 |
| 5 | TODO references a specific Carbon prop name | 1 |
| 6 | New abstraction introduced but old raw value still read in same hunk | 2 |
| 7 | Abstraction argument can produce non-unique value (e.g. \`id ?? ''\`) | 2 |
| 8 | New/modified interactive element missing aria-label/describedby/alt/role; or \`aria-disabled\` on anchor with unguarded \`href\` | 2 |
| 9 | Type/framework guarantee contradicted by usage: \`!\` + \`?.\` on same field; \`@query\` selector can be empty; \`firstUpdated\` skips super; React hook in condition/loop; unawaited async; keydown without \`defaultPrevented\` check when slot/children present; unsafe DOM cast without instanceof | 2 |
| 10 | Key prop can produce empty string or non-unique value | 2 |
| 11 | Public export/prop/event removed or renamed without deprecation notice | 1 |
| 12 | Icon name or size variant introduced or changed | 1 |
| 13 | New exported function / public method / new runtime behaviour with no test file in "Changed Files" | 2 |
| 14 | Public API surface change with no CHANGELOG/BREAKING_CHANGES entry (only when those files absent from "Changed Files") | 2 |
| 15a | .scss: removed min/max-block-size or min/max-inline-size with no replacement | 2 |
| 15b | .scss: \`+\` line widens selector or adds :not() without scoping modifier class | 2 |
| 15c | .scss: explicit block-size added for some size variants but not others | 2 |
| 15d | .scss: \`convert.to-rem(Npx)\` where N maps to a Carbon \$spacing-* token (16→05, 24→06, 32→07, 40→08, 48→09, 64→10, 80→11) — one entry per call | 2 |

---

## Step 2 — Resolve every pending item

**If Cat1:**

${step2SkillBlock}

${step2McpBlock}

Update to \`confirmed finding\` or \`discarded: [reason]\` (inside \`<think>\`).

**If Cat2:** decide from diff alone → \`confirmed finding\` or \`discarded: [reason]\` (inside \`<think>\`).

No item may remain \`pending\` when you reach Step 3. If any do, resolve them first.
Check whether the rest of the diff compensates for the concern before confirming a finding.

**Valid discard — Cat1:** MCP returned direct evidence (quote from example_clean/props_used/chunk_text) that the API usage is correct.
**Valid discard — Cat2:** Cite the specific diff line (file:line) that resolves the concern and explain why in one sentence.

---

## Step 3 — Compile confirmed findings

**Category rules:**

Cat1 (Carbon-specific) — finding is about Carbon component props, tokens, variants, icons, or accessibility patterns.
- Verify with Step 2a (skill) then Step 2b (MCP). If BOTH yield no evidence, omit entirely.
- \`carbonVerified:true\`, \`verificationSource:"carbon-mcp"\` (or \`"carbon-builder-skill"\` when MCP failed)
- \`skillEvidence\`: verbatim sentence from skill file. \`mcpEvidence\`: verbatim quote from MCP response. Omit if empty.
- "Could this appear on a non-Carbon component in the same framework?" → if YES it is Cat2.

Cat2 (non-Carbon) — generic correctness, accessibility, test coverage, migration visible in the diff.
- Do NOT use MCP or skill files.
- \`carbonVerified:false\`, \`verificationSource:"not-carbon-specific"\`

**Always Cat2 (never Cat1):** Lit lifecycle, React hooks, TypeScript types, event listener patterns, async/await, memory leaks, test coverage, naming.
**Always Cat1 in config/tooling files:** finding about whether a specific attribute name exists on a specific Carbon element.

**Severity:**
- \`blocking\` — breaks user-facing behaviour or a11y requirement, no workaround in diff.
- \`major\` — likely visible rendering difference, runtime error, or production regression.
- \`minor\` — maintainability debt or subtle behaviour difference with evidence of functional impact.
- \`nit\` — conventional/hygiene only, no functional consequence. Token substitutions, missing comments, changelog on non-public APIs, test gaps covered by play() → always \`nit\`.

**body rule:** \`minor\`/\`major\`/\`blocking\` must end with an imperative sentence: what the submitter should do.

---

## Step 4 — Output the JSON

\`summaryMarkdown\`: 1–2 sentences on what the PR does + one sentence on finding count/severity. No emoji, no headings, no verification claims.

\`recommendation\`: \`"consider-revising"\` (any blocking/major) | \`"suggested-improvements"\` (minor only) | \`"looks-good"\` (nit or none).
\`recommendationRationale\`: one sentence, e.g. "4 major findings that should be addressed before merge."

\`carbonVerification\`:
- \`skillConnected\`: true if you physically opened a skill file.
- \`skillProof\`: verbatim sentence from file relevant to this PR. Empty string if false.
- \`mcpConnected\`: true ONLY if a carbon-mcp tool call succeeded.
- \`mcpProof\`: short verbatim snippet from MCP response. Empty string if false.

\`findingsTable\`: one entry per confirmed finding. Plain text only — no pipes, newlines, or backslashes in any field.

BEGIN_REVIEW_JSON
{
  "carbonVerification": {
    "skillConnected": true,
    "skillProof": "implementation-guardrails.md: 'exact sentence read from file'",
    "mcpConnected": true,
    "mcpProof": "short verbatim snippet from MCP response"
  },
  "recommendation": "consider-revising",
  "recommendationRationale": "4 major findings that should be addressed before merge.",
  "summaryMarkdown": "1-2 sentences on what the PR does. N findings: severity breakdown.",
  "findings": [
    {
      "severity": "blocking|major|minor|nit",
      "file": "repo-relative path",
      "line": 123,
      "title": "short title — plain text, no pipes",
      "body": "observation + imperative suggestion (required for minor/major/blocking)",
      "carbonVerified": true,
      "verificationSource": "carbon-mcp|carbon-builder-skill|not-carbon-specific",
      "skillEvidence": "filename: 'verbatim sentence' (Cat1 only, omit for Cat2)",
      "mcpEvidence": "verbatim quote from tool response (Cat1 with MCP only, omit otherwise)"
    }
  ],
  "findingsTable": [
    {
      "area": "Carbon API|General",
      "category": "Cat 1|Cat 2",
      "severity": "blocking|major|minor|nit",
      "title": "short title — plain text only",
      "file": "repo-relative path — plain text only"
    }
  ],
  "shouldPostInlineComments": true
}
END_REVIEW_JSON
`;
}

module.exports = {
  formatSummaryComment,
  formatInlineComment,
  buildReviewPrompt,
  estimateTokenUsage
};

// Made with Bob
