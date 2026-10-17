/**
 * Parse and validate structured JSON review output from AI agents
 * STRICTLY filters Carbon-specific claims that lack proper carbon-mcp verification
 */

// General-purpose JSON repair, used ONLY as a last-resort syntactic fallback after
// the bespoke passes below have failed (see parseReviewOutput). It never runs on
// output that already parses, so it cannot alter a currently-passing review.
const { jsonrepair } = require('jsonrepair');

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
    /\$[a-z]+-\d+/, // Carbon tokens like $spacing-05, $layer-01
    /cds--[a-z]/, // Carbon CSS class prefixes in finding text
    /bx--[a-z]/, // Legacy Carbon CSS class prefixes
    /\bcarbon'?s?\s+\w+/, // "Carbon DataTable", "Carbon's Button", etc.
  ];

  if (strongPatterns.some((p) => p.test(titleAndBody))) {
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

  const mentionsComponent = componentNames.some((p) => p.test(titleAndBody));
  const makesApiClaim = apiClaimKeywords.some((p) => p.test(titleAndBody));

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
  // v1 patterns — capture a file path from the transcript
  const capturePatterns = [
    /\[using tool read_file:\s*([^\]]*\.bob\/skills\/carbon-builder\/[^\]]*)\]/gi,
    /read_file[^\n]*path["'=:\s]+([^\s"'\],]*\.bob\/skills\/carbon-builder\/[^\s"'\],]*)/gi,
    /Contents of file\s+([^:\n]*\.bob\/skills\/carbon-builder\/[^:\n]*):/gi,
    /relative to:\s*(\.bob\/skills\/carbon-builder\/[^\s\n]*)/gi,
  ];

  // v2 patterns — use_skill is a first-class tool; no read_file call appears.
  // Match the post-call result block: "Tool: use_skill" followed by
  // "skill_name: carbon-builder" (with any intervening whitespace/padding).
  const presencePatterns = [
    /Tool:\s*use_skill[\s\S]*?skill_name:\s*carbon-builder/i,
  ];

  const skillFilesRead = [];
  const seenSkillFiles = new Set();

  for (const pattern of capturePatterns) {
    let skillMatch;
    while ((skillMatch = pattern.exec(agentOutput)) !== null) {
      const filePath = skillMatch[1].trim();
      if (!seenSkillFiles.has(filePath)) {
        seenSkillFiles.add(filePath);
        skillFilesRead.push(filePath);
      }
    }
  }

  for (const pattern of presencePatterns) {
    if (
      pattern.test(agentOutput) &&
      !seenSkillFiles.has('use_skill:carbon-builder')
    ) {
      seenSkillFiles.add('use_skill:carbon-builder');
      skillFilesRead.push('use_skill:carbon-builder');
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
        skillFilesRead: transcriptMetadata.skillFilesRead || [],
      },
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

    const isCarbonBuilderFinding =
      finding.verificationSource === 'carbon-builder';
    const isMcpVerified =
      finding.carbonVerified === true &&
      (isCarbonBuilderFinding || finding.verificationSource === 'carbon-mcp');

    if (!isMcpVerified && !looksCarbonSpecific(finding)) {
      return true; // Not Carbon-specific, pass through
    }

    carbonSpecificCount++;

    if (isCarbonBuilderFinding && !hasCarbonBuilderSkillReads) {
      filteredCount++;
      carbonBuilderRejectedCount++;
      console.log(
        `❌ FILTERED carbon-builder finding without skill file reads: "${finding.title}"`
      );
      console.log(
        '   Reason: verificationSource=carbon-builder but no .bob/skills/carbon-builder/ read_file calls were detected in the transcript'
      );
      return false;
    }

    // HALLUCINATION CHECK: carbon-mcp findings must include a real quote from the
    // tool response as evidence. Vague phrases or empty strings are treated as
    // hallucinated verification and the finding is filtered out.
    if (isMcpVerified) {
      const evidence = (finding.mcpEvidence || '').trim();
      const isVague =
        !evidence ||
        /^(verified|confirmed|carbon mcp (confirm|verif)|mcp tools? (confirm|verif)|checked with)/i.test(
          evidence
        );

      if (isVague) {
        filteredCount++;
        console.log(
          `❌ FILTERED hallucinated verification for: "${finding.title}"`
        );
        console.log(
          `   mcpEvidence is absent or non-specific — omitting finding`
        );
        return false;
      }

      carbonVerifiedCount++;
      if (isCarbonBuilderFinding) {
        carbonBuilderVerifiedCount++;
      }
      return true;
    }

    // REJECT: Unverified Carbon claims are not allowed — omit them.
    filteredCount++;
    console.log(`❌ FILTERED unverified Carbon finding: "${finding.title}"`);
    console.log(
      `   Reason: carbonVerified=${finding.carbonVerified}, verificationSource=${finding.verificationSource}`
    );
    return false;
  });

  // Log summary only when there are Carbon-specific findings.
  //
  // Carbon MCP is always the evidence source: every kept Carbon finding quotes an
  // MCP tool response. The Carbon Builder skill is the guidance layer that governs
  // those MCP calls — it does not independently verify anything — so the summary
  // does NOT split "verified" into skill-vs-MCP. Whether the skill was engaged is
  // reported once at the run level (the "🔬 loaded and used" line above).
  if (carbonSpecificCount > 0) {
    console.log(
      `\n📊 Carbon verification (claims checked against Carbon MCP, the evidence source):`
    );
    console.log(`   Findings in this review: ${findings.length}`);
    // One breakdown line — claims = kept + dropped — rather than separate "claims"
    // and "kept" lines that read as identical whenever nothing is dropped.
    console.log(
      `   Carbon-specific claims: ${carbonSpecificCount} — ${carbonVerifiedCount} verified & kept, ${filteredCount} dropped`
    );

    if (filteredCount > 0) {
      console.log(
        `   ${filteredCount} dropped for missing or unconvincing evidence — to fix, verify Carbon claims via Carbon MCP and quote the tool response as evidence.`
      );
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
      skillFilesRead,
    },
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
      if (
        !inString &&
        char === '}' &&
        i + 1 < repaired.length &&
        repaired[i + 1] === ','
      ) {
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
 * Escape stray backslash sequences that are not valid JSON escapes.
 *
 * The sanitiser passes in parseReviewOutput repair v2 line-wraps and unescaped
 * double-quotes, but never invalid backslash escapes. When the agent writes prose
 * containing a lone backslash (a regex like \d, a Windows path, escaped markdown
 * like \_), JSON.parse throws "Bad escaped character" and the whole review is
 * dropped. This walks the string and, inside string literals only, doubles any
 * backslash that does not begin a valid JSON escape (\" \\ \/ \b \f \n \r \t
 * \uXXXX) so it parses as a literal backslash. Valid escapes are passed through
 * untouched, so a correctly-escaped value is never altered.
 *
 * Only ever called AFTER an initial JSON.parse has already failed — the happy
 * path never touches it — so it cannot regress a review that currently parses.
 *
 * @param {string} str - JSON string that failed to parse
 * @returns {string} - JSON string with invalid escapes repaired
 */
function escapeInvalidJsonEscapes(str) {
  const VALID_ESCAPE = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't']);
  let out = '';
  let inString = false;

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];

    if (!inString) {
      out += ch;
      if (ch === '"') inString = true;
      continue;
    }

    // Inside a string literal
    if (ch === '"') {
      out += ch;
      inString = false;
      continue;
    }

    if (ch === '\\') {
      const next = str[i + 1];
      // Valid \uXXXX escape — pass the whole sequence through untouched
      if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(str.slice(i + 2, i + 6))) {
        out += str.slice(i, i + 6);
        i += 5;
        continue;
      }
      // Valid two-character escape (including an already-escaped \\) — pass through
      if (VALID_ESCAPE.has(next)) {
        out += ch + next;
        i += 1;
        continue;
      }
      // Invalid escape — double the backslash so it becomes a literal '\'. `next`
      // is intentionally left for the following iteration to emit as an ordinary
      // character.
      out += '\\\\';
      continue;
    }

    out += ch;
  }

  return out;
}

