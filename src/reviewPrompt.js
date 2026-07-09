/**
 * Format review comments according to Carbon PR review spec
 */

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
  // Rough estimation: 1 token ≈ 4 characters for English text
  // This is a conservative estimate; actual tokenization varies by model
  const CHARS_PER_TOKEN = 4;
  
  const inputChars = (prompt?.length || 0) + (diff?.length || 0);
  const outputChars = agentOutput?.length || 0;
  
  const inputTokens = Math.ceil(inputChars / CHARS_PER_TOKEN);
  const outputTokens = Math.ceil(outputChars / CHARS_PER_TOKEN);
  const totalTokens = inputTokens + outputTokens;
  
  return {
    input: inputTokens,
    output: outputTokens,
    total: totalTokens
  };
}

/**
 * Format summary comment with spec-compliant template
 *
 * @param {Object} options - Formatting options
 * @param {string} options.agent - Agent name (bob, claude, codex)
 * @param {string} options.summaryMarkdown - Agent's summary markdown
 * @param {number} options.prNumber - PR number
 * @param {string} options.commitSha - Head commit SHA
 * @param {Array} [options.inlineFindings] - Findings posted as inline comments
 * @param {Array} [options.summaryFindings] - Findings included in summary
 * @param {Object} [options.tokenUsage] - Token usage estimate { input, output, total }
 * @returns {string} - Formatted summary comment
 */
