/**
 * Format review comments according to Carbon PR review spec
 */

const constants = require('./constants');
const { CHARS_PER_TOKEN } = constants;
const { MAX_LISTED_FILES } = require('./reviewCoverage');
const { escapeAtSign } = require('./textUtils');
const agents = require('./agents');

/**
 * Estimate token usage for a PR review
 *
 * @param {Object} options - Token estimation options
 * @param {string} options.prompt - Review prompt text
 * @param {string} options.diff - PR diff content
 * @param {string} options.agentOutput - Agent's output
 * @returns {Object} - Token usage estimate { input: number, output: number, total: number }
 */
function estimateTokenUsage({ prompt, diff, agentOutput }) {
  // Rough estimation: 1 token ≈ 4 characters for English text (CHARS_PER_TOKEN from constants)
  const inputChars = (prompt?.length || 0) + (diff?.length || 0);
  const outputChars = agentOutput?.length || 0;

  const inputTokens = Math.ceil(inputChars / CHARS_PER_TOKEN);
  const outputTokens = Math.ceil(outputChars / CHARS_PER_TOKEN);
  const totalTokens = inputTokens + outputTokens;

  return {
    input: inputTokens,
    output: outputTokens,
    total: totalTokens,
  };
}

// ---------------------------------------------------------------------------
// Recommendation labels and submitter-facing advice copy
// ---------------------------------------------------------------------------

const RECOMMENDATION_LABELS = {
  'consider-revising': 'Consider Revising',
  'suggested-improvements': 'Suggested Improvements',
  'looks-good': 'Looks Good',
};

const RECOMMENDATION_ADVICE = {
  'consider-revising':
    'There are issues in this PR that should be addressed before merging. ' +
    'Please review the findings below — the blocking and major items include specific suggestions on what to change.',
  'suggested-improvements':
    'This PR is on the right track. The findings below are suggestions worth considering before or shortly after merging — ' +
    'none are hard blockers, but addressing them would improve correctness or maintainability.',
  'looks-good':
    'No blocking or major issues were found. Any nit-level notes below are entirely optional and provided for completeness.',
};

const SEVERITY_GUIDANCE = {
  blocking: 'Should be resolved before this ships.',
  major: 'Worth addressing before merge.',
  minor: 'Consider addressing — not a hard blocker.',
  nit: 'Optional — provided for completeness.',
};

// Asks for GitHub reactions and replies; GitHub keeps the answers, so nothing is collected here
const INLINE_FEEDBACK_PROMPT =
  '_Rate this finding 👍 / 👎. Replies help us improve._';
const SUMMARY_FEEDBACK_PROMPT =
  '_Was this review helpful? React with 👍 / 👎, or reply with feedback._';

// ---------------------------------------------------------------------------
// formatInlineComment
// ---------------------------------------------------------------------------

/**
 * Format inline review comment for a specific finding
 *
 * @param {Object} finding - Finding object
 * @returns {string} - Formatted inline comment
 */
function formatInlineComment(finding) {
  const guidance = SEVERITY_GUIDANCE[finding.severity] || '';
  let comment = `**${escapeAtSign(finding.title)}**\n\n`;
  comment += `> **[${finding.severity}]** ${guidance}\n\n`;
  comment += escapeAtSign(finding.body) + '\n\n';

  // Only show verification badge for Carbon-specific findings
  if (
    finding.carbonVerified &&
    finding.verificationSource === 'carbon-builder'
  ) {
    comment += `*✓ Verified with Carbon Builder + MCP*\n`;
  } else if (
    finding.carbonVerified &&
    finding.verificationSource === 'carbon-mcp'
  ) {
    comment += `*✓ Verified with Carbon MCP*\n`;
  }

  comment += `\n${INLINE_FEEDBACK_PROMPT}\n`;

  return comment;
}

// ---------------------------------------------------------------------------
// renderNitList / formatLooksGoodComment
// ---------------------------------------------------------------------------

// Title and location only: a nit body is not worth a reader's attention.
function renderNitList(nits) {
  if (!nits || nits.length === 0) return '';
  const items = nits.map((f) => {
    // `<` would let a title such as </details> close the block; a backtick would end the code span
    const title = escapeAtSign(
      String(f.title || '')
        .replace(/\s+/g, ' ')
        .replace(/</g, '&lt;')
        .trim()
    );
    const file = String(f.file || '').replace(/`/g, '');
    const where = file ? ` — \`${file}${f.line ? `:${f.line}` : ''}\`` : '';
    return `- ${title}${where}`;
  });
  const label = `${nits.length} optional nit${nits.length === 1 ? '' : 's'}`;
  return `<details>\n<summary>${label}</summary>\n\n${items.join('\n')}\n\n</details>`;
}

const count = (n) => n.toLocaleString('en-US');

const kb = (chars) =>
  chars < 1e6
    ? `${chars === 0 ? 0 : Math.max(1, Math.round(chars / 1e3))} KB`
    : `${(chars / 1e6).toFixed(1)} MB`;

/**
 * The note that tells an author which files the review did not cover.
 * Empty unless the review was partial.
 *
 * @param {Object} coverage - From the review bundle: the counts, and `omitted` as [{filename, reason}]
 * @param {string} filesUrl - The PR's Files changed URL
 * @returns {string}
 */
// Why the review is partial, in the author's terms: size (the budget, the file cap or
// GitHub's listing limit) or files GitHub gives no diff for.
function coverageReason(coverage, none) {
  const reasons = new Set((coverage.omitted || []).map((o) => o.reason));
  const size =
    reasons.has('over-budget') ||
    reasons.has('over-file-cap') ||
    (coverage.beyond_listing || 0) > 0;
  if (size) {
    return none
      ? 'this pull request is larger than the review budget, so none of its files could be reviewed'
      : 'this pull request is larger than the review budget, so not every file could be reviewed';
  }
  if (reasons.has('no-patch')) {
    return none
      ? 'GitHub provides no diff for any changed file (binary, mode change or too large), so none could be reviewed'
      : 'GitHub provides no diff for some files (binary, mode change or too large), so not every file could be reviewed';
  }
  return none
    ? 'none of its files could be reviewed'
    : 'not every file could be reviewed';
}

function formatCoverageNote(coverage, filesUrl) {
  if (!coverage?.partial) return '';
  // Authors read the note before the numbers, so say why first.
  const none = coverage.diff_chars_reviewed === 0;
  const files = `${count(coverage.files_reviewed)} of ${count(coverage.files_total)} changed files`;
  let note = `> ⚠️ **Partial review:** ${coverageReason(coverage, none)}`;
  if (none) {
    // Not even one line of any file fit: the agent did not run
    note += ` (${files}).\n`;
    note += `> The full set is in the [Files changed](${filesUrl}) tab.`;
  } else {
    note += `.\n> ${files} were reviewed (${kb(coverage.diff_chars_reviewed)} of ${kb(coverage.diff_chars_total)} of diff). Findings cover the reviewed files only;\n`;
    note += `> the full set is in the [Files changed](${filesUrl}) tab.`;
  }

  const omitted = coverage.omitted || [];
  const beyond = coverage.beyond_listing || 0;
  if (omitted.length === 0 && beyond === 0) return note;

  const groups = [
    ['over-budget', 'Over the diff size budget'],
    ['no-patch', 'No diff from GitHub, binary, mode change or too large'],
    ['over-file-cap', `Over the ${constants.MAX_FILES_PER_PR}-file cap`],
  ];
  // GitHub rejects a comment over 65,536 characters, so a long list is cut and counted
  let room = MAX_LISTED_FILES;
  const sections = [];
  for (const [reason, heading] of groups) {
    const names = omitted.filter((o) => o.reason === reason);
    if (names.length === 0) continue;
    const shown = names.slice(0, room);
    room -= shown.length;
    const items = shown.map((o) => `- \`${o.filename.replace(/`/g, '')}\``);
    if (shown.length < names.length) {
      items.push(`- and ${count(names.length - shown.length)} more`);
    }
    sections.push(
      `**${heading} (${count(names.length)})**\n${items.join('\n')}`
    );
  }
  if (beyond > 0) {
    sections.push(
      `**Beyond GitHub's 3,000-file listing (${count(beyond)})**, names unavailable`
    );
  }
  return `${note}\n\n<details>\n<summary>Files not reviewed (${count(coverage.files_omitted)})</summary>\n\n${sections.join('\n\n')}\n\n</details>`;
}

