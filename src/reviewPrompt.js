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

  // Single-line Carbon verification status
  const cv = carbonVerification || {};
  let verificationLine;
  if (cv.skillConnected && cv.mcpConnected) {
    verificationLine = `Carbon verification: Carbon Builder Skill active, Carbon MCP active`;
  } else if (cv.skillConnected) {
    verificationLine = `Carbon verification: Carbon Builder Skill active`;
  } else if (cv.mcpConnected) {
    verificationLine = `Carbon verification: Carbon MCP active (skill files unavailable)`;
  } else {
    verificationLine = `Carbon verification: unavailable — Carbon-specific findings omitted`;
  }
  comment += `${verificationLine}\n\n`;

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

  const skillPrimaryInstructions = skillRefsAvailable
    ? `**STEP 1 — Carbon Builder Skill reference files (PRIMARY — MANDATORY file reads required):**
The Carbon Builder Skill reference files are bundled locally. For every Carbon PR review, you MUST use your file-read tool to open and read the relevant file(s) before writing any Carbon finding.

The reference files are at: \`${SKILL_REF_PATH}/\`

**MANDATORY: Before writing any Carbon finding, use your file-read tool to open at least one of these files:**
- \`${SKILL_REF_PATH}/implementation-guardrails.md\` — stability policy, package rules, component/API correctness, styling/theming discipline, layout/accessibility guardrails
- \`${SKILL_REF_PATH}/framework-rules.md\` — React vs Web Components rules, SCSS setup, IBM Plex font, spacing tokens
- \`${SKILL_REF_PATH}/common-pitfalls.md\` — Web Components styling mistakes, missing style imports, theme class issues
- \`${SKILL_REF_PATH}/implementation-guardrails.md\` is the most important — read it first for any Carbon component finding

**You MUST physically read the file using your file-read tool. You CANNOT skip this step or claim you read it without actually opening the file.**

**How to use the skill reference files:**
1. Read the diff to identify what Carbon components, patterns, or tokens are involved.
2. Use your file-read tool to open the most relevant reference file(s) — start with \`implementation-guardrails.md\`.
3. Scan the file content for text that directly supports or refutes the potential finding.
4. If you find supporting text, copy the exact sentence(s) verbatim into \`skillEvidence\` with the filename.
5. After scanning, ask: **does the diff involve a specific named Carbon component** (e.g. \`OverflowMenuItem\`, \`DataTable\`, \`Button\`, \`TextInput\`, or any other named component from \`@carbon/react\` or \`@carbon/web-components\`)? If yes, that component's specific behaviour — disabled states, rendering modes, ARIA patterns, prop interactions, link vs button switching — is **component-level detail that the skill files do not cover**. Proceed to STEP 2 (Carbon MCP) to confirm that behaviour regardless of what the skill files say.
6. If the finding is about a general Carbon guardrail (imports, tokens, SCSS setup, theming) AND the skill files contain text that directly addresses it, set \`verificationSource: "carbon-builder-skill"\` and \`carbonVerified: true\`. Skip STEP 2 only in this case.
7. If no reference file contains text that directly relates to this specific finding, proceed to STEP 2 (Carbon MCP).

**CRITICAL: skillProof and skillEvidence MUST be verbatim text you read from the file — not a paraphrase, not a summary, not text you wrote yourself.**
- VALID: \`"implementation-guardrails.md: 'Icon-only interactive controls must include descriptive iconDescription.'"\`
- INVALID: \`"implementation-guardrails.md: Reviewed for Carbon component API correctness."\` ← you wrote this, it is not in the file
- INVALID: \`"implementation-guardrails.md: 'Keep overlay/floating UI out of normal page Grid flow.'"\` ← layout rule, unrelated to the finding about role attribute

For \`carbonVerification\` in your JSON output when using skill reference files:
- Set \`skillConnected: true\`
- Populate \`skillProof\` with a sentence you read verbatim from the file that is **directly relevant to what this PR changes**.
- If the PR had no Carbon violations, skillProof should quote a rule the PR correctly follows (e.g. if the PR correctly uses role on a dialog, quote the accessibility rule about dialog roles).`
    : `**STEP 1 — Carbon Builder Skill reference files are NOT available in this bundle.**
Proceed directly to STEP 2 (Carbon MCP) for Carbon-specific verification.
Set \`skillConnected: false\` in carbonVerification.`;

  const mcpSecondaryInstructions = `**STEP 2 — Carbon MCP (required for component-specific findings; use for API-level precision):**
After reading the skill reference files, use Carbon MCP tools (server name: \`carbon-mcp\`) when ANY of these are true:
- The PR involves a specific named Carbon component and the finding is about that component's behaviour (disabled states, ARIA patterns, rendering modes, prop interactions, link vs button switching) — **skill files cover general guardrails, not per-component implementation detail**
- The skill files do not contain text directly addressing the specific component API in the diff
- You need to confirm exact prop names, required fields, or valid variants
- You need a concrete code example to confirm or refute the usage in the diff

Carbon MCP tools available:
1. **code_search** - Search for components, icons, pictograms, variants, and code examples
2. **docs_search** - Search design/usage/accessibility documentation for components and tokens
3. **get_charts** - Verify Carbon Charts usage, options, and variants

- If you call Carbon MCP and ANY tool call succeeds, set \`mcpConnected: true\` in carbonVerification.
- If you do not call Carbon MCP at all (skill files were sufficient), set \`mcpConnected: false\`.
- Tool-specific errors (e.g. "component not found") do NOT mean MCP is unavailable — only network/connection errors do.
- For \`carbonVerification\` in your JSON output: populate \`mcpProof\` with a short verbatim snippet from the actual tool response (tool name + first result excerpt).
- When MCP evidence is available and more specific than skill evidence for a finding, set \`verificationSource: "carbon-mcp"\` and populate \`mcpEvidence\`.`;

  return `You are an agentic PR reviewer for ${owner}/${repo}.

**You are reviewing a Carbon Design System PR. For Category 1 (Carbon-specific) findings: use Carbon Builder Skill reference files to orient your review, then use Carbon MCP for any finding about a specific named component's behaviour.**

Review the PR bundle in the current directory:
- PR_REVIEW_REQUEST.md (summary of the PR)
- pr.json (PR metadata)
- files.json (list of changed files)
- diff.patch (unified diff of changes)

**IMPORTANT: Only review the SOURCE CODE files listed in files.json. DO NOT review the bundle files themselves (diff.patch, pr.json, files.json, PR_REVIEW_REQUEST.md).**

Primary objective:
Find correctness, accessibility, test, migration, and Carbon Design System issues introduced by this PR.

**CRITICAL: Carbon Ground-Truth Enforcement**

**Carbon verification uses a two-tier approach: Carbon Builder Skill reference files cover general guardrails; Carbon MCP is required for per-component behaviour.**

${skillPrimaryInstructions}

${mcpSecondaryInstructions}

You MUST categorize each finding correctly — there are ONLY TWO categories:

**Category 1: Carbon-Specific Findings (USE CARBON BUILDER SKILL FIRST, THEN CARBON MCP)**
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
   
   - **REQUIRED: Read skill files first to orient, then use Carbon MCP for component-specific behaviour**
     * Step 1: read the skill reference files at \`${SKILL_REF_PATH}/\` and note any relevant guardrails
     * Step 2: if the finding involves a **specific named Carbon component**, call carbon-mcp \`docs_search\` or \`code_search\` for that component — skill files do not cover per-component implementation detail
     * If skill files have a directly matching general guardrail rule AND no named component behaviour is involved, set: \`carbonVerified: true, verificationSource: "carbon-builder-skill"\`
     * If MCP evidence is available and more specific, set: \`carbonVerified: true, verificationSource: "carbon-mcp"\`

   - **If BOTH the skill reference files and Carbon MCP yield no supporting evidence: omit the finding entirely**
     * Do NOT use raw model memory as evidence
     * Do NOT post an unverified Carbon claim with a warning
     * An unverified Carbon claim is invalid and must not be posted

**Category 2: Non-Carbon Findings (DO NOT USE CARBON MCP OR SKILL FILES)**
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
- You MUST read the skill reference files at \`${SKILL_REF_PATH}/\` first
- Skill files satisfy verification **only for general Carbon guardrails** (imports, tokens, SCSS setup, theming discipline) — if the skill file has a directly matching rule, that is sufficient
- For **component-specific behaviour** (a named component's disabled state, ARIA patterns, rendering mode, prop interactions), skill files are not sufficient — you MUST also call carbon-mcp \`docs_search\` or \`code_search\` for that component
- If MCP returns more specific evidence for a finding, set verificationSource to "carbon-mcp"
- You CANNOT use verificationSource: "not-carbon-specific" for Carbon API findings
- If no evidence exists from either source, omit the finding entirely

DO NOT mark findings about Carbon component APIs as "not-carbon-specific" — this is incorrect!
DO NOT mark findings about framework behaviour as "carbon-builder-skill" or "carbon-mcp" just because they appear in a Carbon file — this is also incorrect!

**EVIDENCE REQUIREMENT:**
For every finding where verificationSource is "carbon-builder-skill", you MUST populate the "skillEvidence" field with a verbatim quote from one of the skill's reference files that supports the finding. This must be real text copied from the file — not a paraphrase.

Examples of valid skillEvidence:
- "implementation-guardrails.md: 'Icon-only interactive controls must include descriptive iconDescription.'"
- "framework-rules.md: 'Never use inline token strings — token strings do NOT resolve at runtime.'"
- "common-pitfalls.md: 'Missing app-entry style import — import styles before component imports.'"

For every finding where verificationSource is "carbon-mcp", you MUST populate the "mcpEvidence" field with a direct quote or excerpt from the actual MCP tool response that supports the finding. This must be real text returned by the tool — not a paraphrase, not a description of what the tool does, not a summary you wrote yourself.

Examples of valid mcpEvidence:
- "code_search returned: 'iconDescription: The description of the icon, used for screen reader accessibility. Required when hasIconOnly is true.'"
- "docs_search returned: 'labelText - Required. Provide a label to describe the input for accessibility purposes.'"

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

- \`skillConnected\`: set \`true\` if you physically opened and read a skill reference file using your file-read tool. Set \`false\` if you did not open any file.
- \`skillProof\`: populate with a verbatim sentence you read from the file that is directly relevant to what this PR changes. Leave empty string if skillConnected is false.
- \`mcpConnected\`: set \`true\` ONLY if you actually called a carbon-mcp tool AND it returned a successful response. Set \`false\` if you did not call MCP tools (e.g. because skill files were sufficient) OR if all MCP calls failed.
- \`mcpProof\`: populate with a short verbatim snippet from the actual MCP tool response. Leave empty string if mcpConnected is false.

**The distinction between mcpConnected: false (not called) and mcpConnected: false (called but failed) is handled automatically by whether mcpProof is populated — do not add extra commentary.**

**SUMMARY CONTENT RULE:**
Only mention Carbon skill/MCP availability in summaryMarkdown if you had Carbon-specific findings that could not be posted because neither path was available. Do not mention verification status in the summary — it appears in its own block above the summary.

**FINAL STEP — MANDATORY:**
When you have finished reading the diff and calling any necessary MCP tools, you MUST write the JSON output block below. This is required — do not end your response without it. The review is not complete until the JSON between BEGIN_REVIEW_JSON and END_REVIEW_JSON markers is written.

Return exactly this JSON between markers:

BEGIN_REVIEW_JSON
{
  "carbonVerification": {
    "skillConnected": true,
    "skillProof": "filename + verbatim quote, e.g. 'implementation-guardrails.md: Icon-only interactive controls must include descriptive iconDescription.'",
    "mcpConnected": false,
    "mcpProof": "short verbatim snippet from a successful MCP tool call (populate only when MCP was also used for additional precision)"
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
      "verificationSource": "carbon-builder-skill|carbon-mcp|not-carbon-specific",
      "skillEvidence": "direct quote from skill reference file (required when verificationSource is carbon-builder-skill, omit otherwise)",
      "mcpEvidence": "direct quote from MCP tool response (required when verificationSource is carbon-mcp, omit otherwise)"
    }
  ],
  "shouldPostInlineComments": true
}
END_REVIEW_JSON

Notes on verificationSource:
- "carbon-builder-skill": Verified via Carbon Builder Skill reference files (PRIMARY) — skillEvidence MUST contain a verbatim quote from a reference file (implementation-guardrails.md, framework-rules.md, common-pitfalls.md, etc.)
- "carbon-mcp": Verified via Carbon MCP tools (SECONDARY — used for additional API precision) — mcpEvidence MUST contain a direct quote from the tool response
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
