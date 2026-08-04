/**
 * Parse and validate structured JSON review output from AI agents
 * STRICTLY filters Carbon-specific claims that lack proper carbon-mcp verification
 */

/**
 * Check if a finding appears to be Carbon Design System specific
 *
 * @param {Object} finding - Review finding object
 * @returns {boolean} - True if finding mentions Carbon-specific terms
 */
function looksCarbonSpecific(finding) {
  const titleAndBody = `${finding.title} ${finding.body}`.toLowerCase();
  const filePath = (finding.file || '').toLowerCase();

  // Patterns that are unambiguously Carbon-specific regardless of context:
  // - Carbon design system / API / token / icon claims in the finding text itself
  // - @carbon/ imports referenced in the file path
  // - Carbon CSS class prefixes (cds-, bx-) mentioned as the subject of the finding
  // - Carbon SCSS tokens ($spacing-05, $layer-01, etc.)
  const strongPatterns = [
    /carbon design system/,
    /carbon component/,
    /carbon token/,
    /carbon icon/,
    /carbon prop/,
    /carbon api/,
    /ibm-products/,
    /\$[a-z]+-\d+/,           // Carbon tokens like $spacing-05, $layer-01
    /cds--[a-z]/,              // Carbon CSS class prefixes in finding text
    /bx--[a-z]/,               // Legacy Carbon CSS class prefixes
    /\bcarbon'?s?\s+\w+/,      // "Carbon DataTable", "Carbon's Button", etc.
  ];

  if (strongPatterns.some(p => p.test(titleAndBody))) {
    return true;
  }

  // @carbon/ scoped packages: only flag if the file being reviewed is a Carbon
  // package file, not just because suggestion text mentions a utility path
  if (/@carbon\//.test(filePath)) {
    return true;
  }

  // Component name patterns: only flag when the finding is making a claim about
  // how the Carbon component should be used (wrong prop, wrong API, missing import,
  // incorrect usage) — NOT when the component is merely the subject under test.
  // We detect this by requiring an API-claim keyword alongside the component name.
  const componentNames = [
    /\bdatatable\b/,
    /\btablecontainer\b/,
    /\btablehead\b/,
    /\btablerow\b/,
    /\btablecell\b/,
    /\bcheckbox\b/,
    /\bcombobox\b/,
    /\bfileuploader\b/,
    /\bprogressindicator\b/,
    /\bradiobutton\b/,
    /\btextarea\b/,
    /\btextinput\b/,
    /\buishell\b/,
    /\bfilterablemultiselect\b/,
    /\bmultiselect\b/,
    /\boverflowmenu\b/,
  ];

  const apiClaimKeywords = [
    /\bprop\b/,
    /\bprops\b/,
    /\bapi\b/,
    /\bimport\b/,
    /\busage\b/,
    /\btoken\b/,
    /\baccessibility\b/,
    /\baria\b/,
    /\bmigrat/,
    /\bdeprecated\b/,
    /\brequired\b/,
    /\bmissing.*import/,
    /should use carbon/,
    /use.*carbon/,
    /carbon.*instead/,
  ];

  const mentionsComponent = componentNames.some(p => p.test(titleAndBody));
  const makesApiClaim = apiClaimKeywords.some(p => p.test(titleAndBody));

  return mentionsComponent && makesApiClaim;
}

/**
 * Filter out unverified Carbon-specific findings
 * STRICT ENFORCEMENT: Carbon claims MUST be verified via carbon-mcp
 *
 * @param {Array} findings - Array of finding objects
 * @returns {Object} - { filtered: Array, stats: Object }
 */
