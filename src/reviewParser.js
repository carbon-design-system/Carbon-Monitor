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
function filterUnverifiedCarbonFindings(findings) {
  // Skip filter if testing mode is enabled
  if (process.env.GITHUB_AI_AGENT_SKIP_CARBON_FILTER === 'true') {
    console.log('⚠️  Carbon verification filter DISABLED (test mode)');
    return { filtered: findings, stats: { total: findings.length, filtered: 0, carbonVerified: 0 } };
  }

  let carbonSpecificCount = 0;
  let carbonVerifiedCount = 0;
  let filteredCount = 0;
  let dualVerifiedCount = 0;

  const isVagueEvidence = (text, label) => {
    const t = (text || '').trim();
    return !t || /^(verified|confirmed|carbon (mcp|builder skill) (confirm|verif)|mcp tools? (confirm|verif)|skill (confirm|verif)|checked with)/i.test(t);
  };

  const filtered = findings.filter((finding) => {
    // Non-Carbon findings pass through unconditionally — no auto-correction.
    // The agent is responsible for correct categorisation per the prompt rules.
    if (finding.verificationSource === 'not-carbon-specific') {
      return true;
    }

    const isMcpVerified   = finding.carbonVerified === true && finding.verificationSource === 'carbon-mcp';
    const isSkillVerified = finding.carbonVerified === true && finding.verificationSource === 'carbon-builder-skill';

    if (!isMcpVerified && !isSkillVerified && !looksCarbonSpecific(finding)) {
      return true; // Not Carbon-specific, pass through
    }

    carbonSpecificCount++;

    // GOLD STANDARD: Category 1 finding has both skillEvidence (Step 1) and mcpEvidence (Step 2).
    // Accept it if neither evidence field is vague.
    if (isMcpVerified) {
      const mcpEvidence   = (finding.mcpEvidence   || '').trim();
      const skillEvidence = (finding.skillEvidence  || '').trim();

      const mcpVague   = isVagueEvidence(mcpEvidence);
      const skillVague = isVagueEvidence(skillEvidence);

      if (mcpVague) {
        filteredCount++;
        console.log(`❌ FILTERED hallucinated MCP verification for: "${finding.title}"`);
        console.log(`   mcpEvidence is absent or non-specific — omitting finding`);
        return false;
      }

      // Log whether the finding also carries skill evidence (dual-verified)
      if (!skillVague) {
        dualVerifiedCount++;
        console.log(`✅ DUAL-VERIFIED (Skill + MCP): "${finding.title}"`);
      } else {
        console.log(`✅ MCP-VERIFIED (MCP only, no skill evidence): "${finding.title}"`);
      }

      carbonVerifiedCount++;
      return true;
    }

    // FALLBACK: carbon-builder-skill only (MCP connection failed).
    // Accept if skillEvidence is real; log that MCP was not called.
    if (isSkillVerified) {
      const skillEvidence = (finding.skillEvidence || '').trim();
      if (isVagueEvidence(skillEvidence)) {
        filteredCount++;
        console.log(`❌ FILTERED hallucinated skill verification for: "${finding.title}"`);
        console.log(`   skillEvidence is absent or non-specific — omitting finding`);
        return false;
      }

      console.log(`⚠️  SKILL-ONLY verified (MCP not called): "${finding.title}"`);
      carbonVerifiedCount++;
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
    console.log(`   Dual-verified (Skill + MCP): ${dualVerifiedCount}`);
    console.log(`   Total verified: ${carbonVerifiedCount}`);
    console.log(`   Filtered (unverified): ${filteredCount}`);

    if (filteredCount > 0) {
      console.log(`\n❌ ${filteredCount} Carbon finding(s) filtered — missing or hallucinated verification`);
      console.log(`   To fix: Ensure agent reads skill reference files (skillEvidence) AND calls Carbon MCP (mcpEvidence)`);
    }
  }

  return {
    filtered,
    stats: {
      total: findings.length,
      carbonSpecific: carbonSpecificCount,
      dualVerified: dualVerifiedCount,
      carbonVerified: carbonVerifiedCount,
      filtered: filteredCount
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
  try {
    // Find JSON markers
    const jsonStart = agentOutput.indexOf('BEGIN_REVIEW_JSON');
    
    if (jsonStart === -1) {
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
    }
    
    // Filter unverified Carbon findings with strict enforcement
    const filterResult = filterUnverifiedCarbonFindings(review.findings);
    review.findings = filterResult.filtered;
    
    // Store verification stats for reporting
    review.verificationStats = filterResult.stats;
    
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
  countBySeverity
};

// Made with Bob