function formatSummaryComment({ agent, summaryMarkdown, prNumber, commitSha, inlineFindings = [], summaryFindings = [], tokenUsage = null, carbonVerification = null }) {
  let comment = `[AI agent review — Carbon grounded]\n\n`;
  comment += `Reviewed by: ${agent}\n`;
  comment += `Carbon verification policy: Carbon-specific claims require Carbon MCP or Carbon Builder Skill verification.\n\n`;

  // Always show Carbon verification status block
  comment += `## Carbon Verification Status\n\n`;
  const cv = carbonVerification || {};
  if (cv.mcpConnected) {
    comment += `✅ **Carbon MCP connected** — Carbon findings verified via \`carbon-mcp\` server.\n`;
    if (cv.mcpProof) {
      comment += `> Proof: ${cv.mcpProof}\n`;
    }
  } else if (cv.skillConnected) {
    comment += `⚠️ **Carbon MCP unavailable** — Carbon Builder Skill used as fallback. Carbon findings verified via skill reference files.\n`;
    if (cv.skillProof) {
      comment += `> Proof: ${cv.skillProof}\n`;
    }
  } else {
    comment += `❌ **Carbon MCP unavailable and Carbon Builder Skill could not be activated** — no Carbon-specific verification was possible. Carbon API findings have been omitted.\n`;
  }
  comment += `\n`;

  // Add agent's summary
  comment += summaryMarkdown + '\n\n';
  
  // Add findings that couldn't be posted inline
  if (summaryFindings && summaryFindings.length > 0) {
    comment += `## Additional Findings\n\n`;
    comment += `The following findings could not be mapped to specific lines in the diff:\n\n`;
    
    summaryFindings.forEach((finding, index) => {
      comment += `### ${index + 1}. ${finding.title}\n\n`;
      comment += `**File:** \`${finding.file}\``;
      if (finding.line) {
        comment += ` (Line ${finding.line})`;
      }
      comment += `\n**Severity:** ${finding.severity}\n\n`;
      comment += finding.body + '\n\n';
      
      // Show verification badge based on source
      if (finding.carbonVerified && finding.verificationSource === 'carbon-mcp') {
        comment += `*✓ Verified with Carbon MCP*\n\n`;
      } else if (finding.carbonVerified && finding.verificationSource === 'carbon-builder-skill') {
        comment += `*✓ Verified with Carbon Builder Skill*\n\n`;
      }
      
      comment += '---\n\n';
    });
  }
  
  // Add review artifacts
  comment += `Review artifacts:\n`;
  comment += `- PR: #${prNumber}\n`;
  comment += `- Commit: ${commitSha.substring(0, 7)}\n`;
  comment += `- Agent: ${agent}\n`;
  
  if (inlineFindings && inlineFindings.length > 0) {
    comment += `- Inline comments: ${inlineFindings.length}\n`;
  }
  if (summaryFindings && summaryFindings.length > 0) {
    comment += `- Summary findings: ${summaryFindings.length}\n`;
  }
  
  // Add token usage estimate if available
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

/**
 * Format inline review comment for a specific finding
 * 
 * @param {Object} finding - Finding object
 * @returns {string} - Formatted inline comment
 */
function formatInlineComment(finding) {
  let comment = `**${finding.title}**\n\n`;
  comment += `Severity: ${finding.severity}\n\n`;
  comment += finding.body + '\n\n';
  
  // Show verification badge based on source
  if (finding.carbonVerified && finding.verificationSource === 'carbon-mcp') {
    comment += `*✓ Verified with Carbon MCP*\n`;
  } else if (finding.carbonVerified && finding.verificationSource === 'carbon-builder-skill') {
    comment += `*✓ Verified with Carbon Builder Skill*\n`;
  }
  
  return comment;
}

/**
 * Build the prompt for the AI agent
 * 
 * @param {Object} options - Prompt options
 * @param {string} options.owner - Repository owner
 * @param {string} options.repo - Repository name
 * @returns {string} - Formatted prompt
 */
function buildReviewPrompt({ owner, repo, skillRefsAvailable = true }) {
  // Local path to skill reference files inside this bundle (always present when skillRefsAvailable=true)
  const SKILL_REF_PATH = '.bob/skills/carbon-builder/references';

  const skillFallbackInstructions = skillRefsAvailable
    ? `**STEP 2 — If Carbon MCP is unavailable, use Carbon Builder Skill reference files (FULL REVIEW STILL REQUIRED):**
If ALL carbon-mcp tool calls fail with a **connection error** (HTTP error, auth failure, server unreachable), you MUST still perform a complete Carbon compliance review using the skill reference files bundled locally.

The reference files are at: \`${SKILL_REF_PATH}/\`

Available files — read whichever are relevant to the PR:
- \`implementation-guardrails.md\` — stability policy, package rules, component/API correctness, styling/theming discipline, layout/accessibility guardrails
- \`framework-rules.md\` — React vs Web Components rules, SCSS setup, IBM Plex font, spacing tokens
- \`common-pitfalls.md\` — Web Components styling mistakes, missing style imports, theme class issues
- \`query-protocols.md\` — query strategy and component discovery patterns
- \`result-validation.md\` — validation checklist for generated output
- \`error-recovery.md\` — error recovery and retry guidance

**How to use the skill reference files:**
1. Read the diff to identify Carbon-specific patterns (component usage, props, tokens, imports, accessibility).
2. For each Carbon finding, read the most relevant reference file(s) to find supporting text.
3. Quote the exact text verbatim in \`skillEvidence\`, including the filename.
4. Set \`verificationSource: "carbon-builder-skill"\` and \`carbonVerified: true\`.
5. If no reference file contains supporting text for a finding, omit that finding — do not invent evidence.

**IMPORTANT: The skill fallback is a FULL verification path — not a degraded mode.**
You MUST produce Carbon findings from the skill files, not skip them. A PR with Carbon components must be reviewed for Carbon compliance regardless of whether MCP is available.

For \`carbonVerification\` in your JSON output when using the skill fallback:
- Set \`mcpConnected: false, skillConnected: true\`
- Populate \`skillProof\` with: the filename + a verbatim sentence from the file you actually read.
- Example valid skillProof: \`"implementation-guardrails.md: 'Icon-only interactive controls must include descriptive iconDescription.'"\``
    : `**STEP 2 — Carbon Builder Skill reference files are NOT available in this bundle.**
If Carbon MCP is also unavailable, Carbon-specific findings must be omitted entirely.
Set \`mcpConnected: false, skillConnected: false\` in carbonVerification.`;

  return `You are an agentic PR reviewer for ${owner}/${repo}.

**You are reviewing a Carbon Design System PR. Use Carbon MCP tools to verify all Carbon component usage, with the Carbon Builder Skill reference files as a fallback.**

Review the PR bundle in the current directory:
- PR_REVIEW_REQUEST.md (summary of the PR)
- pr.json (PR metadata)
- files.json (list of changed files)
- diff.patch (unified diff of changes)

**IMPORTANT: Only review the SOURCE CODE files listed in files.json. DO NOT review the bundle files themselves (diff.patch, pr.json, files.json, PR_REVIEW_REQUEST.md).**

Primary objective:
Find correctness, accessibility, test, migration, and Carbon Design System issues introduced by this PR.

**CRITICAL: Carbon Ground-Truth Enforcement**

**Carbon verification uses a two-tier approach: Carbon MCP is preferred; Carbon Builder Skill reference files are the fallback.**

**STEP 1 — Attempt Carbon MCP Verification (preferred):**
Try to use Carbon MCP tools (server name: \`carbon-mcp\`):
1. **code_search** - Search for components, icons, pictograms, variants, and code examples
2. **docs_search** - Search design/usage/accessibility documentation for components and tokens
3. **get_charts** - Verify Carbon Charts usage, options, and variants

- If ANY tool call succeeds (even if others fail), set verificationSource: "carbon-mcp" for ALL Carbon findings.
- Tool-specific errors (e.g. "component not found") do NOT mean MCP is unavailable — only network/connection errors do.
- For \`carbonVerification\` in your JSON output: set \`mcpConnected: true\` and populate \`mcpProof\` with a short verbatim snippet from the actual tool response (tool name + first result excerpt).

${skillFallbackInstructions}

You MUST categorize each finding correctly — there are ONLY TWO categories:

**Category 1: Carbon-Specific Findings (USE CARBON MCP or CARBON BUILDER SKILL REFERENCE FILES)**
   - ANY finding about Carbon Design System components, props, tokens, icons, or patterns
   - **Examples that MUST be Category 1:**
     * "DataTable missing required 'headers' prop" → Category 1 (mentions DataTable component)
     * "TextInput missing required 'labelText' prop" → Category 1 (mentions TextInput component)
     * "Using native HTML table instead of Carbon DataTable" → Category 1 (mentions DataTable)
     * "Carbon Button missing iconDescription prop" → Category 1 (mentions Carbon Button component)
     * "Using native checkbox instead of Carbon Checkbox" → Category 1 (mentions Checkbox)
     * "Invalid use of Carbon tokens" → Category 1 (mentions Carbon tokens)
     * "Missing @carbon/react import" → Category 1 (mentions @carbon package)
     * "Button component should use Carbon Button" → Category 1 (mentions Carbon Button)
   
   - **REQUIRED: Use Carbon MCP first, then skill reference files if MCP is unavailable**
     * Primary: use_mcp_tool with server_name="carbon-mcp" and tool_name="code_search" / "docs_search" / "get_charts"
     * If ANY Carbon MCP tool succeeds, set: \`carbonVerified: true, verificationSource: "carbon-mcp"\`
     * Fallback (MCP connection failure only): read the skill reference files at \`${SKILL_REF_PATH}/\` and quote from them directly

   - **If BOTH Carbon MCP and the skill reference files yield no supporting evidence: omit the finding entirely**
     * Do NOT use raw model memory as evidence
     * Do NOT post an unverified Carbon claim with a warning
     * An unverified Carbon claim is invalid and must not be posted

**Category 2: Non-Carbon Findings (DO NOT USE CARBON MCP)**
   - Generic code quality issues that don't mention Carbon
   - **Examples that MUST be Category 2:**
     * "Function name should be more descriptive" → Category 2 (generic naming)
     * "Missing test coverage for new components" → Category 2 (generic testing)
     * "Missing test coverage for new title attribute behavior" → Category 2 (generic testing)
     * "Potential memory leak in useEffect" → Category 2 (generic React issue)
     * "Variable 'x' should be renamed" → Category 2 (generic naming)
     * "Performance issue with large array" → Category 2 (generic performance)
     * "Consider adding title prop for consistency" → Category 2 (generic HTML attribute suggestion)
   
   - Set: \`carbonVerified: false, verificationSource: "not-carbon-specific"\`

**CRITICAL RULE:**
If your finding is specifically about a Carbon component's API — missing or incorrect props,
wrong variants, incorrect token usage, accessibility pattern violations — AND mentions one of
these components, it MUST be Category 1:
- DataTable, TextInput, Button, Checkbox, Dropdown, Modal, Accordion, Tabs, Toggle, TextArea
- @carbon, Carbon, carbon-react, carbon-icons
- Any component name from Carbon Design System

**EXCEPTION — Always Category 2 regardless of file name or component names mentioned:**
If the finding is about framework or language behaviour, it is NEVER Carbon-specific:
- Lit lifecycle: firstUpdated(), updated(), connectedCallback(), @query, @state, updateComplete
- React hooks: useEffect, useState, useRef, useMemo, useCallback
- TypeScript: type errors, generics, type assertions, interface mismatches
- Event listener registration patterns, timing issues, async/await patterns
- Memory leaks, observer cleanup, garbage collection
- Test coverage gaps, test infrastructure, assertion patterns
- Generic naming, formatting, or code style issues

Ask yourself: "Could this exact finding appear on a non-Carbon component that uses the same
framework?" If YES → Category 2. If NO (it is only wrong because of Carbon's specific API) → Category 1.

**VERIFICATION ENFORCEMENT:**
If your finding is Category 1 (about a Carbon component's API):
- You MUST use carbon-mcp tools to verify first
- If Carbon MCP is unavailable (connection error), you MUST read the skill reference files at \`${SKILL_REF_PATH}/\` and quote from them
- You CANNOT use verificationSource: "not-carbon-specific" for Carbon API findings
- If no evidence exists from either source, omit the finding entirely

DO NOT mark findings about Carbon component APIs as "not-carbon-specific" — this is incorrect!
DO NOT mark findings about framework behaviour as "carbon-mcp" just because they appear in a Carbon file — this is also incorrect!

**EVIDENCE REQUIREMENT:**
For every finding where verificationSource is "carbon-mcp", you MUST populate the "mcpEvidence" field with a direct quote or excerpt from the actual MCP tool response that supports the finding. This must be real text returned by the tool — not a paraphrase, not a description of what the tool does, not a summary you wrote yourself.

Examples of valid mcpEvidence:
- "code_search returned: 'iconDescription: The description of the icon, used for screen reader accessibility. Required when hasIconOnly is true.'"
- "docs_search returned: 'labelText - Required. Provide a label to describe the input for accessibility purposes.'"

For every finding where verificationSource is "carbon-builder-skill", you MUST populate the "skillEvidence" field with a verbatim quote from one of the skill's reference files that supports the finding. This must be real text copied from the file — not a paraphrase.

Examples of valid skillEvidence:
- "implementation-guardrails.md: 'Icon-only interactive controls must include descriptive iconDescription.'"
- "framework-rules.md: 'Never use inline token strings — token strings do NOT resolve at runtime.'"
- "common-pitfalls.md: 'Missing app-entry style import — import styles before component imports.'"

Examples of INVALID evidence (these will be treated as hallucinated verification):
- "Carbon MCP confirms this component requires the prop"
- "Verified via code_search"
- "MCP tools confirm the usage pattern"
- "Carbon Builder Skill confirmed this"
- "" (empty string)
- omitting the field entirely

If you cannot provide a real quote from the tool or skill response, you did not successfully verify. Omit the finding entirely.

**CARBON VERIFICATION STATUS — MANDATORY TOP-LEVEL FIELD:**
You MUST include a \`carbonVerification\` object in your JSON output. This field is always required and always shown to the PR author.

- If Carbon MCP connected: set \`mcpConnected: true\`, \`skillConnected: false\`, and populate \`mcpProof\` with a short verbatim snippet from the actual tool response.
- If MCP failed but skill files were used: set \`mcpConnected: false\`, \`skillConnected: true\`, and populate \`skillProof\` with the filename + a verbatim quote from the file read.
- If neither worked: set \`mcpConnected: false\`, \`skillConnected: false\`. Leave \`mcpProof\` and \`skillProof\` empty strings.

**SUMMARY CONTENT RULE:**
Only mention Carbon MCP/skill availability in summaryMarkdown if you had Carbon-specific findings that could not be posted because neither path was available. Do not mention verification status in the summary — it appears in its own block above the summary.

**FINAL STEP — MANDATORY:**
When you have finished reading the diff and calling any necessary MCP tools, you MUST write the JSON output block below. This is required — do not end your response without it. The review is not complete until the JSON between BEGIN_REVIEW_JSON and END_REVIEW_JSON markers is written.

Return exactly this JSON between markers:

BEGIN_REVIEW_JSON
{
  "carbonVerification": {
    "mcpConnected": true,
    "mcpProof": "short verbatim snippet from a successful MCP tool call, e.g. 'code_search returned: Button props include iconDescription...'",
    "skillConnected": false,
    "skillProof": "filename + verbatim quote, e.g. 'implementation-guardrails.md: Icon-only interactive controls must include descriptive iconDescription.' (populate only when MCP was unavailable and skill files were used)"
  },
  "summaryMarkdown": "string",
  "findings": [
    {
      "severity": "blocking|major|minor|nit",
      "file": "repo-relative path",
      "line": 123,
      "title": "short title",
      "body": "specific actionable comment",
      "carbonVerified": true,
      "verificationSource": "carbon-mcp|carbon-builder-skill|not-carbon-specific",
      "mcpEvidence": "direct quote from MCP tool response (required when verificationSource is carbon-mcp, omit otherwise)",
      "skillEvidence": "direct quote from skill reference file (required when verificationSource is carbon-builder-skill, omit otherwise)"
    }
  ],
  "shouldPostInlineComments": true
}
END_REVIEW_JSON

Notes on verificationSource:
- "carbon-mcp": Verified via Carbon MCP tools — mcpEvidence MUST contain a direct quote from the tool response
- "carbon-builder-skill": Verified via Carbon Builder Skill reference files — skillEvidence MUST contain a verbatim quote from a reference file (implementation-guardrails.md, framework-rules.md, common-pitfalls.md, etc.)
- "not-carbon-specific": Non-Carbon finding (generic correctness, accessibility, test, or migration issue)
`;
}

module.exports = {
  formatSummaryComment,
  formatInlineComment,
  buildReviewPrompt,
  estimateTokenUsage
};

// Made with Bob