function extractCarbonBuilderSkillReads(agentOutput = '') {
  const skillReadPatterns = [
    /\[using tool read_file:\s*([^\]]*\.bob\/skills\/carbon-builder\/[^\]]*)\]/gi,
    /read_file[^\n]*path["'=:\s]+([^\s"'\],]*\.bob\/skills\/carbon-builder\/[^\s"'\],]*)/gi,
    /Contents of file\s+([^:\n]*\.bob\/skills\/carbon-builder\/[^:\n]*):/gi,
    /relative to:\s*(\.bob\/skills\/carbon-builder\/[^\s\n]*)/gi
  ];

  const skillFilesRead = [];
  const seenSkillFiles = new Set();

  for (const pattern of skillReadPatterns) {
    let skillMatch;
    while ((skillMatch = pattern.exec(agentOutput)) !== null) {
      const filePath = skillMatch[1].trim();
      if (!seenSkillFiles.has(filePath)) {
        seenSkillFiles.add(filePath);
        skillFilesRead.push(filePath);
      }
    }
  }

  return skillFilesRead;
}

function filterUnverifiedCarbonFindings(findings, transcriptMetadata = {}) {
  // Skip filter if testing mode is enabled
  if (process.env.GITHUB_AI_AGENT_SKIP_CARBON_FILTER === 'true') {
    console.log('⚠️  Carbon verification filter DISABLED (test mode)');
    return {
      filtered: findings,
      stats: {
        total: findings.length,
        filtered: 0,
        carbonVerified: 0,
        carbonSpecific: 0,
        carbonBuilderVerified: 0,
        carbonBuilderRejected: 0,
        skillFilesRead: transcriptMetadata.skillFilesRead || []
      }
    };
  }

  let carbonSpecificCount = 0;
  let carbonVerifiedCount = 0;
  let filteredCount = 0;
  let carbonBuilderVerifiedCount = 0;
  let carbonBuilderRejectedCount = 0;
  const skillFilesRead = transcriptMetadata.skillFilesRead || [];
  const hasCarbonBuilderSkillReads = skillFilesRead.length > 0;

  const filtered = findings.filter((finding) => {
    // Non-Carbon findings pass through unconditionally — no auto-correction.
    // The agent is responsible for correct categorisation per the prompt rules.
    if (finding.verificationSource === 'not-carbon-specific') {
      return true;
    }

    const isCarbonBuilderFinding = finding.verificationSource === 'carbon-builder';
    const isMcpVerified = finding.carbonVerified === true &&
      (isCarbonBuilderFinding || finding.verificationSource === 'carbon-mcp');

    if (!isMcpVerified && !looksCarbonSpecific(finding)) {
      return true; // Not Carbon-specific, pass through
    }

    carbonSpecificCount++;

    if (isCarbonBuilderFinding && !hasCarbonBuilderSkillReads) {
      filteredCount++;
      carbonBuilderRejectedCount++;
      console.log(`❌ FILTERED carbon-builder finding without skill file reads: "${finding.title}"`);
      console.log('   Reason: verificationSource=carbon-builder but no .bob/skills/carbon-builder/ read_file calls were detected in the transcript');
      return false;
    }

    // HALLUCINATION CHECK: carbon-mcp findings must include a real quote from the
    // tool response as evidence. Vague phrases or empty strings are treated as
    // hallucinated verification and the finding is filtered out.
    if (isMcpVerified) {
      const evidence = (finding.mcpEvidence || '').trim();
      const isVague = !evidence ||
        /^(verified|confirmed|carbon mcp (confirm|verif)|mcp tools? (confirm|verif)|checked with)/i.test(evidence);

      if (isVague) {
        filteredCount++;
        console.log(`❌ FILTERED hallucinated verification for: "${finding.title}"`);
        console.log(`   mcpEvidence is absent or non-specific — omitting finding`);
        return false;
      }

      carbonVerifiedCount++;
      if (isCarbonBuilderFinding) {
        carbonBuilderVerifiedCount++;
      }
      return true;
    }

    // REJECT: Unverified Carbon claims are not allowed — per spec, omit them.
    filteredCount++;
    console.log(`❌ FILTERED unverified Carbon finding: "${finding.title}"`);
    console.log(`   Reason: carbonVerified=${finding.carbonVerified}, verificationSource=${finding.verificationSource}`);
    return false;
  });

  // Log summary only when there are Carbon-specific findings
  if (carbonSpecificCount > 0) {
    console.log(`\n📊 Carbon Verification Summary:`);
    console.log(`   Total findings: ${findings.length}`);
    console.log(`   Carbon-specific: ${carbonSpecificCount}`);
    console.log(`   MCP-verified: ${carbonVerifiedCount}`);
    console.log(`   Carbon Builder transcript-backed: ${carbonBuilderVerifiedCount}`);
    console.log(`   Carbon Builder rejected (no skill reads): ${carbonBuilderRejectedCount}`);
    console.log(`   Filtered (unverified): ${filteredCount}`);

    if (filteredCount > 0) {
      console.log(`\n❌ ${filteredCount} Carbon finding(s) filtered — missing or hallucinated MCP verification`);
      console.log(`   To fix: Ensure agent uses Carbon Builder skill + Carbon MCP tools and quotes tool response in mcpEvidence`);
    }
  }

  return {
    filtered,
    stats: {
      total: findings.length,
      carbonSpecific: carbonSpecificCount,
      carbonVerified: carbonVerifiedCount,
      carbonBuilderVerified: carbonBuilderVerifiedCount,
      carbonBuilderRejected: carbonBuilderRejectedCount,
      filtered: filteredCount,
      skillFilesRead
    }
  };
}