/**
 * The comment for a PR the agent never saw because no file fit the diff budget:
 * a verdict line and the partial note, so the PR is not left without an answer.
 *
 * @param {Object} options
 * @param {string} options.commitSha - Head commit SHA
 * @param {Object} options.coverage  - From the review bundle
 * @param {string} options.filesUrl  - The PR's Files changed URL
 * @returns {string}
 */
function formatNotReviewedComment({ commitSha, coverage, filesUrl }) {
  return `[AI agent review — Carbon grounded] · **Not Reviewed** · Commit: ${commitSha.substring(0, 7)}\n\n${formatCoverageNote(coverage, filesUrl)}\n`;
}

/**
 * The comment for a clean PR: a verdict line, the agent's summary and, when
 * there are nits, a collapsed list. Nothing else, so a clean PR reads as quiet.
 *
 * @param {Object}  options
 * @param {string}  options.agent             - Agent id (an id from src/agents)
 * @param {string}  [options.agentName]       - Name shown in the comment; defaults to the id
 * @param {string}  options.summaryMarkdown   - Agent's 1-3 sentence summary
 * @param {string}  options.commitSha         - Head commit SHA
 * @param {Array}   [options.nitFindings]     - Findings listed in the collapsed block
 * @param {Object}  [options.coverage]        - Review coverage; a partial review adds its note
 * @param {string}  [options.filesUrl]        - The PR's Files changed URL, linked from that note
 * @returns {string}
 */
function formatLooksGoodComment({
  agent,
  agentName = agent,
  summaryMarkdown,
  commitSha,
  nitFindings = [],
  coverage = null,
  filesUrl = '',
}) {
  const parts = [
    `[AI agent review — Carbon grounded] · **${RECOMMENDATION_LABELS['looks-good']}** · Reviewed by: ${agentName} · Commit: ${commitSha.substring(0, 7)}`,
    escapeAtSign(summaryMarkdown),
  ];
  const coverageNote = formatCoverageNote(coverage, filesUrl);
  if (coverageNote) parts.push(coverageNote);
  const nits = renderNitList(nitFindings);
  if (nits) parts.push(nits);
  return parts.join('\n\n') + '\n';
}

// ---------------------------------------------------------------------------
// formatSummaryComment
// ---------------------------------------------------------------------------

/**
 * Format summary comment with spec-compliant template.
 *
 * All new parameters have safe defaults so existing call sites continue to
 * work without modification — no silent undefined in rendered output.
 *
 * @param {Object}  options
 * @param {string}  options.agent                - Agent id (an id from src/agents)
 * @param {string}  [options.agentName]           - Name shown in the comment; defaults to the id
 * @param {string}  options.summaryMarkdown       - Agent's 1-2 sentence summary (never mutated)
 * @param {number}  options.prNumber              - PR number
 * @param {string}  options.commitSha             - Head commit SHA
 * @param {Array}   [options.inlineFindings]      - Findings posted as inline comments
 * @param {Array}   [options.summaryFindings]     - Findings included in summary
 * @param {Object}  [options.tokenUsage]          - Token usage { input, output, total }
 * @param {string}  [options.recommendation]      - 'consider-revising'|'suggested-improvements'|'looks-good'
 * @param {string}  [options.recommendationRationale] - One sentence from computeRecommendation
 * @param {string|null} [options.catalogueWarning] - Non-null when agent skipped Step 1 catalogue
 * @param {Array}   [options.findingsTable]       - Typed array from parser: [{area,category,severity,title,file}]
 * @param {Array}   [options.nitFindings]         - Nit findings, listed collapsed after the summary
 * @param {Object}  [options.coverage]            - Review coverage; a partial review adds its note
 * @param {string}  [options.filesUrl]            - The PR's Files changed URL, linked from that note
 * @returns {string} - Formatted summary comment
 */
function formatSummaryComment({
  agent,
  agentName = agent,
  summaryMarkdown,
  prNumber,
  commitSha,
  inlineFindings = [],
  summaryFindings = [],
  tokenUsage = null,
  recommendation = 'looks-good',
  recommendationRationale = '',
  catalogueWarning = null,
  findingsTable = [],
  nitFindings = [],
  coverage = null,
  filesUrl = '',
}) {
  const recLabel = RECOMMENDATION_LABELS[recommendation] || recommendation;
  const recAdvice = RECOMMENDATION_ADVICE[recommendation] || '';

  let comment = `[AI agent review — Carbon grounded] · **${recLabel}**\n\n`;
  comment += `Reviewed by: ${agentName} · Commit: ${commitSha.substring(0, 7)}\n`;
  comment += `Carbon verification: Carbon-specific claims verified using Carbon Builder skill (primary authority) and Carbon MCP (fallback).\n\n`;

  // ── Recommendation section ─────────────────────────────────────────────
  comment += `## Recommendation\n\n`;
  if (recommendationRationale) {
    comment += `${recommendationRationale}\n\n`;
  }
  comment += `${recAdvice}\n\n`;

  const coverageNote = formatCoverageNote(coverage, filesUrl);
  if (coverageNote) comment += coverageNote + '\n\n';

  // ── Catalogue reliability warning (rendered separately — never in summaryMarkdown) ──
  if (catalogueWarning) {
    comment += `> ⚠️ **Review Reliability Note:** ${catalogueWarning}\n\n`;
  }

  // ── Findings table (rendered from typed array — no Markdown in agent JSON) ──
  // Nits are listed once, in the collapsed nit list
  const rows = (findingsTable || []).filter((r) => r.severity !== 'nit');
  if (rows.length > 0) {
    comment += `<details>\n<summary>Findings (${rows.length})</summary>\n\n`;

    // Legend for the Category column.
    //
    // "Cat 1" and "Cat 2" are internal shorthand: they tell a reader HOW a
    // finding was established, which is the difference between a claim checked
    // against Carbon's own source and one inferred from the diff. Without this
    // the column is an unexplained label on a comment posted to contributors
    // who have never seen this agent before.
    //
    // Placed above the table rather than below it, because the distinction
    // changes how much weight to give each row while reading them.
    comment += `**Category** — how each finding was established:\n\n`;
    comment += `- **Cat 1** — a Carbon-specific claim (does this component accept this prop, attribute or variant?), verified against the Carbon Builder skill or Carbon MCP.\n`;
    comment += `- **Cat 2** — generic correctness, accessibility or duplication, established from the diff alone.\n\n`;

    comment += `| Area | Category | Severity | Finding | File |\n`;
    comment += `|------|----------|----------|---------|------|\n`;
    for (const row of rows) {
      // Sanitise cell values: strip pipes and newlines, then escape @ signs
      const safe = (v) =>
        escapeAtSign(
          String(v || '')
            .replace(/[|\n\r]/g, ' ')
            .trim()
        );
      comment += `| ${safe(row.area)} | ${safe(row.category)} | ${safe(row.severity)} | ${safe(row.title)} | ${safe(row.file)} |\n`;
    }
    comment += '\n</details>\n\n';
  }

  // ── Agent summary (verbatim — this field is never mutated after parse) ──
  comment += `## Summary\n\n`;
  comment += escapeAtSign(summaryMarkdown) + '\n\n';

  const nitList = renderNitList(nitFindings);
  if (nitList) comment += nitList + '\n\n';

  // Outside Details so it shows without expanding anything
  comment += SUMMARY_FEEDBACK_PROMPT + '\n\n';

  // ── Details dropdown — open (unconditional) ─────────────────────────────
  comment += '\n<details>\n<summary>Details</summary>\n\n';

  // ── Additional findings that couldn't be posted inline ─────────────────
  if (summaryFindings && summaryFindings.length > 0) {
    comment += `## Additional Findings\n\n`;
    comment += `The following findings could not be mapped to specific lines in the diff:\n\n`;

    summaryFindings.forEach((finding, index) => {
      const guidance = SEVERITY_GUIDANCE[finding.severity] || '';
      comment += `### ${index + 1}. ${escapeAtSign(finding.title)}\n\n`;
      comment += `**File:** \`${finding.file}\``;
      if (finding.line) {
        comment += ` (Line ${finding.line})`;
      }
      comment += `\n**Severity:** ${finding.severity} — ${guidance}\n\n`;
      comment += escapeAtSign(finding.body) + '\n\n';

      if (
        finding.carbonVerified &&
        finding.verificationSource === 'carbon-builder'
      ) {
        comment += `*✓ Verified with Carbon Builder + MCP*\n\n`;
      } else if (
        finding.carbonVerified &&
        finding.verificationSource === 'carbon-mcp'
      ) {
        comment += `*✓ Verified with Carbon MCP*\n\n`;
      }

      comment += '---\n\n';
    });
  }

  // ── Review artifacts ────────────────────────────────────────────────────
  comment += `Review artifacts:\n`;
  comment += `- PR: #${prNumber}\n`;
  comment += `- Commit: ${commitSha.substring(0, 7)}\n`;
  comment += `- Agent: ${agentName}\n`;

  if (inlineFindings && inlineFindings.length > 0) {
    comment += `- Inline comments: ${inlineFindings.length}\n`;
  }
  if (summaryFindings && summaryFindings.length > 0) {
    comment += `- Summary findings: ${summaryFindings.length}\n`;
  }

  // ── Token usage ─────────────────────────────────────────────────────────
  if (tokenUsage) {
    // Counts from the agent's result record are exact; 'estimate' or no source is not.
    const exact = !!tokenUsage.source && tokenUsage.source !== 'estimate';
    const approx = exact ? '' : '~';
    comment += `\n---\n\n`;
    comment += `**${exact ? 'Token Usage' : 'Estimated Token Usage'}:**\n`;
    comment += `- Input tokens: ${approx}${tokenUsage.input.toLocaleString()}\n`;
    comment += `- Output tokens: ${approx}${tokenUsage.output.toLocaleString()}\n`;
    comment += `- Total tokens: ${approx}${tokenUsage.total.toLocaleString()}\n`;
    if (!exact) {
      comment += `\n*Note: Token estimates are approximate and based on character count (1 token ≈ 4 characters).*\n`;
    }
  }

  // ── Details dropdown — close (unconditional, outside all conditionals) ───
  comment += '\n</details>\n';

  // ── AI disclaimer ────────────────────────────────────────────────────────
  comment += `\n---\n\n`;
  comment += `*An AI agent generated this review. Human review is advised before acting on any findings.*\n`;

  return comment;
}