/**
 * Parse structured JSON review output from agent
 *
 * @param {string} agentOutput - Raw output from AI agent
 * @returns {Object|null} - Parsed review object or null if invalid
 */
function parseReviewOutput(agentOutput) {
  const skillFilesRead = extractCarbonBuilderSkillReads(agentOutput);

  // Holds the exact JSON string handed to JSON.parse, so a SyntaxError's byte
  // position can be shown against the real JSON rather than the raw transcript.
  let jsonForDiagnostics = null;

  try {
    // Find JSON markers — search for the LAST BEGIN_REVIEW_JSON immediately followed
    // by optional whitespace and '{'. Using the last match is critical for Bob v2,
    // which echoes the full conversation as a transcript: the prompt itself contains
    // BEGIN_REVIEW_JSON as a literal instruction, so the first match always lands
    // inside the prompt echo rather than the agent's actual output.
    const markerRe = /BEGIN_REVIEW_JSON\s*\{/g;
    let jsonStartMatch = null;
    let m;
    while ((m = markerRe.exec(agentOutput)) !== null) jsonStartMatch = m;
    const jsonStart = jsonStartMatch
      ? jsonStartMatch.index
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
    const preJson =
      jsonStart !== -1 ? agentOutput.slice(0, jsonStart) : agentOutput;
    const hasCatalogue =
      /^`?(-\s+)?(SKIP |NO-FINDINGS |\[.+?\]\s*—|\S+\.\S*\s*—)/m.test(preJson);

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
    const lastCatalogueEnd =
      lastCatalogueEntry !== null
        ? preJson.lastIndexOf(lastCatalogueEntry) + lastCatalogueEntry.length
        : -1;
    const step2Window =
      lastCatalogueEnd !== -1 ? preJson.slice(lastCatalogueEnd) : '';

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
      //
      // v1 pretty format: [using tool attempt_completion:...] ---output--- <prose> ---output---
      // v2 pretty format: [attempt_completion] Result: <prose>  (no closing delimiter)
      // The greedy [\s\S]+ with .trim() on the captured group handles both trailing
      // whitespace and any stray boundary characters safely.
      const completionMatch =
        agentOutput.match(/\[attempt_completion\]\s*Result:\s*([\s\S]+)/) ||
        agentOutput.match(
          /\[using tool attempt_completion:.*?\]\s*---output---\s*([\s\S]+?)\s*---output---/
        );
      if (completionMatch) {
        const prose = completionMatch[1].trim();
        console.warn(
          '⚠️  No BEGIN_REVIEW_JSON marker — agent used attempt_completion. Synthesising empty-findings review.'
        );
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
            skillFilesRead,
          },
          // New fields — safe defaults so callers never dereference undefined
          hasCatalogue: false,
          recommendation: 'looks-good',
          recommendationRationale: 'Agent produced no structured findings.',
          catalogueWarning:
            'Agent used attempt_completion — no structured catalogue was produced.',
          findingsTable: [],
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
      console.warn(
        '⚠️  No END_REVIEW_JSON marker, attempting to parse incomplete JSON'
      );

      // Try to repair truncated JSON
      jsonStr = repairTruncatedJSON(jsonStr);
    }

    // Strip leading '+' diff prefixes — these appear when the agent writes the
    // JSON to a file via write_to_file and the tool echoes a unified diff to
    // stdout. Every line in the diff output is prefixed with '+', which makes
    // JSON.parse fail. Strip the prefix when every non-empty line starts with '+'.
    const nonEmptyLines = jsonStr
      .split('\n')
      .filter((l) => l.trim().length > 0);
    if (
      nonEmptyLines.length > 0 &&
      nonEmptyLines.every((l) => l.startsWith('+'))
    ) {
      jsonStr = jsonStr
        .split('\n')
        .map((l) => (l.startsWith('+') ? l.slice(1) : l))
        .join('\n');
      console.warn('⚠️  Stripped write_to_file diff prefixes from JSON output');
    }

    // Bob v2 pretty-format fix: every output line is padded to 120 characters,
    // causing JSON string values to be word-wrapped with trailing spaces before \n.
    // Step 1 — strip trailing spaces from every line (removes the padding).
    // Step 2 — walk char-by-char: any bare \n that remains inside a JSON string
    //           is a line-wrap artifact; replace it with a space so the value
    //           reads as a single unbroken string (matching v1 behaviour).
    if (jsonStr.split('\n').some((l) => l !== l.trimEnd())) {
      console.warn('⚠️  Detected v2 line-padding in JSON output — normalising');
      const trimmedLines = jsonStr
        .split('\n')
        .map((l) => l.trimEnd())
        .join('\n');
      let fixed = '';
      let inStr = false;
      let i = 0;
      while (i < trimmedLines.length) {
        const ch = trimmedLines[i];
        if (!inStr) {
          if (ch === '"') inStr = true;
          fixed += ch;
          i++;
        } else {
          if (ch === '\\' && i + 1 < trimmedLines.length) {
            // Already-escaped sequence — pass through verbatim
            fixed += ch + trimmedLines[i + 1];
            i += 2;
          } else if (ch === '"') {
            inStr = false;
            fixed += ch;
            i++;
          } else if (ch === '\n') {
            // Bare newline inside a string = v2 line-wrap; replace with space
            fixed += ' ';
            i++;
          } else {
            fixed += ch;
            i++;
          }
        }
      }
      jsonStr = fixed;

      // After pass 1, some string fields may still contain unescaped double-quote
      // characters — e.g. the agent wrote role="dialog" or ["style","align"] inside
      // a string value. These cannot be fixed by the char-by-char pass because they
      // look like valid JSON structure to a sequential scanner.
      // Pass 2: if JSON.parse still fails, walk every line. For any line that opens
      // a string value ("key": "...) check whether the value closes properly on that
      // same line. If it doesn't (i.e. the closing " is missing or there are bare
      // interior quotes), replace all bare " inside the value with ' to sanitise it.
      // Accumulate continuation lines until a properly-closing line is found.
      try {
        JSON.parse(jsonStr);
      } catch (_) {
        const lines = jsonStr.split('\n');
        const rebuilt = [];
        let i2 = 0;
        while (i2 < lines.length) {
          const line = lines[i2];
          const lt = line.trimStart();
          // Detect a line that opens a string value: "key": "...
          if (/^"[^"]+"\s*:\s*"/.test(lt)) {
            // Accumulate continuation lines until we reach the next key or a closing
            // bracket — those signal the value (however many lines) has ended.
            let j = i2 + 1;
            while (j < lines.length) {
              const jt = lines[j].trimStart();
              if (/^"[^"]+"\s*:/.test(jt) || /^[}\]]/.test(jt)) break;
              j++;
            }
            const valueLines = lines.slice(i2, j);
            const assembled = valueLines.join(' ');

            // Test whether the assembled value is already valid JSON
            const keyPart = assembled.match(/^(\s*"[^"]+"\s*:\s*)/)[1];
            const rawValue = assembled.slice(keyPart.length);
            // rawValue should be: "...content...", or "...content..."
            // Try parsing it as a standalone JSON string
            const trailingStrip = rawValue
              .trimEnd()
              .replace(/,$/, '')
              .trimEnd();
            let isClean = false;
            try {
              JSON.parse(trailingStrip);
              isClean = true;
            } catch (_2) {}

            if (!isClean) {
              // The value has unescaped interior quotes. Reconstruct it by:
              // 1. Strip the outer opening " and closing " (plus optional trailing ,)
              // 2. Replace bare " and also \" (escaped-quote sequences left by the
              //    agent) with ' — the \ must be removed too or it becomes \' which
              //    is itself an invalid escape in a JSON string.
              const inner = trailingStrip.slice(1, -1); // remove outer quotes
              const sanitised = inner.replace(/\\"/g, "'").replace(/"/g, "'");
              const trailingComma = rawValue.trimEnd().endsWith(',') ? ',' : '';
              rebuilt.push(keyPart + '"' + sanitised + '"' + trailingComma);
              console.warn(
                `⚠️  Sanitised unescaped quotes in field (lines ${i2}–${j - 1})`
              );
              i2 = j;
              continue;
            }
          }
          rebuilt.push(line);
          i2++;
        }
        // Remove trailing commas before } or ] left behind by any replacement
        jsonStr = rebuilt.join('\n').replace(/,(\s*[}\]])/g, '$1');
      }
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

    // Record the exact string handed to JSON.parse so the catch block's
    // position-based diagnostic points at the real JSON, not the raw transcript.
    jsonForDiagnostics = jsonStr;

    // Parse JSON. The sanitiser passes above repair v2 line-wraps and unescaped
    // quotes but not invalid backslash escapes (\d, \., \_, Windows paths, escaped
    // markdown) — those surface here as "Bad escaped character". Retry once with
    // stray backslashes escaped; if it still fails, surface the ORIGINAL error so
    // diagnostics are unchanged. The first-try success path is left untouched.
    let review;
    try {
      review = JSON.parse(jsonStr);
    } catch (primaryParseError) {
      const escapeRepaired = escapeInvalidJsonEscapes(jsonStr);
      try {
        review = JSON.parse(escapeRepaired);
        jsonStr = escapeRepaired;
        jsonForDiagnostics = escapeRepaired;
        console.warn(
          '⚠️  Escaped invalid backslash sequence(s) in JSON output'
        );
      } catch (_) {
        // Last-resort fallback — jsonrepair: robust general syntactic repair
        // (unescaped quotes, trailing commas, bad escapes, missing quotes). Reached
        // ONLY after the two repairs above have already failed, so no review that
        // currently parses can be affected. Recovering here avoids falling through
        // to the agent retry, which re-runs the model and doubles the token/coin
        // spend for the PR. The semantic passes (v2 line-wrap collapse, truncation
        // salvage) still run first; jsonrepair only does syntactic cleanup on their
        // output, and any hollow finding it yields is still rejected by the
        // per-finding schema validation below. Wrapped so a jsonrepair failure
        // surfaces the ORIGINAL parse error — identical to today's behaviour.
        try {
          const jsonRepaired = jsonrepair(jsonStr);
          review = JSON.parse(jsonRepaired);
          jsonStr = jsonRepaired;
          jsonForDiagnostics = jsonRepaired;
          console.warn('⚠️  Recovered malformed JSON via jsonrepair');
        } catch (_2) {
          throw primaryParseError;
        }
      }
    }

    // ── Schema normalisation ────────────────────────────────────────────────
    // The agent occasionally emits a non-standard schema (e.g. after using
    // write_to_file): severity uses "error"/"warning", fields are named
    // "message"/"description" instead of "title"/"body", and summaryMarkdown
    // is absent. Normalise these to the canonical schema before validation so
    // the review is recoverable rather than silently dropped.

    // 1. Synthesise summaryMarkdown when absent
    if (!review.summaryMarkdown && Array.isArray(review.findings)) {
      const count = review.findings.length;
      review.summaryMarkdown =
        count > 0
          ? `PR review produced ${count} finding(s). summaryMarkdown was absent from agent output — normalised by parser.`
          : 'No findings. summaryMarkdown was absent from agent output — normalised by parser.';
      console.warn(
        '⚠️  summaryMarkdown absent — synthesised from finding count'
      );
    }

    // 2. Normalise per-finding fields
    const SEVERITY_MAP = {
      error: 'blocking',
      warning: 'major',
      info: 'minor',
      hint: 'nit',
    };
    if (Array.isArray(review.findings)) {
      for (const f of review.findings) {
        // severity: "error" → "blocking", "warning" → "major", etc.
        if (f.severity && SEVERITY_MAP[f.severity]) {
          console.warn(
            `⚠️  Normalised severity "${f.severity}" → "${SEVERITY_MAP[f.severity]}"`
          );
          f.severity = SEVERITY_MAP[f.severity];
        }
        // title: prefer "title", fall back to "message"
        if (!f.title && f.message) {
          f.title = f.message;
        }
        // body: prefer "body", fall back to "description", then "suggestion"
        if (!f.body) {
          f.body =
            [f.description, f.suggestion].filter(Boolean).join(' ') || '';
        }
        // carbonVerified: default false when absent
        if (typeof f.carbonVerified !== 'boolean') {
          f.carbonVerified =
            f.verificationSource === 'carbon-mcp' ||
            f.verificationSource === 'carbon-builder';
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
      if (
        !finding.severity ||
        !['blocking', 'major', 'minor', 'nit'].includes(finding.severity)
      ) {
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
        console.warn(
          `⚠️  Finding "${finding.title}" has a short body (${finding.body.length} chars) — may be missing an actionable suggestion`
        );
      }
    }

    // Filter unverified Carbon findings with strict enforcement
    const filterResult = filterUnverifiedCarbonFindings(review.findings, {
      skillFilesRead,
    });
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
      ? "No file catalogue was found in this review's output. The agent may have skipped Step 1 analysis. Zero findings here cannot be confirmed as a clean review — re-running is recommended."
      : !hasStep2
        ? 'Pending catalogue items were detected but no Step 2 resolution lines were visible in the agent output — resolutions may have been collapsed into thinking blocks. Findings here may be incomplete — re-running is recommended.'
        : null;

    // Build findingsTable — typed array of objects, never Markdown strings.
    // formatSummaryComment renders this as a Markdown table; agent never touches pipes.
    review.findingsTable = review.findings.map((f) => ({
      area:
        f.verificationSource === 'carbon-mcp' ||
        f.verificationSource === 'carbon-builder'
          ? 'Carbon API'
          : 'General',
      category:
        f.verificationSource === 'carbon-mcp' ||
        f.verificationSource === 'carbon-builder'
          ? 'Cat 1'
          : 'Cat 2',
      severity: f.severity,
      title: f.title,
      file: f.file,
    }));

    return review;
  } catch (error) {
    console.error('❌ Error parsing review output:', error.message);

    // Show more context for debugging
    if (error instanceof SyntaxError) {
      console.error('\n📋 Debugging Information:');
      console.error('Error type: JSON Syntax Error');

      // Try to show the problematic area. A JSON SyntaxError's position is a byte
      // offset into the string handed to JSON.parse (the extracted JSON), not the
      // raw transcript — slice that so the context points at the real error site.
      const match = error.message.match(/position (\d+)/);
      if (match) {
        const position = parseInt(match[1]);
        const source =
          jsonForDiagnostics != null ? jsonForDiagnostics : agentOutput;
        const start = Math.max(0, position - 50);
        const end = Math.min(source.length, position + 50);
        console.error(`Context around error position ${position}:`);
        console.error(source.substring(start, end));
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
function computeRecommendation(
  findings,
  { hasCatalogue, hasStep2 = true, verificationStats = {} }
) {
  const counts = countBySeverity(findings);

  // Rule 1 — no catalogue: review reliability is unknown
  if (!hasCatalogue) {
    return {
      recommendation: 'suggested-improvements',
      recommendationRationale:
        'Review reliability is uncertain — no Step 1 file catalogue was detected in the agent output.',
    };
  }

  // Rule 1b — catalogue present but Step 2 collapsed into thinking
  if (!hasStep2) {
    return {
      recommendation: 'suggested-improvements',
      recommendationRationale:
        'Review reliability is uncertain — pending catalogue items were not visibly resolved. Step 2 may have been collapsed into thinking blocks.',
    };
  }

  // Rule 2 — MCP partially unavailable: Cat 1 findings may be missing.
  // Only fires when there were carbon-specific findings that survived filtering
  // but none were MCP-verified. If all carbon-specific findings were rejected/
  // filtered out (e.g. carbon-builder claimed without skill reads), the surviving
  // findings are all Cat 2 and MCP was correctly not used — no warning needed.
  const survivingCarbonSpecific =
    (verificationStats.carbonSpecific || 0) - (verificationStats.filtered || 0);
  const mcpPartiallyUnavailable =
    survivingCarbonSpecific > 0 &&
    (verificationStats.carbonVerified || 0) === 0;
  if (mcpPartiallyUnavailable) {
    return {
      recommendation: 'suggested-improvements',
      recommendationRationale:
        'Carbon-specific findings may be incomplete — Carbon MCP returned no verified results during this run.',
    };
  }

  // Rule 3 — any blocking finding
  if (counts.blocking >= 1) {
    const ex = findings.find((f) => f.severity === 'blocking');
    return {
      recommendation: 'consider-revising',
      recommendationRationale: `${counts.blocking} blocking finding${counts.blocking > 1 ? 's' : ''}: "${ex ? ex.title : 'see findings below'}"`,
    };
  }

  // Rule 4 — two or more major findings
  if (counts.major >= 2) {
    return {
      recommendation: 'consider-revising',
      recommendationRationale: `${counts.major} major findings that should be addressed before merge.`,
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
      recommendationRationale: `${total} finding${total > 1 ? 's' : ''} worth considering: ${parts.join(', ')}.`,
    };
  }

  // Rule 6 — nits only or no findings
  const nitNote =
    counts.nit > 0
      ? `${counts.nit} optional nit${counts.nit > 1 ? 's' : ''} noted.`
      : 'No issues found.';
  return {
    recommendation: 'looks-good',
    recommendationRationale: nitNote,
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
    nit: 0,
  };

  findings.forEach((finding) => {
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
  extractCarbonBuilderSkillReads,
  escapeInvalidJsonEscapes,
  looksCarbonSpecific,
  countBySeverity,
  computeRecommendation,
};