/**
 * Attempt to repair truncated JSON by closing incomplete structures
 *
 * @param {string} jsonStr - Potentially truncated JSON string
 * @returns {string} - Repaired JSON string
 */
function repairTruncatedJSON(jsonStr) {
  try {
    // First, try to parse as-is
    JSON.parse(jsonStr);
    return jsonStr; // Already valid
  } catch (e) {
    // JSON is invalid, attempt repair
    console.log('🔧 Attempting to repair truncated JSON...');
    
    // Strategy: Find the last complete finding and truncate there
    // A complete finding ends with either "},\n" or "}\n]"
    
    // Look for the last occurrence of a complete finding pattern
    // Pattern 1: },\n  { (another finding follows)
    // Pattern 2: }\n] (last finding in array)
    // Pattern 3: }, (simple comma separator)
    
    let repaired = jsonStr;
    let truncateAt = -1;
    
    // Find last complete finding by looking for "}," pattern
    // We need to ensure we're not inside a string when we find this
    let inString = false;
    let escapeNext = false;
    let lastValidComma = -1;
    
    for (let i = 0; i < repaired.length; i++) {
      const char = repaired[i];
      
      if (escapeNext) {
        escapeNext = false;
        continue;
      }
      
      if (char === '\\') {
        escapeNext = true;
        continue;
      }
      
      if (char === '"') {
        inString = !inString;
        continue;
      }
      
      // Look for "}," pattern outside of strings
      if (!inString && char === '}' && i + 1 < repaired.length && repaired[i + 1] === ',') {
        lastValidComma = i + 1; // Position after the comma
      }
    }
    
    // If we found a complete finding, truncate there
    if (lastValidComma !== -1) {
      repaired = repaired.substring(0, lastValidComma);
      console.log('✂️  Truncated to last complete finding');
    } else {
      // No complete findings found, try to salvage what we can
      // Look for the start of the findings array
      const findingsStart = repaired.indexOf('"findings"');
      if (findingsStart !== -1) {
        const arrayStart = repaired.indexOf('[', findingsStart);
        if (arrayStart !== -1) {
          // Truncate to just before the findings array and provide empty array
          repaired = repaired.substring(0, arrayStart + 1);
          console.log('✂️  No complete findings, using empty array');
        }
      }
    }
    
    // Now count what we need to close
    let braceCount = 0;
    let bracketCount = 0;
    inString = false;
    escapeNext = false;
    
    for (let i = 0; i < repaired.length; i++) {
      const char = repaired[i];
      
      if (escapeNext) {
        escapeNext = false;
        continue;
      }
      
      if (char === '\\') {
        escapeNext = true;
        continue;
      }
      
      if (char === '"') {
        inString = !inString;
        continue;
      }
      
      if (!inString) {
        if (char === '{') braceCount++;
        if (char === '}') braceCount--;
        if (char === '[') bracketCount++;
        if (char === ']') bracketCount--;
      }
    }
    
    // Close any open brackets first (for arrays)
    while (bracketCount > 0) {
      repaired += ']';
      bracketCount--;
    }
    
    // Close any open braces (for objects)
    while (braceCount > 0) {
      repaired += '}';
      braceCount--;
    }
    
    // Try to parse the repaired JSON
    try {
      JSON.parse(repaired);
      console.log('✅ Successfully repaired JSON');
      return repaired;
    } catch (e2) {
      console.warn('⚠️  Could not repair JSON:', e2.message);
      return jsonStr;
    }
  }
}