// ---------------------------------------------------------------------------
// buildReviewPrompt
// ---------------------------------------------------------------------------

/**
 * Build the prompt for the AI agent
 *
 * @param {Object} options - Prompt options
 * @param {string} options.owner - Repository owner
 * @param {string} options.repo  - Repository name
 * @param {string} [options.agent] - Adapter id; the registry default (Bob) when omitted
 * @returns {string} - Formatted prompt
 */
function buildReviewPrompt({ owner, repo, agent }) {
  const { noCompletion, noFileWrite, skillPath, readTool } = agents.get(
    agent || agents.DEFAULT_ID
  ).promptFragments;
  return `You are an agentic PR reviewer for ${owner}/${repo}.

**OUTPUT CONTRACT — read before starting:**
1. Write catalogue lines to your visible response (not inside <thinking>) — the parser checks for them.
2. ${noCompletion} at any point — writing the JSON block between BEGIN_REVIEW_JSON and END_REVIEW_JSON markers IS the completion step.
3. Do not end your response without the JSON block, even when findings is an empty array.
4. After resolving each pending catalogue item, write a new visible line — either \`confirmed finding — [title]\` or \`discarded: [reason]\` — immediately after it. Do not rely on <thinking> to resolve pending items. A run where pending items appear in the catalogue but no resolution lines appear will be flagged as unreliable.
5. ${noFileWrite} at any point. Writing to a file does not satisfy the output contract — the JSON block must appear in your visible response text.

## Step 1 — Read and catalogue the diff (do this before forming any opinion)

Read PR_REVIEW_REQUEST.md. It contains the PR description, changed files list, and the full diff in one place. You do not need to read pr.json, files.json, or diff.patch separately.

If a \`## Linked Issue Context\` section is present, read it before cataloguing — it provides background context for the change. Do not use the linked issue context or the PR description to assess whether the PR is complete or delivers everything the issue requires. Use both only as background context when evaluating individual code changes.

As you read each file, write one line per suspicious item in this format:
\`[file:line] — [what you saw] — [Category 1 / Category 2] — pending\`

The \`line\` number in \`[file:line]\` must be the line number of the \`+\` line you are referencing **as it appears in the diff** (i.e. the new-file line number from the \`@@\` hunk header, counting forward from the hunk's \`+\` start). Do not use memorised or inferred line numbers from the full repository file — only use numbers you can derive by counting the \`+\` and context lines visible in the diff.

Category 1 = the finding is about whether a specific Carbon element accepts a specific attribute, prop, or variant — OR whether a specific quoted string argument value is valid for a Carbon utility mixin must verify with Carbon Builder skill.
Category 2 = generic correctness, accessibility omission, or duplicate markup visible from the diff alone — no MCP needed.

Examples of the format (not exhaustive — apply to any change you see):
\`overflow-menu.figma.ts:33 — menu-alignment on <cds-overflow-menu>, body child element exists — Category 1 — pending\`
\`combo-button.figma.ts:46 — Open:True variant identical to default — Category 2 — pending\`
\`time-picker.figma.ts:31 — <cds-time-picker-select> children, no aria-label — Category 2 — pending\`

Do not skip files. Do not stop cataloguing because the changes look safe. Complete the catalogue for ALL files first. When writing a catalogue entry for a concern that could be resolved by the presence of a default value, guard, or compensating constraint, check the remaining \`+\` lines in the same file's diff hunks before writing \`pending\`. If a \`+\` line in the same file directly addresses the concern (e.g. sets a non-empty default for the same prop, adds the missing guard, or restores the removed constraint), write \`discarded: [quoted line] — compensating fix present in same diff\` instead of \`pending\`. Do not catalogue a concern as \`pending\` when its resolution is already visible in the current file's diff.

You may skip a file without a catalogue entry ONLY if it is a test fixture (__testfixtures__ path) or a test runner file (__tests__ path). For every skipped file write exactly:
\`SKIP [filename] — [fixture|test]\`

All other files require at least one catalogue entry or an explicit \`NO-FINDINGS [filename] — [one-sentence reason]\` line. **Exception:** a \`NO-FINDINGS\` line may not be used to dismiss a file or block that contains a \`+\` line with an \`as SomeType\` cast applied to the return value of a DOM collection or search API (\`children\`, \`querySelector\`, \`querySelectorAll\`, \`assignedElements\`, \`assignedNodes\`, \`firstElementChild\`, \`lastElementChild\`, \`nextElementSibling\`, or \`.find()\`/\`.filter()\` on such a collection) without a preceding \`instanceof\` check on the cast target — such a cast must produce a catalogue entry (pending or discarded). **Do not apply this exception to** \`event.target as X\` or \`event.currentTarget as X\` casts, or to casts on values already inside an \`instanceof\` block — those are safe and may be covered by \`NO-FINDINGS\`. A \`NO-FINDINGS\` line may also not be used to dismiss a stories file that contains a \`+\` line adding an \`argTypes\` entry with a \`table:\` property — every such key must produce a catalogue entry (a fast-discard under Step A or a pending entry for Step B of the documented-as-API check). The key's apparent purpose (e.g. "this controls text content") is not a valid reason to bypass this requirement. A \`NO-FINDINGS\` line may also not be used to dismiss a file that contains a \`+\` line with an unbalanced string literal as described in rule 9b — such a line must produce a catalogue entry.

**Write every catalogue and NO-FINDINGS line in your visible response — not inside <thinking>.** The downstream parser inspects the text before BEGIN_REVIEW_JSON for these exact formats. A run where none appear will be marked unreliable and flagged to the reviewer regardless of what the findings array contains.

Review all files listed under "Changed Files" in PR_REVIEW_REQUEST.md. Do NOT review bundle files (e.g. files under dist/, es/, lib/, or ending in .min.js).

Configuration and tooling source files (e.g. \`.figma.ts\`, \`.config.ts\`, storybook files) and style files (\`.scss\`, \`.css\`, \`.less\`) are in scope — review them. A file being declarative or additive does not exempt it from review.

For documentation files (\`.md\`, \`.txt\`, \`.rst\`), the only applicable checks are spelling and grammar — do not apply code rubric rules (1–18) to prose content.

**Figma Code Connect context:** Code Connect files are the source of truth for what code developers copy-paste from Figma. A wrong attribute name means every developer who uses that snippet ships broken code. A missing \`aria-label\` means every copied snippet is inaccessible. A duplicate variant means the Figma variant produces no distinct code output — the variant mapping is useless. These are not documentation nits — they are correctness and accessibility bugs with real downstream impact.

For configuration and tooling files that reference Carbon APIs, look specifically for:
1. **Attribute placement** — attributes set on the wrong element in a parent/child pair (placement or direction on a trigger instead of a body/panel element) — **Category 1** (requires MCP)
2. **Duplicate variant examples** — a variant block that emits markup identical to the default with no public API difference (e.g. \`variant: { Open: 'True' }\`, \`variant: { Expanded: 'True' }\`) — **Category 2** (diff-visible, no MCP needed)
3. **Missing accessibility attributes** — interactive child elements (selects, inputs, buttons inside a parent) that omit \`aria-label\` or similar attributes — **Category 2** (diff-visible, no MCP needed)

**Storybook stories context:** The Storybook docs/API tab is the live API reference developers consult when evaluating a component. An arg key registered with a \`table:\` property in \`argTypes\` appears in that tab as a component prop. A key that does not exist on the component's public API teaches developers the wrong prop surface — this is a correctness bug with real downstream impact, not a documentation nit. A \`table:\`-less control entry (an \`argTypes\` entry with no \`table:\` property) is a story-internal control intentionally excluded from the docs table — do not flag those.

For codemod and transform files (e.g. files under transforms/, codemods/), look specifically for:
4. **Contradictory inline guidance** — a module-level comment that claims X and a TODO or inline comment in the same file that claims the opposite of X — **Category 2** (diff-visible, no MCP needed)
5. **Prop names in migration guidance** — a TODO or comment directing users to use a specific prop name on a Carbon component — **Category 1** (verify the prop name exists via MCP)

For any source file where the diff introduces a new normalising abstraction (a hook, a computed object, or a helper that replaces direct prop/attribute access — e.g. \`const normalizedProps = useNormalizedInputProps(...)\`, \`const computed = { disabled: ... }\`), look specifically for:
6. **Partial migration** — the diff introduces the abstraction and updates some references, but other \`-\` or context lines in the same diff hunks still read the original raw value (e.g. a \`-\` line inside a changed hunk still checking \`!disabled\` directly instead of \`normalizedProps.disabled\`) — **Category 2** (diff-visible, no MCP needed). Only flag uses visible in the diff's \`+\`, \`-\`, or hunk context lines — do not infer or speculate about code outside the shown hunks.
7. **Unsafe fallback in abstraction arguments** — the new abstraction is called with a fallback that can produce a non-unique value across instances (e.g. \`id ?? ''\` when the abstraction derives DOM IDs from that argument, risking duplicate IDs when the prop is omitted) — **Category 2** (diff-visible, no MCP needed).

In addition, for EVERY changed source file apply these rubric checks during the same per-file pass (do not loop files a second time):

8. **Generic accessibility omissions** — interactive elements (button, select, input, a with no text, img) that are new or modified in the diff and lack aria-label, aria-describedby, alt, or required role — **Category 2** (diff-visible, no MCP needed). In addition, flag: \`aria-disabled={true}\` (or an expression that evaluates to \`true\` when disabled, e.g. \`disabled ? true : undefined\`) added to a **non-form-control element** (i.e. NOT a native \`button\`, \`input\`, \`select\`, or \`textarea\` — these already block interaction via the HTML \`disabled\` attribute), when the same diff hunk also shows \`href={...}\` on that element as a \`+\` line or context line and no line in the same hunk removes \`href\` conditionally (e.g. \`href={disabled ? undefined : url}\`) — \`aria-disabled\` announces the item as disabled to screen readers but does NOT prevent navigation or activation; the anchor will still navigate on click. **Do not flag** when native \`disabled\` is also present on the element (button, input, select, textarea), and do not flag when \`href\` is removed or guarded in the same hunk.
9. **TypeScript / framework correctness** — the principle is: does the diff introduce a type annotation or framework call whose guarantee is immediately contradicted by how it is used? Flag it. The following are examples, not an exhaustive list — apply the principle to any pattern you see:
   - \`!\` non-null assertion on a field that is immediately accessed with \`?.\` optional chaining (or vice versa) — the two are contradictory: either the value can be null/undefined (\`?.\` is correct, \`!\` is a lie to the compiler) or it cannot (\`!\` is correct, \`?.\` is unnecessary noise that masks a real invariant violation)
   - \`@query\` decorator used on a field typed as \`HTMLElement\` but the selector can match zero elements at runtime (e.g. a named slot or conditional child)
   - \`firstUpdated\` override that does not call \`super.firstUpdated()\`
   - \`updateComplete\` awaited without \`await\` (i.e. the promise is dropped)
   - React hook called inside a condition, loop, or nested function
   - \`async\` function whose returned promise is never awaited or \`.catch\`-ed at the call site
   - A new or modified \`keydown\`/\`keyup\`/\`keypress\` handler that reacts to a specific key (e.g. \`event.key === 'Escape'\`) **without checking \`event.defaultPrevented\`**, when all three of the following are visible in the diff: (1) the handler is on a component whose render output or shadow-DOM template passes \`children\` or includes a \`<slot>\` element — meaning the caller supplies the nested content; the slot or children must be reachable on the same element the handler is attached to or a direct ancestor of it — a slot on a sibling or unrelated element in the same template (e.g. a decorative icon slot on a separate wrapper div) does not satisfy this condition; (2) the handler fires on that specific key; (3) the handler body contains no reference to \`event.defaultPrevented\`. A child component inside the slot/children can handle the same key for its own dismiss behaviour and call \`event.preventDefault()\`, but without this guard the event still bubbles and closes the outer component too. **Do not flag** handlers on leaf elements (button, input, select, textarea) whose children are fixed by their own template, and do not flag handlers that already reference \`event.defaultPrevented\`.
   - \`as SomeSubtype\` cast applied to the return value of a DOM search or collection API (\`querySelector\`, \`querySelectorAll\`, \`assignedElements\`, \`assignedNodes\`, \`children\`, \`firstElementChild\`, \`lastElementChild\`, \`nextElementSibling\`) to access a method or property that does not exist on the declared return type (e.g. \`assignedElements()[0] as HTMLElement\` to call \`.focus()\` when \`Element\` has no \`.focus()\`), with no preceding \`instanceof\` check — the cast silences a compile error instead of narrowing safely. **Do not flag** \`event.target as X\` or \`event.currentTarget as X\` (the handler's attachment point gives runtime certainty of the subtype), and do not flag casts on values already inside an \`instanceof\` block.
   - This check is always **Category 2** regardless of file type — framework behaviour is never Carbon-specific
9b. **Unbalanced string literal** — for every \`+\` line containing a single-quoted (\`'...'\`) or double-quoted (\`"..."\`) string value in a property assignment (\`key: 'value'\`) or JSX attribute (\`prop="value"\`), verify the outer quote characters are balanced. Flag when a closing quote is immediately followed by another identical quote with no operator between them (e.g. \`'callout-title-interactive''\` — the string closes at the first \`'\` and the second \`'\` is a syntax error). This causes a \`SyntaxError\` that prevents the entire file from loading. — **Category 2**, severity **blocking**.

   **Do not flag:**
   - Content inside template literals (backtick strings) — single or double quotes inside backticks are always valid
   - Escaped quotes (\`\\'\` or \`\\"\`) — these are intentional and valid
   - An apostrophe inside a double-quoted string or vice versa (e.g. \`"it's fine"\`) — outer delimiters are different, so it is balanced
   - Lines that are comments (\`//\`, \`/*\`, \` * \`) — quotes in comments are not string literals
   - A string that intentionally spans multiple \`+\` lines (i.e. a \`+\` line with an opening quote but no closing quote, followed by another \`+\` line with the closing quote) — these are multi-line continuations, not syntax errors

10. **Unsafe ID / key fallback** — any new abstraction argument or JSX key prop that can produce an empty string or non-unique value across instances (e.g. \`id ?? ''\`, \`key={index}\` on reorderable lists) — **Category 2** (diff-visible, no MCP needed)
11. **Breaking API change without deprecation** — a public export, required prop, or event name removed or renamed in the diff with no deprecation notice or migration comment — **Category 1** (verify the prior API contract via MCP before filing)
12. **Icon name or size verification** — an icon name or size variant introduced or changed in the diff (e.g. \`Add16\`, \`<AddIcon size={20} />\`) — **Category 1** (verify the icon and size exist via MCP code_search with asset_type: "icon")
13. **Test coverage gap** — For every changed source file, determine: does this diff introduce a new exported function, new public method, or clearly new runtime behaviour? If yes, check whether the "Changed Files" list contains a corresponding \`__tests__\`, \`.test.\`, or \`.spec.\` file for the changed source. If no test file is present AND new behaviour was introduced, this is a catalogue item. You may discard it only if you can quote a specific diff line showing the new code is covered by an existing inline test or the change is a pure refactoring with no new code paths. **Do not state that test files exist in the changed files list unless you have verified this by reading the "Changed Files" section of PR_REVIEW_REQUEST.md.** When a test file is present, also verify that the suite containing the new test is not disabled — check both the diff context lines and hunk headers (\`@@ ... @@ xdescribe\`) surrounding the new test for \`xdescribe\`, \`xit\`, \`test.skip\`, or \`describe.skip\`; a disabled suite or test means the new test will never run and is not valid coverage.

**Storybook play() functions count as interaction tests** — do not file a test-coverage finding solely because a separate \`__tests__\` file is absent when a \`play()\` block is present in the same diff covering the changed behaviour. This discard applies to the test-coverage concern only — it does not exempt the file from any other rubric check.

**Stories-file default export change (independent of test coverage)** — if the diff adds or modifies \`args:\` or \`argTypes:\` on the default export of a stories file, check whether this silently changes the rendered output of all existing stories in that file that do not override those values. If yes, this is a catalogue item (new implicit runtime behaviour affecting existing stories). A \`play()\` block does not discharge this check. You may discard this item only if you can quote a specific diff line showing all existing stories in the file already explicitly override the changed args. — **Category 2**

**Stories-file documented-as-API check** — when a \`+\` line adds a key to an \`argTypes\` entry (directly or inside a named object that is spread into story \`argTypes\`) and that entry contains a \`table:\` property, the arg key is being registered in the Storybook docs/API table as a component prop. For every such key, perform this two-step classification:

**Step A — fast-discard (Category 2, no MCP):** Search all \`+\` lines anywhere in the same file for an unambiguous prop-binding of this key on a Carbon element — i.e. the key appears in one of these exact syntaxes inside an element's opening tag (not inside element children):
- React JSX: \`keyName={expression}\` on a \`<ComponentName>\` opening tag
- Lit property binding: \`.keyName=\${expression}\` on a \`<cds-element>\` opening tag
- Lit boolean attribute: \`?keyName=\${expression}\` on a \`<cds-element>\` opening tag
- Lit plain attribute: \`keyName=\${expression}\` or \`keyName="value"\` on a \`<cds-element>\` opening tag

If such a line exists and the binding is on the same Carbon component being demonstrated by the story (i.e. the component the story is about, visible from imports or element names), discard immediately — **Category 2** — and quote the exact \`+\` line. No MCP call needed.
**Do not** trigger the fast-discard when the key appears only inside element children (\`>{keyName}<\` or \`\${keyName}\` between tags), as a function call argument, or in a spread — these are not prop bindings and do not self-evidence the prop exists on the component.
**Do not** apply the fast-discard for one story's binding to discharge the same key in a different story's \`argTypes\` if that other story does not also have a visible prop-binding for the key — catalogue and assess each story's \`argTypes\` independently.
**If Step A finds no unambiguous prop-binding, you MUST proceed to Step B — you may not discard on the basis that the key controls text content, is a render-function convenience variable, or is "story-internal" by purpose. The \`table:\` property is the only signal that matters: if it is present and Step A finds no prop binding, Step B is mandatory, not optional.** **If the story's render function or template contains no \`cds-\` element opening tag and no PascalCase component whose import line in the same file contains \`@carbon/react\`, \`@carbon/web-components\`, or \`carbon-components\`**, Step A produces no fast-discard regardless — the absence of a Carbon component does not mean the check is inapplicable. Proceed directly to Step B. The story's \`title:\` field (e.g. \`'Components/Notification'\`) identifies the component whose API is being documented; use that name for the Step B MCP search.

**Step B — MCP required (Category 1):** If Step A finds no unambiguous prop-binding, catalogue as Category 1 pending. Run \`code_search\` for the demonstrated component name. If the key appears in any \`example_clean\` or \`props_used\` field across any framework variant in the results, discard — quote the verbatim field value. If MCP returns at least one variant result for the component and the key does not appear in any \`example_clean\` or \`props_used\` field across all returned variants, confirm as **minor** — absence from all indexed examples is evidence of absence for a named prop. Do NOT apply the "props_catalog is not exhaustive" guard to this check: that guard protects against filing on props_catalog absence alone; this check requires absence from example_clean and props_used across all returned variants, which is a stronger and independent signal. **If MCP responds successfully but returns zero variant results** for the component name (distinct from a tool call failure, which is covered by the MCP unavailability rule): before concluding the component is not indexed, run one \`docs_search\` for the component name. If \`docs_search\` also returns nothing, discard as \`'component not indexed in MCP — cannot verify'\` — do not confirm a finding when no MCP evidence of any kind exists for the component. If \`docs_search\` returns results confirming the component exists in Carbon, treat as if MCP returned at least one variant result and apply the standard Step B confirmation rule (key absent from all indexed examples → confirm as minor).

**Scope:** Catalogue from the definition site of the key (the named object or inline \`argTypes\` block where the \`table:\` property appears) — not from each spread site. A spread of a named object that has already produced a catalogue entry at its definition is not a second catalogue entry.
**Do not flag** arg keys that have no \`table:\` property in their \`argTypes\` entry — those are story-internal controls intentionally excluded from the docs table.

14. **Changelog / API hygiene** — a public API surface changes (component added, prop added/removed, event renamed) with no entry in a changelog or breaking-changes file. **Scope: apply this check only when NO \`CHANGELOG\`, \`CHANGELOG.md\`, \`BREAKING_CHANGES\`, or \`BREAKING_CHANGES.md\` file appears in the "Changed Files" list.** — **Category 2**

15. **SCSS structural correctness** — applies to every changed \`.scss\` file. During the same per-file pass, check:
   a. **Removed sizing constraint with no replacement** — a \`-\` line removes a \`min-block-size\`, \`max-block-size\`, \`min-inline-size\`, or \`max-inline-size\` rule and no \`+\` line in the same file's diff hunks restores an equivalent constraint. Before filing, check whether a compensating rule appears elsewhere in the same diff. If one exists, discard: quote it. — **Category 2**
   b. **Unscoped selector broadening** — a \`+\` line adds a \`:not(...)\` exclusion or widens a selector without scoping to a modifier class (e.g. \`--sticky-header\`, \`--condensed\`). This is always **Category 2** — do not treat as Rule 11 (breaking API change), which requires MCP. When a single \`+\` line contains multiple selector changes — some narrowing (e.g. adding a parent combinator \`tr:not([...]) >\`) and some broadening (e.g. adding \`:not(.class)\` to an existing exclusion chain) — catalogue and assess each change independently. A narrowing change on the same line does not discharge a broadening change on the same line.
   c. **Incomplete size-variant set** — the diff adds or modifies explicit \`min-block-size\` or \`block-size\` rules for some size variants (xs/sm/md/lg/xl) but leaves others unaddressed with no inline comment. Check the whole file's diff before filing — do not flag if a variant's row height is intentionally inherited. — **Category 2**
   d. **Hardcoded size value where a Carbon spacing token exists** — a \`+\` line or retained context line in the same hunk uses \`convert.to-rem(Npx)\` for a value that maps exactly to a Carbon \`$spacing-*\` token. Use this lookup: 16px=\`$spacing-05\`, 24px=\`$spacing-06\`, 32px=\`$spacing-07\`, 40px=\`$spacing-08\`, 48px=\`$spacing-09\`, 64px=\`$spacing-10\`, 80px=\`$spacing-11\`. Suggest the token. Also flag retained \`convert.to-rem()\` calls in unchanged context lines of the same hunk if a token equivalent exists — the PR is an opportunity to clean them. — **Category 2** (token hygiene is diff-visible; no MCP needed). **This check produces a separate catalogue entry for each \`convert.to-rem()\` call — write it as a distinct line in your catalogue alongside any structural entry for the same line. A structural discard (e.g. discarding 15a because a compensating rule exists) does not also discharge this 15d entry. Resolve each independently.**
   e. **Carbon mixin argument verification** — a \`+\` line calls a Carbon utility mixin (e.g. \`focus-outline\`, \`type-style\`, \`breakpoint\`, \`motion\`, \`layer\` — identifiable by no namespace prefix and a known Carbon utility name) with a **quoted string literal** argument (e.g. \`focus-outline('outline-lg')\`, \`type-style('body-01')\`). Do NOT trigger on \`$variable\` arguments — those are token references, not string literals, and are already Carbon-validated by convention.
   Before filing: scan all \`+\` lines across every changed file in the diff. If the mixin definition or the new argument value appears as a \`+\` line anywhere in the diff (i.e. this PR is introducing the argument itself), discard — the argument is being defined here and MCP will not have it yet.
   If the mixin definition is external (not introduced by this diff): use \`code_search\` querying the mixin name alone (e.g. \`focus-outline\`). Inspect the returned usage examples or mixin body for the list of valid argument values. If the specific quoted string does not appear in any returned result, confirm as minor — absence of the string in MCP results IS evidence of absence for a named string argument. Do not discard based on partial or unrelated MCP results.
   15d and 15e are independent checks — a 15e discard does not discharge a 15d finding about hardcoded values inside the same block, and vice versa. — **Category 1**

16. **New option not applied to all code paths** — when a \`+\` line adds a new parameter or option to an existing function and that parameter affects a sizing, flow, or visibility decision (i.e. it is used in a comparison, accumulation, or conditional that controls which items are shown or how space is measured), check whether any \`if\` guard or early-return that executes before the parameter is first read in the function body would produce a different result if the parameter were applied there. If such a guard exists and the parameter would change its outcome, this is a catalogue item.

   **Do not flag** purely cosmetic or logging parameters (e.g. a new \`verbose\` flag, a label string).
   **Valid discard:** quote the parameter's default value from the diff and show in one sentence that substituting the default into the early-exit branch produces the same result as the current branch (e.g. \`offsetValue = 0\` subtracted from available space is a no-op, so the early exit is safe). The default value must appear as a \`+\` line in the diff — do not assume a default.
   **This check is distinct from Rule 6** (partial migration of a normalising abstraction) — Rule 16 applies to any new parameter on any function, not only hooks or computed objects. — **Category 2**

17. **DOM measurement box-model double-count** — when a \`+\` line reads a DOM measurement API result and then **adds** a CSS property value to it, check whether the measurement API already includes that property using this lookup:

   | API | Includes padding | Includes border | Includes margin |
   |-----|-----------------|-----------------|-----------------|
   | \`getBoundingClientRect().width/height\` | ✓ yes | ✓ yes | ✗ no |
   | \`offsetWidth\` / \`offsetHeight\` | ✓ yes | ✓ yes | ✗ no |
   | \`clientWidth\` / \`clientHeight\` | ✓ yes | ✗ no | ✗ no |
   | \`scrollWidth\` / \`scrollHeight\` | ✓ yes | ✗ no | ✗ no |

   **Do not flag** subtraction of a CSS property from a measurement result — subtracting an included property is valid arithmetic (e.g. removing padding from a border-box value to get the content width).

   If a \`+\` line adds a property the API already includes (e.g. adding \`paddingLeft\` on top of \`getBoundingClientRect().width\`), that is a double-count — catalogue it using this exact format:
   \`[file:line] — Rule 17: [API call] + [CSS property] — [property] is included per box-model table — Category 2 — pending\`
   Example: \`overflowHandler.ts:38 — Rule 17: getBoundingClientRect()[dimension] + paddingLeft — padding included per table row 1 — Category 2 — pending\`

   **Do not flag** \`getComputedStyle(el).width/height\` — this returns the CSS computed value for that single property and does NOT bundle padding, border, or margin. Adding those separately on top of a \`getComputedStyle\` result is correct.
   **Do not flag** additions of \`marginLeft\`/\`marginRight\`/\`marginTop\`/\`marginBottom\` on top of any API in the table above — margins are excluded from all four APIs, so adding them is correct.
   **Valid discard:** quote the specific measurement API call and the CSS property being added, then cite the exact table row and column (e.g. "getBoundingClientRect row, Includes padding = ✓ yes") showing the property is included — this is what makes it a double-count. Discarding by answering a different question about the same block (e.g. "parseInt is correct for CSS values", "the arithmetic is valid") is an **invalid discard reason** for this rule — each Rule 17 pending item must be resolved by directly addressing the box-model inclusion question. — **Category 2**

18. **Doc/signature mismatch** — applies in two sub-cases; check both during the same per-file pass:

   a. **JSDoc mismatch in source files** — when a \`+\` or \`-\` line modifies a function signature (parameter type, return type, or parameter list), check whether any \`@param\`, \`@returns\`, or \`@description\` tag visible in the same diff hunk or an immediately adjacent context block still describes the old behaviour. A JSDoc comment that contradicts the new signature (e.g. \`@returns The size … Returns 0 if the element is not provided\` after the parameter type changed to non-nullable \`HTMLElement\`) is a catalogue item. — **Category 2**

   b. **README formula mismatch** — when a \`README.md\` or documentation file is in the "Changed Files" list and contains a \`+\` line with a formula or pseudo-code block that uses \`=\` assignment and multi-term arithmetic to describe implementation behaviour (e.g. \`effectiveSize = boundingClientRect[dimension] + padding\`), cross-reference the formula against the diff implementation as follows:

   - **If the formula contains concrete CSS property names** (actual camelCase property names such as \`paddingLeft\`, \`paddingTop\`, \`marginRight\`, \`paddingBottom\` etc.), you must verify the formula against *each conditional branch* visible in the diff (e.g. both the \`width\` path and the \`height\` path of a \`dimension === 'width' ? ... : ...\` expression). A formula that is accurate for one branch but wrong for another is a catalogue item.
   - **If the formula uses abstract axis notation only** (terms like \`inline-start\`, \`block-start\`, \`start\`, \`end\`, or generic nouns like "padding", "margin" without specifying a direction), no per-branch check is required — write \`discarded: formula uses abstract axis notation — no per-branch check required\`.

   **Do not trigger** on code blocks that only show API call syntax (e.g. \`handler = createOverflowHandler({ ... })\`) — these are usage examples, not behavioural formulas.
   **Valid discard for concrete property names:** quote a diff line from *each* conditional branch (e.g. both width and height paths) showing the named property is used in that branch. A discard that quotes only one branch when the implementation shows two or more is an **invalid discard reason** — you must verify every branch.
   The existing NO-FINDINGS exemption for documentation files does not apply when the file contains a formula or behavioural description that can be cross-referenced against the diff implementation. — **Category 2**

19. **Documentation prose review** — for every documentation file (\`.md\`, \`.txt\`, \`.rst\`) in the "Changed Files" list, check every \`+\` line for spelling and grammar errors. Write \`NO-FINDINGS [filename] — prose reviewed, no errors found\` or one catalogue entry per error found. All prose findings are always \`nit\` severity. — **Category 2**

## Step 2 — Resolve every pending item

For each \`pending\` item in your catalogue:
- If Category 1: **Carbon API source of truth** — the \`carbon-builder\` skill and Carbon MCP are the preferred ground truth for all Carbon-specific claims.
  1. **PREFER** the \`carbon-builder\` skill. Invoke via the \`Skill\` tool before making any Carbon claim. Before looking up any prop, attribute name, or token, invoke \`carbon-builder\`.
  2. **FALLBACK** to Carbon MCP tools directly when \`carbon-builder\` is unreachable:
     - \`code_search\` — component props, variants, attribute names, icons
     - \`docs_search\` — design rationale, token semantics, accessibility rules
     - \`get_charts\` — Carbon Charts source and options
     - Log: \`⚠️ carbon-builder UNAVAILABLE — MCP fallback: [component/attribute]\`
  3. **FALLBACK** to model knowledge only when both above are unreachable. Log: \`⚠️ CARBON SKILL/MCP UNAVAILABLE — used model knowledge for: [component] at [file:line]\`

  **The review MUST NOT halt because a tier is unavailable. Uptime is mandatory.**

  Update the item to \`confirmed finding\` or \`discarded: [reason]\`
- If Category 2: decide from the diff alone, then update to \`confirmed finding\` or \`discarded: [reason]\`

A \`pending\` item may never be silently dropped. If you move to Step 3 with any item still \`pending\`, go back.

Do not raise a finding on a change until you have checked whether the rest of the diff compensates for it.

**Invalid discard reasons — these are not evidence, they are claims that belong in a review comment:**
- "This is intentional" or "this is by design" — the PR author's intent is not visible in the diff
- "This is a Figma visual state" — a variant that emits identical markup has no code effect regardless of Figma intent
- "These are config files, not components" — config files that reference Carbon APIs are in scope
- "The API looks standard" or "this appears correct" — appearance without evidence is not a valid discard reason for ANY category
- A successful MCP call about a different question (e.g. confirming an attribute exists) does NOT discharge a pending item about a different concern (e.g. a falsy check, a missing guard, a logic equivalence question) — each pending item must be resolved on its own merits
- **Stating a factual condition that is not true** — e.g. claiming test files exist in the changed files list when they do not, or claiming the diff does not introduce new behaviour when it does. A discard reason that misstates what the diff or the changed files list contains is invalid. If you are unsure whether a file exists in the changed list, re-read the "Changed Files" section of PR_REVIEW_REQUEST.md before discarding.
- **Inferring intent from another part of the diff** — concluding that a change is "intentional" or "deliberate" because a related change elsewhere in the diff appears consistent with it (e.g. "the StickyHeader story overrides this arg, so the default export change must be intentional") is not a valid discard reason. Only a diff line that directly shows the concern is resolved — e.g. showing all affected callers already override the changed value — is valid evidence. For the stories default-export rendering check: the only valid discard is a quoted diff line showing every existing story in the file explicitly overrides the changed args. This rendering-override discard does NOT apply to the documented-as-API sub-check — showing that stories override an arg does not remove it from the Storybook docs table. The only valid discards for the documented-as-API sub-check are: (a) Step A fast-discard — quote the exact \`+\` line showing an unambiguous prop binding on the demonstrated component; or (b) Step B MCP discard — quote the verbatim \`example_clean\` or \`props_used\` field value showing the key exists as a prop. No other discard reason is valid for the documented-as-API sub-check.

**Valid discard reasons:**
- Category 1: MCP returned direct evidence (from an example_clean, props_used, or chunk_text field) that the specific API usage on the specific component is correct — quote the evidence verbatim. Cross-component evidence alone (e.g. toast uses role="status", therefore inline is correct) is NOT a valid discard reason; it is evidence that belongs in mcpEvidence of a minor finding.
- Category 2: Quote the specific diff line (file:line) that makes the concern safe, and explain in one sentence why that line resolves it. A general conclusion ("implementation is correct", "this is handled") without a cited line is not a valid discard reason.

## Step 3 — Compile your findings list

Before writing any JSON, list every \`confirmed finding\` from your catalogue with file path, line, title, severity, and whether MCP verification is complete. Nothing may appear in the JSON that is not in this list. If a confirmed finding still needs MCP evidence, go verify it now before proceeding.

**Severity calibration — assign before writing the JSON:**
- \`blocking\` — the change breaks a user-facing behaviour or violates an accessibility requirement with no workaround visible in the diff.
- \`major\` — the change is likely to cause a visible rendering difference, a runtime error, or a regression in production for at least one usage path visible in the diff.
- \`minor\` — the change is correct but introduces risk of future maintainability debt, an inconsistency a future developer would have to work around, or a subtle behaviour difference that is not immediately breaking. A concern requires evidence of functional impact to reach \`minor\`.
- \`nit\` — the concern is purely conventional or a hygiene opportunity with no functional consequence (e.g. token vs hardcoded value, missing comment, style inconsistency). Use \`nit\` when the PR author could reasonably merge without addressing it and no user would notice. **Documentation file prose findings (spelling, grammar) are always \`nit\`.**

**Do not assign \`minor\` or above for:** spacing token substitutions, missing inline comments, changelog omissions on non-public APIs, test coverage for code already covered by a \`play()\` block, or defensive guard omissions (e.g. missing \`event.defaultPrevented\` check) where the risk scenario requires a specific combination of caller usage that is not demonstrated by any code visible in the diff. These are \`nit\` at most.

**Contextual layout token pattern — do not flag as breaking change:**
When a JS/TS prop default is removed (e.g. \`size = 'md'\` → \`size\`) AND the same diff adds \`@include layout.use('size', $default: 'md', ...)\` in SCSS, the default has moved from the prop layer to the CSS layer — this is the Carbon contextual layout token migration pattern. The component still renders the same default visually. This is NOT a breaking change. Look for \`layout.use\` with a matching \`$default:\` value in the SCSS changes before flagging a removed JS prop default as breaking.

**Final verification pass — before proceeding to Step 4:** Review every finding in your confirmed list. For each finding whose \`body\` ends with a concrete imperative suggestion (add a default, add a guard, restore a constraint, rename a prop, remove a property), check whether a \`+\` line in the same file's diff already implements that suggestion. If such a line exists, write a visible \`discarded: [quoted line] — already addressed in diff\` line and remove the finding from your confirmed list before writing the JSON. A finding may not appear in the JSON if its suggested remedy is already present in the diff.

## Step 4 — Output the JSON

Your ONLY structured output is the JSON block between BEGIN_REVIEW_JSON and END_REVIEW_JSON markers below. ${noCompletion}, do not write any prose after the JSON block. Writing the JSON block IS the completion step — do it even when findings is an empty array.

Primary objective: Find correctness, accessibility, test, migration, and Carbon Design System issues introduced by this PR.

**Carbon verification rule:**
For any finding about a Carbon component's API (props, tokens, icons, patterns, accessibility), invoke the \`carbon-builder\` skill first. Before looking up any prop, attribute name, import path, or token name, invoke \`carbon-builder\`. If \`carbon-builder\` is unavailable, fall back to Carbon MCP tools (\`code_search\`, \`docs_search\`, \`get_charts\` via server: \`carbon-mcp\`); fall back to model memory only when Carbon MCP is also unreachable.
If Carbon MCP is unavailable or returns no usable response, DO NOT reclassify the finding as Category 2 — keep the finding and note in summaryMarkdown that Carbon verification used model memory.

**Two categories only:**

Category 1 — Carbon API finding: about a Carbon component's props, tokens, variants, or accessibility patterns.
- MANDATORY: Invoke the \`carbon-builder\` skill for every Category 1 recommendation you make. Invoke via the \`Skill\` tool when available.
- MANDATORY: If \`carbon-builder\` is unavailable, fall back to Carbon MCP tools (\`code_search\`, \`docs_search\`, \`get_charts\`).
- MANDATORY: Tool unavailability is NOT a reason to drop the finding. The review MUST continue.
- Set: carbonVerified: true, mcpEvidence MUST be a direct quote from the tool response
- verificationSource: set based on which tier resolved this finding:
  - "carbon-builder" — if the \`carbon-builder\` skill was consulted (any file under ${skillPath}) before MCP calls for this finding
  - "carbon-mcp" — if \`carbon-builder\` was unavailable and MCP tools were used directly as fallback
- If MCP unavailable or tool call fails: omit the finding, do NOT reclassify it as not-carbon-specific

Category 2 — Non-Carbon finding: generic correctness, accessibility, test coverage, or migration issue visible in the diff.
- Do NOT use carbon-mcp tools
- Set: carbonVerified: false, verificationSource: "not-carbon-specific"

**Category test:** Ask "Could this finding appear on a non-Carbon component using the same framework?" If YES → Category 2. If NO → Category 1.

Exception for config/tooling files: if the finding is about whether a specific **attribute name** exists on a specific Carbon element (e.g. is \`direction\` a valid attribute on \`<cds-overflow-menu>\`?), it is always Category 1 regardless of whether a similar pattern could appear elsewhere — the correctness of the name depends entirely on Carbon's API.

This exception does NOT apply to structural or output questions. A finding about two variant blocks emitting identical markup is always Category 2 — you can answer it by reading the diff, regardless of which file it appears in. Do not call MCP to ask whether an \`open\` prop exists in order to justify a duplicate-variant finding. It also does not cover how an attribute should be bound — whether \`?attr\`, \`ifDefined\`, or a plain string binding is correct is a framework syntax question, not an attribute-name question, and is always Category 2.

**Framework behaviour is always Category 2** regardless of which file it appears in: Lit lifecycle (@query, firstUpdated, updateComplete), Lit template binding syntax (?attr boolean prefix, .prop property binding, @event listeners), React hooks, TypeScript types, event listeners, async patterns.

**MCP cannot answer framework syntax questions.** Questions about whether \`?attr\`, \`.prop\`, \`ifDefined\`, or any other framework binding pattern is correct are not answerable from Carbon's API documentation or storybook examples — they depend entirely on the framework's own behaviour. Do not call MCP to verify framework or template binding syntax; resolve these from the diff alone as Category 2.

**Do not call MCP tools speculatively on general source code.** Exception: for any file that references Carbon component APIs (e.g. \`.figma.ts\`, \`.stories.ts\`), verifying that an **attribute name** exists on the correct element is always a valid MCP call — do not wait for a "specific finding" before checking attribute placement in these files. This exception covers attribute-name and placement questions only — it does not cover duplicate-variant or missing-aria-label findings, which are always Category 2.

**Follow requery_hint before trying docs_search.** When a code_search result shows "example_omitted": true for a variant that is relevant to your finding, follow its requery_hint with size: 1 before falling back to docs_search. The requery_hint fetches the full variant example and is the most precise evidence source for prop requirements.

**Stop after two MCP calls for the same prop.** If two consecutive MCP calls searching for the same prop name return no evidence of it in any example_clean, props_used, or props_catalog field, do not follow additional requery_hints for that prop. Move on — treat as "MCP returned no evidence."

**props_catalog is not exhaustive.** It only reflects props used in indexed storybook stories — not the full component API. Absence of a prop from props_catalog is NOT sufficient evidence to file a finding. Before concluding a prop does not exist:
- Check whether any MCP result (any framework, any variant) shows the prop in an example_clean or props_used field — cross-framework confirmation (e.g. Web Components showing \`hide-steppers\` when reviewing a React prop \`hideSteppers\`) is positive evidence the prop concept exists in Carbon
- Follow requery_hint on at most one relevant variant to get its full example
- Only file a finding about a missing prop if MCP positively shows it was removed, deprecated, or is absent from the TypeScript interface — not merely absent from props_catalog

**mcpEvidence rule:** Must be a direct quote or verbatim field value from a tool response. Acceptable forms:
- A direct quote from a docs_search chunk_text field
- A verbatim example_clean or props_used value from code_search (e.g. "cds-toast-notification default variant shows role=\\"status\\" in example_clean")
- A cross-component observation stated explicitly, e.g. "cds-toast-notification default storybook example uses role=\\"status\\""

Vague summaries like "Verified via code_search" or empty strings will cause the finding to be dropped by the parser. If the only available evidence is a cross-component inference, state it explicitly in that form — do NOT synthesize or paraphrase a quote that was not present in the tool response.

**body field rule:** For findings of severity \`minor\`, \`major\`, or \`blocking\`, the body must end with a concrete suggestion in imperative form — what the submitter should do, not just what was observed.
Good: "…Scope this selector to \`.--data-table--sticky-header\`, or add a comment confirming the broader scope is intentional for all expandable table variants."
Bad: "…The selector was broadened without a scoping modifier."

Severity reminder: token hygiene, comment style, and opportunity improvements are always \`nit\`. A concern requires evidence of functional impact to reach \`minor\`.

**summaryMarkdown** must contain only:
1. One or two sentences describing what the PR does
2. A single line stating the count and severity of findings
3. (Optional) One sentence noting Carbon MCP unavailability — include this ONLY if Carbon-specific findings were omitted because MCP was unavailable

Must NOT contain checkmark lists, MCP verification claims, broad alignment statements, headings, recommendations, or emoji. The recommendation is computed by the system — do not include it here.

Correct: "This PR suppresses invalid/warn states on TextArea when disabled or readonly. 1 minor finding: readonly/disabled precedence behaviour may need a clarifying comment."
Incorrect: "✅ TextArea API confirmed via code_search. ✅ Implementation aligns with Carbon guidelines."

**findingsTable** must be populated with one entry per confirmed finding — the same findings that appear in the \`findings\` array. Each entry is a plain object with five string fields. Do NOT include rows for clean areas. Do NOT use pipe characters, newlines, or backslashes in any field value — these are plain text labels only.

**Emit strict, parseable JSON.** Every string value (\`summaryMarkdown\`, \`title\`, \`body\`, \`mcpEvidence\`) must be valid JSON: escape any embedded double-quote as \\" and write any literal backslash as two backslashes. A lone backslash — from a regex (\\d, \\s), a Windows path, or escaped markdown (\\_, \\*) — makes the block unparseable and causes the ENTIRE review to be discarded. Keep each string value on a single line with no raw line breaks.

Return exactly this JSON between markers — this is mandatory, do not end your response without it:

BEGIN_REVIEW_JSON
{
  "summaryMarkdown": "string — 1 to 3 sentences max, no headings, no emoji, no recommendations",
  "findings": [
    {
      "severity": "nit=convention only | minor=maintainability risk | major=likely runtime impact | blocking=breaks behaviour or a11y",
      "file": "repo-relative path",
      "line": 123,  ← new-file line number from the diff (count from the @@ hunk's + start); never a memorised repository line number
      "title": "short title — plain text, no pipes or newlines",
      "body": "observation + concrete suggestion (minor/major/blocking must end with an imperative sentence: what the submitter should do)",
      "carbonVerified": true,
      "verificationSource": "carbon-builder|carbon-mcp|not-carbon-specific",
      "mcpEvidence": "direct quote from MCP tool response (required when verificationSource is carbon-builder or carbon-mcp, omit otherwise)"
    }
  ],
  "findingsTable": [
    {
      "area": "Carbon API|General",
      "category": "Cat 1|Cat 2",
      "severity": "blocking|major|minor|nit",
      "title": "short title — plain text only, no pipes or newlines",
      "file": "repo-relative path — plain text only, no pipes"
    }
  ],
  "shouldPostInlineComments": true
}
END_REVIEW_JSON

verificationSource values:
- "carbon-builder": verified via Carbon Builder skill files governing Carbon MCP calls, with at least one explicit ${readTool} call to ${skillPath}SKILL.md or another file under ${skillPath} visible in the transcript before the MCP evidence is used — mcpEvidence MUST be a direct quote from the tool response
- "carbon-mcp": verified via Carbon MCP directly (skill unavailable) — mcpEvidence MUST be a direct quote from the tool response
- "not-carbon-specific": generic correctness, accessibility, test, or migration finding

findingsTable rules:
- One entry per confirmed finding (mirrors the findings array)
- area: "Carbon API" for carbon-builder or carbon-mcp findings, "General" for not-carbon-specific findings
- category: "Cat 1" for carbon-builder or carbon-mcp findings, "Cat 2" for not-carbon-specific findings
- No Markdown formatting, no pipe characters, no newline characters in any field value
- Empty array when there are no confirmed findings
`;
}

module.exports = {
  formatSummaryComment,
  formatLooksGoodComment,
  formatCoverageNote,
  formatNotReviewedComment,
  formatInlineComment,
  buildReviewPrompt,
  estimateTokenUsage,
  escapeAtSign,
};