/**
 * Parse structured JSON review output from agent
 *
 * @param {string} agentOutput - Raw output from AI agent
 * @returns {Object|null} - Parsed review object or null if invalid
 */
function parseReviewOutput(agentOutput) {
  const skillFilesRead = extractCarbonBuilderSkillReads(agentOutput);

  try {
    // Find JSON markers — search for BEGIN_REVIEW_JSON immediately followed by
    // optional whitespace and '{', which is the only form that precedes real JSON.
    // The prompt text contains the bare marker as a literal, and the
    // attempt_completion echo contains it followed by prose — neither is followed
    // by '{'. This makes the match unambiguous regardless of marker count or order.
    const jsonStartMatch = agentOutput.match(/BEGIN_REVIEW_JSON\s*\{/);
    const jsonStart = jsonStartMatch
      ? agentOutput.indexOf(jsonStartMatch[0])
      : agentOutput.lastIndexOf('BEGIN_REVIEW_JSON'); // fallback for unexpected formats

    // Detect whether the agent wrote a visible catalogue before the JSON.
    // A legitimate run will have at least one SKIP, NO-FINDINGS, or catalogue
    // entry line before BEGIN_REVIEW_JSON. If none are present the agent likely
    // skipped its Step 1 work entirely — flag this so callers can warn.
    //
    // Formats handled (all observed in real agent output):
    //   - bare:          NO-FINDINGS file.ts — reason
    //   - bullet-prefix: - NO-FINDINGS file.ts — reason
    //   - bracket-style: [file.ts:33] — description — Category N — pending
    //   - backtick-wrap: `file.ts:66-75 — description — Category N — pending`
    //   - backtick file: `file.ts — description — Category N — pending`
    //   - SKIP:          SKIP file.ts — fixture
    const preJson = jsonStart !== -1 ? agentOutput.slice(0, jsonStart) : agentOutput;
    const hasCatalogue = /^`?(-\s+)?(SKIP |NO-FINDINGS |\[.+?\]\s*—|\S+\.\S*\s*—)/m.test(preJson);

    // Detect whether Step 2 resolutions were written visibly.
    // hasPendingItems: true when any catalogue line ends with "— Category N — pending"
    // (scoped regex avoids false positives from PR description text containing "pending").
    const hasPendingItems = /—\s*Category\s*\d\s*—\s*pending/i.test(preJson);

    // step2Window: the slice of preJson after the last PENDING catalogue line — this is
    // exclusively agent Step 2 output and cannot contain prompt text, preventing
    // false positives from the prompt's own "confirmed finding" / "discarded:" literals.
    // Scoped to "— pending" lines only: NO-FINDINGS and SKIP are already-resolved
    // dispositions that must not push the window past a discarded:/confirmed finding
    // line the agent wrote between a pending entry and its NO-FINDINGS/SKIP closing line.
    const lastCatalogueMatches = preJson.match(
      /^.*—\s*Category\s*\d\s*—\s*pending.*$/gim
    );
    const lastCatalogueEntry = lastCatalogueMatches
      ? lastCatalogueMatches[lastCatalogueMatches.length - 1]
      : null;
    const lastCatalogueEnd = lastCatalogueEntry !== null
      ? preJson.lastIndexOf(lastCatalogueEntry) + lastCatalogueEntry.length
      : -1;
    const step2Window = lastCatalogueEnd !== -1 ? preJson.slice(lastCatalogueEnd) : '';

    // hasResolutions: true when at least one visible resolution line appears after
    // the last catalogue entry, or when there were no pending items to resolve.
    const hasResolutions = hasPendingItems
      ? /\b(confirmed finding|discarded:)/i.test(step2Window)
      : true;

    // hasStep2: false signals a collapsed-thinking run where pending items were
    // never visibly resolved — treat as unreliable, same as hasCatalogue=false.
    const hasStep2 = !hasPendingItems || hasResolutions;
    
    if (jsonStart === -1) {
      // Check if Bob called attempt_completion with a prose summary instead of
      // writing the JSON block. This happens when the agent finds no issues and
      // short-circuits to attempt_completion. Extract the prose as summaryMarkdown
      // and return a valid empty-findings review rather than failing entirely.
      const completionMatch = agentOutput.match(/\[using tool attempt_completion:.*?\]\s*---output---\s*([\s\S]+?)\s*---output---/);
      if (completionMatch) {
        const prose = completionMatch[1].trim();
        console.warn('⚠️  No BEGIN_REVIEW_JSON marker — agent used attempt_completion. Synthesising empty-findings review.');
        return {
          summaryMarkdown: prose,
          findings: [],
          shouldPostInlineComments: false,
          verificationStats: {
            total: 0,
            carbonSpecific: 0,
            carbonVerified: 0,
            carbonBuilderVerified: 0,
            carbonBuilderRejected: 0,
            filtered: 0,
            skillFilesRead
          },
          // New fields — safe defaults so callers never dereference undefined
          hasCatalogue: false,
          recommendation: 'looks-good',
          recommendationRationale: 'Agent produced no structured findings.',
          catalogueWarning: 'Agent used attempt_completion — no structured catalogue was produced.',
          findingsTable: []
        };
      }

      console.error('❌ No BEGIN_REVIEW_JSON marker found in agent output');
      console.error('Agent output preview:', agentOutput.substring(0, 500));
      return null;
    }
    
    // Extract JSON - try to find END marker, but if not found, take everything
    const afterMarker = jsonStart + 'BEGIN_REVIEW_JSON'.length;
    const jsonEnd = agentOutput.indexOf('END_REVIEW_JSON', afterMarker);
    
    let jsonStr;
    if (jsonEnd !== -1) {
      // Found END marker - extract between markers
      jsonStr = agentOutput.substring(afterMarker, jsonEnd).trim();
    } else {
      // No END marker - take everything after BEGIN marker and try to parse
      jsonStr = agentOutput.substring(afterMarker).trim();
      console.warn('⚠️  No END_REVIEW_JSON marker, attempting to parse incomplete JSON');
      
      // Try to repair truncated JSON
      jsonStr = repairTruncatedJSON(jsonStr);
    }
    
    // Strip leading '+' diff prefixes — these appear when the agent writes the
    // JSON to a file via write_to_file and the tool echoes a unified diff to
    // stdout. Every line in the diff output is prefixed with '+', which makes
    // JSON.parse fail. Strip the prefix when every non-empty line starts with '+'.
    const nonEmptyLines = jsonStr.split('\n').filter(l => l.trim().length > 0);
    if (nonEmptyLines.length > 0 && nonEmptyLines.every(l => l.startsWith('+'))) {
      jsonStr = jsonStr.split('\n').map(l => l.startsWith('+') ? l.slice(1) : l).join('\n');
      console.warn('⚠️  Stripped write_to_file diff prefixes from JSON output');
    }

    // Additional cleanup: remove any leading/trailing non-JSON content
    // Look for the first '{' and last '}'
    const firstBrace = jsonStr.indexOf('{');
    const lastBrace = jsonStr.lastIndexOf('}');
    
    if (firstBrace === -1 || lastBrace === -1 || firstBrace >= lastBrace) {
      console.error('❌ No valid JSON object found in extracted content');
      console.error('Extracted content preview:', jsonStr.substring(0, 200));
      return null;
    }
    
    // Extract only the JSON object
    jsonStr = jsonStr.substring(firstBrace, lastBrace + 1);
    
    // Parse JSON
    const review = JSON.parse(jsonStr);

    // ── Schema normalisation ────────────────────────────────────────────────
    // The agent occasionally emits a non-standard schema (e.g. after using
    // write_to_file): severity uses "error"/"warning", fields are named
    // "message"/"description" instead of "title"/"body", and summaryMarkdown
    // is absent. Normalise these to the canonical schema before validation so
    // the review is recoverable rather than silently dropped.

    // 1. Synthesise summaryMarkdown when absent
    if (!review.summaryMarkdown && Array.isArray(review.findings)) {
      const count = review.findings.length;
      review.summaryMarkdown = count > 0
        ? `PR review produced ${count} finding(s). summaryMarkdown was absent from agent output — normalised by parser.`
        : 'No findings. summaryMarkdown was absent from agent output — normalised by parser.';
      console.warn('⚠️  summaryMarkdown absent — synthesised from finding count');
    }

    // 2. Normalise per-finding fields
    const SEVERITY_MAP = { error: 'blocking', warning: 'major', info: 'minor', hint: 'nit' };
    if (Array.isArray(review.findings)) {
      for (const f of review.findings) {
        // severity: "error" → "blocking", "warning" → "major", etc.
        if (f.severity && SEVERITY_MAP[f.severity]) {
          console.warn(`⚠️  Normalised severity "${f.severity}" → "${SEVERITY_MAP[f.severity]}"`);
          f.severity = SEVERITY_MAP[f.severity];
        }
        // title: prefer "title", fall back to "message"
        if (!f.title && f.message) {
          f.title = f.message;
        }
        // body: prefer "body", fall back to "description", then "suggestion"
        if (!f.body) {
          f.body = [f.description, f.suggestion].filter(Boolean).join(' ') || '';
        }
        // carbonVerified: default false when absent
        if (typeof f.carbonVerified !== 'boolean') {
          f.carbonVerified = f.verificationSource === 'carbon-mcp' || f.verificationSource === 'carbon-builder';
        }
      }
    }
    // ── End schema normalisation ────────────────────────────────────────────

    // Validate required fields
    if (!review.summaryMarkdown || typeof review.summaryMarkdown !== 'string') {
      console.error('❌ Invalid review: missing or invalid summaryMarkdown');
      return null;
    }
    
    if (!Array.isArray(review.findings)) {
      console.error('❌ Invalid review: findings must be an array');
      return null;
    }
    
    // Validate each finding
    for (const finding of review.findings) {
      if (!finding.severity || !['blocking', 'major', 'minor', 'nit'].includes(finding.severity)) {
        console.error('❌ Invalid finding: invalid severity', finding);
        return null;
      }
      
      if (!finding.file || typeof finding.file !== 'string') {
        console.error('❌ Invalid finding: missing or invalid file', finding);
        return null;
      }
      
      if (!finding.title || typeof finding.title !== 'string') {
        console.error('❌ Invalid finding: missing or invalid title', finding);
        return null;
      }
      
      if (!finding.body || typeof finding.body !== 'string') {
        console.error('❌ Invalid finding: missing or invalid body', finding);
        return null;
      }

      // Soft warning: non-nit findings with very short bodies likely lack an actionable suggestion
      if (finding.body.length < 40 && finding.severity !== 'nit') {
        console.warn(`⚠️  Finding "${finding.title}" has a short body (${finding.body.length} chars) — may be missing an actionable suggestion`);
      }
    }
    
    // Filter unverified Carbon findings with strict enforcement
    const filterResult = filterUnverifiedCarbonFindings(review.findings, { skillFilesRead });
    review.findings = filterResult.filtered;
    
    // Store verification stats for reporting
    review.verificationStats = filterResult.stats;

    // Record whether a visible catalogue was present — callers use this to
    // warn when the agent skipped its Step 1 work.
    review.hasCatalogue = hasCatalogue;

    // ─── computeRecommendation MUST be called last, after both
    // filterUnverifiedCarbonFindings and hasCatalogue are set. ─────────────
    const { recommendation, recommendationRationale } = computeRecommendation(
      review.findings,
      { hasCatalogue, hasStep2, verificationStats: review.verificationStats }
    );
    review.recommendation = recommendation;
    review.recommendationRationale = recommendationRationale;

    // Catalogue warning — three-way check:
    //   1. No catalogue at all (Step 1 skipped)
    //   2. Pending items exist but no visible resolutions (Step 2 collapsed into thinking)
    //   3. Clean run — no warning
    review.catalogueWarning = !hasCatalogue
      ? 'No file catalogue was found in this review\'s output. The agent may have skipped Step 1 analysis. Zero findings here cannot be confirmed as a clean review — re-running is recommended.'
      : !hasStep2
        ? 'Pending catalogue items were detected but no Step 2 resolution lines were visible in the agent output — resolutions may have been collapsed into thinking blocks. Findings here may be incomplete — re-running is recommended.'
        : null;

    // Build findingsTable — typed array of objects, never Markdown strings.
    // formatSummaryComment renders this as a Markdown table; agent never touches pipes.
    review.findingsTable = review.findings.map(f => ({
      area: (f.verificationSource === 'carbon-mcp' || f.verificationSource === 'carbon-builder') ? 'Carbon API' : 'General',
      category: (f.verificationSource === 'carbon-mcp' || f.verificationSource === 'carbon-builder') ? 'Cat 1' : 'Cat 2',
      severity: f.severity,
      title: f.title,
      file: f.file
    }));

    return review;
    
  } catch (error) {
    console.error('❌ Error parsing review output:', error.message);
    
    // Show more context for debugging
    if (error instanceof SyntaxError) {
      console.error('\n📋 Debugging Information:');
      console.error('Error type: JSON Syntax Error');
      
      // Try to show the problematic area
      const match = error.message.match(/position (\d+)/);
      if (match) {
        const position = parseInt(match[1]);
        const start = Math.max(0, position - 50);
        const end = Math.min(agentOutput.length, position + 50);
        console.error(`Context around error position ${position}:`);
        console.error(agentOutput.substring(start, end));
      }
      
      // Show first 500 chars of agent output
      console.error('\nAgent output preview (first 500 chars):');
      console.error(agentOutput.substring(0, 500));
      
      // Check for markers
      const hasBegin = agentOutput.includes('BEGIN_REVIEW_JSON');
      const hasEnd = agentOutput.includes('END_REVIEW_JSON');
      console.error(`\nMarkers found: BEGIN=${hasBegin}, END=${hasEnd}`);
    }
    
    return null;
  }
}

/**
 * Compute a PR-level recommendation from post-filter findings.
 *
 * Priority ladder (first matching rule wins):
 *   1. hasCatalogue === false              → suggested-improvements (review unreliable)
 *   2. MCP partial unavailability          → suggested-improvements (incomplete review)
 *   3. ≥1 blocking finding                 → consider-revising
 *   4. ≥2 major findings                   → consider-revising
 *   5. ≥1 major OR ≥1 minor finding        → suggested-improvements
 *   6. else (nits only or empty)           → looks-good
 *
 * MUST be called after filterUnverifiedCarbonFindings and hasCatalogue are set.
 *
 * @param {Array}  findings         - Post-filter findings array
 * @param {Object} opts
 * @param {boolean} opts.hasCatalogue      - Whether Step 1 catalogue was present
 * @param {Object}  opts.verificationStats - { carbonSpecific, carbonVerified, ... }
 * @returns {{ recommendation: string, recommendationRationale: string }}
 */
function computeRecommendation(findings, { hasCatalogue, hasStep2 = true, verificationStats = {} }) {
  const counts = countBySeverity(findings);

  // Rule 1 — no catalogue: review reliability is unknown
  if (!hasCatalogue) {
    return {
      recommendation: 'suggested-improvements',
      recommendationRationale:
        'Review reliability is uncertain — no Step 1 file catalogue was detected in the agent output.'
    };
  }

  // Rule 1b — catalogue present but Step 2 collapsed into thinking
  if (!hasStep2) {
    return {
      recommendation: 'suggested-improvements',
      recommendationRationale:
        'Review reliability is uncertain — pending catalogue items were not visibly resolved. Step 2 may have been collapsed into thinking blocks.'
    };
  }

  // Rule 2 — MCP partially unavailable: Cat 1 findings may be missing
  const mcpPartiallyUnavailable =
    (verificationStats.carbonSpecific || 0) > 0 &&
    (verificationStats.carbonVerified || 0) === 0;
  if (mcpPartiallyUnavailable) {
    return {
      recommendation: 'suggested-improvements',
      recommendationRationale:
        'Carbon-specific findings may be incomplete — Carbon MCP returned no verified results during this run.'
    };
  }

  // Rule 3 — any blocking finding
  if (counts.blocking >= 1) {
    const ex = findings.find(f => f.severity === 'blocking');
    return {
      recommendation: 'consider-revising',
      recommendationRationale:
        `${counts.blocking} blocking finding${counts.blocking > 1 ? 's' : ''}: "${ex ? ex.title : 'see findings below'}"`
    };
  }

  // Rule 4 — two or more major findings
  if (counts.major >= 2) {
    return {
      recommendation: 'consider-revising',
      recommendationRationale:
        `${counts.major} major findings that should be addressed before merge.`
    };
  }

  // Rule 5 — any major or any minor finding
  if (counts.major >= 1 || counts.minor >= 1) {
    const total = counts.major + counts.minor;
    const parts = [];
    if (counts.major) parts.push(`${counts.major} major`);
    if (counts.minor) parts.push(`${counts.minor} minor`);
    return {
      recommendation: 'suggested-improvements',
      recommendationRationale:
        `${total} finding${total > 1 ? 's' : ''} worth considering: ${parts.join(', ')}.`
    };
  }

  // Rule 6 — nits only or no findings
  const nitNote = counts.nit > 0
    ? `${counts.nit} optional nit${counts.nit > 1 ? 's' : ''} noted.`
    : 'No issues found.';
  return {
    recommendation: 'looks-good',
    recommendationRationale: nitNote
  };
}

/**
 * Count findings by severity
 *
 * @param {Array} findings - Array of finding objects
 * @returns {Object} - Count by severity level
 */
function countBySeverity(findings) {
  const counts = {
    blocking: 0,
    major: 0,
    minor: 0,
    nit: 0
  };
  
  findings.forEach(finding => {
    const severity = finding.severity || 'minor';
    if (counts[severity] !== undefined) {
      counts[severity]++;
    }
  });
  
  return counts;
}

module.exports = {
  parseReviewOutput,
  filterUnverifiedCarbonFindings,
  looksCarbonSpecific,
  countBySeverity,
  computeRecommendation
};

// Made with Bob
