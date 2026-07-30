/******************************************************************************
 * Carbon PR Review Agent
 * 
 * Simplified PR review agent for carbon-design-system/carbon repository
 * Uses modular architecture with CLI agents (bob/claude/codex)
 * 
 * Based on the original agent_prs.js but streamlined for Carbon's needs:
 * - Single repository only (no multi-repo loop)
 * - Minimal metadata (only AIReviewed label)
 * - CLI agents instead of WatsonX
 * - Spec-compliant comments with Carbon verification
 *****************************************************************************/

require('dotenv').config();
const { randomUUID } = require('crypto');
const { createGitHubClient } = require('./githubClient');
const { buildReviewBundle } = require('./reviewBundle');
const { runAgent, getConfiguredAgent, isAgentAvailable } = require('./agentRunner');
const { parseReviewOutput } = require('./reviewParser');
const { formatSummaryComment, formatInlineComment, estimateTokenUsage } = require('./reviewPrompt');
const { splitFindings } = require('./diffMapper');
const { emitEvent } = require('./observability/eventService');
const {
  GITHUB_OWNER,
  GITHUB_REPO,
  REVIEW_LABEL,
  REVIEW_AGENT,
  N_DAYS_SINCE_PR_CREATED,
  MAX_DIFF_CHARS,
  MAX_PRS_PER_RUN,
} = require('./constants');

// Load GitHub token from environment
const GITHUB_TOKEN = process.env.GITHUB_AI_AGENT_TOKEN;

/**
 * Main function to review PRs in the Carbon repository
 */
async function reviewPRs() {
  // CI/CD safety check - only run on main branch in Travis CI
  if (process.env.TRAVIS_BRANCH && process.env.TRAVIS_BRANCH !== 'main') {
    return;
  }

  // One UUID ties every ES event + log line from this invocation together
  const correlationId = randomUUID();
  const runStartedAt = Date.now();
  let prsReviewedThisRun = 0;

  // Spec-compliant startup logging
  console.log(`[Carbon-Monitor] repo=${GITHUB_OWNER}/${GITHUB_REPO}`);
  console.log(`[Carbon-Monitor] selectedAgent=${REVIEW_AGENT}`);
  console.log(`[Carbon-Monitor] label=${REVIEW_LABEL}`);
  console.log(`[Carbon-Monitor] correlationId=${correlationId}`);
  
  // Validate environment
  if (!GITHUB_TOKEN) {
    console.error('❌ GITHUB_AI_AGENT_TOKEN not set');
    return;
  }
  
  // Get configured agent
  const agent = REVIEW_AGENT;
  
  // Validate agent
  const validAgents = ['bob', 'claude', 'codex'];
  if (!validAgents.includes(agent)) {
    console.error(`❌ Invalid agent: ${agent}. Must be one of: ${validAgents.join(', ')}`);
    return;
  }
  
  // Check if agent is available
  const available = await isAgentAvailable(agent);
  if (!available) {
    console.error(`❌ Agent '${agent}' is not available in PATH`);
    console.error(`   Please install ${agent} CLI tool`);
    return;
  }
  
  console.log(`✅ Agent '${agent}' is available\n`);
  
  // Create GitHub client
  const { Octokit } = await import('@octokit/rest');
  const octokit = new Octokit({
    auth: GITHUB_TOKEN,
    baseUrl: process.env.GITHUB_API_BASE_URL || 'https://api.github.com'
  });
  const client = createGitHubClient(octokit);
  
  await emitEvent({
    event_type: 'run_started',
    correlation_id: correlationId,
    repo: `${GITHUB_OWNER}/${GITHUB_REPO}`,
    agent: REVIEW_AGENT,
  });

  try {
    // Fetch reviewable PRs
    console.log('📥 Fetching reviewable PRs...');
    const prs = await client.fetchReviewablePRs({
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO,
      label: REVIEW_LABEL,
      maxPRs: MAX_PRS_PER_RUN,
      daysBack: N_DAYS_SINCE_PR_CREATED
    });
    
    if (prs.length === 0) {
      console.log('✅ No PRs need review');
      return;
    }
    
    console.log(`Found ${prs.length} PR(s) to review\n`);
    
    // Review each PR
    for (const pr of prs) {
      const prStartedAt = Date.now();
      try {
        console.log(`\n${'='.repeat(80)}`);
        console.log(`📌 Reviewing PR #${pr.number}: ${pr.title}`);
        console.log(`   Author: @${pr.user.login}`);
        console.log(`   Created: ${new Date(pr.created_at).toLocaleDateString()}`);
        console.log(`${'='.repeat(80)}\n`);

        await emitEvent({
          event_type: 'pr_review_started',
          correlation_id: correlationId,
          repo: `${GITHUB_OWNER}/${GITHUB_REPO}`,
          pr_number: pr.number,
          agent: REVIEW_AGENT,
          commit_sha: pr.head.sha,
        });
        
        // Fetch PR diff — prefer ORIGINAL_DIFF.patch if present (test PRs created
        // by create-test-pr.js embed the real Carbon diff there to preserve - lines)
        console.log('📄 Fetching PR diff...');
        let diff;
        try {
          const { data: patchFile } = await octokit.rest.repos.getContent({
            owner: GITHUB_OWNER,
            repo: GITHUB_REPO,
            path: 'ORIGINAL_DIFF.patch',
            ref: pr.head.sha
          });
          diff = Buffer.from(patchFile.content, 'base64').toString('utf8');
          console.log(`✅ Diff: ${diff.length} characters (from ORIGINAL_DIFF.patch)`);
        } catch {
          diff = await client.fetchPRDiff({
            owner: GITHUB_OWNER,
            repo: GITHUB_REPO,
            pullNumber: pr.number
          });
          console.log(`✅ Diff: ${diff.length} characters`);
        }
        
        // Fetch changed files — prefer ORIGINAL_FILES.json if present (test PRs
        // created by create-test-pr.js store the real Carbon file list there)
        console.log('📁 Fetching changed files...');
        let files;
        try {
          const { data: filesFile } = await octokit.rest.repos.getContent({
            owner: GITHUB_OWNER,
            repo: GITHUB_REPO,
            path: 'ORIGINAL_FILES.json',
            ref: pr.head.sha
          });
          files = JSON.parse(Buffer.from(filesFile.content, 'base64').toString('utf8'));
          console.log(`✅ Files: ${files.length} changed (from ORIGINAL_FILES.json)`);
        } catch {
          files = await client.fetchPRFiles({
            owner: GITHUB_OWNER,
            repo: GITHUB_REPO,
            pullNumber: pr.number
          });
          console.log(`✅ Files: ${files.length} changed`);
        }
        files.forEach(f => console.log(`   - ${f.filename} (+${f.additions}/-${f.deletions})`));
        
        // Build review bundle
        console.log('\n📦 Creating review bundle...');
        const bundle = await buildReviewBundle({
          owner: GITHUB_OWNER,
          repo: GITHUB_REPO,
          pr,
          diff,
          files
        });
        console.log(`✅ Bundle: ${bundle.dir}`);
        
        // Run agent review
        console.log(`\n🤖 Running ${agent} review...`);
        console.log('This may take 30-60 seconds...\n');
        
        let agentOutput;
        try {
          agentOutput = await runAgent({
            agent,
            cwd: bundle.dir,
            prompt: bundle.prompt,
            timeout: 10 * 60 * 1000 // 10 minutes per spec
          });
        } catch (agentErr) {
          const isTimeout = /timeout/i.test(agentErr.message);
          if (isTimeout) {
            await emitEvent({
              event_type: 'agent_timeout',
              correlation_id: correlationId,
              repo: `${GITHUB_OWNER}/${GITHUB_REPO}`,
              pr_number: pr.number,
              agent: REVIEW_AGENT,
              commit_sha: pr.head.sha,
              payload: { error: agentErr.message },
            });
          }
          throw agentErr;
        }
        
        console.log(`\n✅ ${agent} review received`);

        // ── Carbon Builder skill activation observability ─────────────────
        // Track transcript evidence by scanning for explicit reads of
        // .bob/skills/carbon-builder/ files. Keep this visible in logs even if
        // the agent never prints a dedicated skill-activation tool call.
        // This logging does not change any review behaviour — it is pure observation.
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
        if (skillFilesRead.length > 0) {
          console.log(`\n🔬 Carbon Builder skill files read — ${skillFilesRead.length} file(s):`);
          skillFilesRead.forEach(f => console.log(`   📄 ${f}`));
        } else {
          console.log('\n🔬 Carbon Builder skill: no .bob/skills/carbon-builder/ read_file calls detected in agent output');
        }
        // ─────────────────────────────────────────────────────────────────

        // Parse review output
        console.log('🔍 Parsing review output...');
        const review = parseReviewOutput(agentOutput);
        
        if (!review) {
          console.error('❌ Failed to parse review output');
          console.error('Skipping this PR');
          await emitEvent({
            event_type: 'parse_failed',
            correlation_id: correlationId,
            repo: `${GITHUB_OWNER}/${GITHUB_REPO}`,
            pr_number: pr.number,
            agent: REVIEW_AGENT,
            commit_sha: pr.head.sha,
          });
          if (process.env.GITHUB_AI_AGENT_KEEP_ARTIFACTS !== 'true') {
            await bundle.cleanup();
          } else {
            console.error('📦 Keeping artifacts for debugging:', bundle.dir);
          }
          continue;
        }
        
        console.log(`✅ Parsed: ${review.findings.length} findings`);
        console.log(`✅ Recommendation: ${review.recommendation} — ${review.recommendationRationale}`);

        // Warn when the agent skipped its catalogue step. The warning text is
        // now in review.catalogueWarning (set by the parser) and rendered by
        // formatSummaryComment — summaryMarkdown is never mutated here.
        if (!review.hasCatalogue) {
          console.warn('⚠️  No visible catalogue in agent output — agent may have skipped Step 1');
          console.warn('   Zero findings from this run should be treated as unreliable');
          await emitEvent({
            event_type: 'catalogue_missing',
            correlation_id: correlationId,
            repo: `${GITHUB_OWNER}/${GITHUB_REPO}`,
            pr_number: pr.number,
            agent: REVIEW_AGENT,
            commit_sha: pr.head.sha,
          });
        }

        // Emit skill_unavailable when carbon-builder was never read
        if (skillFilesRead.length === 0) {
          await emitEvent({
            event_type: 'skill_unavailable',
            correlation_id: correlationId,
            repo: `${GITHUB_OWNER}/${GITHUB_REPO}`,
            pr_number: pr.number,
            agent: REVIEW_AGENT,
            commit_sha: pr.head.sha,
          });
        }
        
        // Split findings into inline-able and summary-only
        console.log('\n🔍 Mapping findings to diff positions...');
        const { inlineFindings, summaryFindings } = splitFindings(
          review.findings,
          diff,
          files
        );
        console.log(`✅ Inline: ${inlineFindings.length}, Summary: ${summaryFindings.length}`);
        
        // Post inline review comments if any (check env flag)
        const postInline = process.env.GITHUB_AI_AGENT_POST_INLINE_COMMENTS !== 'false';
        if (inlineFindings.length > 0 && review.shouldPostInlineComments !== false && postInline) {
          console.log('\n💬 Posting inline review comments...');
          
          const inlineComments = inlineFindings.map(finding => ({
            path: finding.diffPosition.path,
            position: finding.diffPosition.position,
            body: formatInlineComment(finding)
          }));
          
          const reviewResult = await client.postReviewComments({
            owner: GITHUB_OWNER,
            repo: GITHUB_REPO,
            pullNumber: pr.number,
            commitId: pr.head.sha,
            comments: inlineComments
          });
          
          if (reviewResult && reviewResult.comments && reviewResult.comments.length > 0) {
            console.log(`✅ Posted ${reviewResult.comments.length} of ${inlineFindings.length} inline comment(s)`);

            // Move findings whose inline comment failed into summaryFindings
            if (reviewResult.comments.length < inlineFindings.length) {
              const postedKeys = new Set(
                reviewResult.comments.map(c => `${c.path}:${c.position}`)
              );
              const failedFindings = inlineFindings.filter(f =>
                !postedKeys.has(`${f.diffPosition.path}:${f.diffPosition.position}`)
              );
              if (failedFindings.length > 0) {
                console.log(`⚠️  ${failedFindings.length} inline comment(s) failed, moving to summary`);
                summaryFindings.push(...failedFindings);
              }
            }
          } else {
            console.log('⚠️  All inline comments failed, will include in summary');
            summaryFindings.push(...inlineFindings);
            inlineFindings.length = 0;
          }
        }
        
        // Calculate token usage estimate
        console.log('\n📊 Calculating token usage...');
        const tokenUsage = estimateTokenUsage({
          prompt: bundle.prompt,
          diff: diff,
          agentOutput: agentOutput
        });
        console.log(`✅ Estimated tokens: ~${tokenUsage.total.toLocaleString()} (input: ~${tokenUsage.input.toLocaleString()}, output: ~${tokenUsage.output.toLocaleString()})`);

        // ── Emit metrics event for this review ──────────────────────────────
        const prDurationMs = Date.now() - prStartedAt;
        await emitEvent({
          event_type: 'pr_review_completed',
          correlation_id: correlationId,
          repo: `${GITHUB_OWNER}/${GITHUB_REPO}`,
          pr_number: pr.number,
          agent: REVIEW_AGENT,
          commit_sha: pr.head.sha,
          payload: {
            recommendation: review.recommendation,
            findings_total: review.findings.length,
            // Flat severity counts — one numeric field per level so Kibana can
            // Sum/Average each independently without dynamic-object sub-key issues.
            // Mirrors Carbon Migrate's pattern of storing outcomes as individual fields.
            findings_blocking: review.findings.filter(f => f.severity === 'blocking').length,
            findings_major:    review.findings.filter(f => f.severity === 'major').length,
            findings_minor:    review.findings.filter(f => f.severity === 'minor').length,
            findings_nit:      review.findings.filter(f => f.severity === 'nit').length,
            cat1_findings: review.findings.filter(f => f.verificationSource !== 'not-carbon-specific').length,
            cat2_findings: review.findings.filter(f => f.verificationSource === 'not-carbon-specific').length,
            verification_source_breakdown: _countBy(review.findings, 'verificationSource'),
            catalogue_present: review.hasCatalogue,
            skill_activated: skillFilesRead.length > 0,
            skill_files_read: skillFilesRead.length,
            inline_comments_posted: inlineFindings.length,
            summary_findings: summaryFindings.length,
            token_input: tokenUsage.input,
            token_output: tokenUsage.output,
            token_total: tokenUsage.total,
            duration_ms: prDurationMs,
          },
        });

        prsReviewedThisRun++;
        // ────────────────────────────────────────────────────────────────────
        
        // Format and post summary comment (check env flag)
        const postSummary = process.env.GITHUB_AI_AGENT_POST_SUMMARY_COMMENT !== 'false';
        if (postSummary) {
          console.log('\n📝 Posting summary comment...');
          const commentBody = formatSummaryComment({
            agent,
            summaryMarkdown: review.summaryMarkdown,
            prNumber: pr.number,
            commitSha: pr.head.sha,
            inlineFindings,
            summaryFindings,
            tokenUsage,
            recommendation: review.recommendation,
            recommendationRationale: review.recommendationRationale,
            catalogueWarning: review.catalogueWarning,
            findingsTable: review.findingsTable
          });
          
          await client.postSummaryComment({
            owner: GITHUB_OWNER,
            repo: GITHUB_REPO,
            pullNumber: pr.number,
            body: commentBody
          });
          console.log('✅ Summary comment posted');
        } else {
          console.log('⏭️  Summary comment skipped (disabled by env var)');
        }
        
        // Add AIReviewed label
        console.log('🏷️  Adding review label...');
        await client.addReviewedLabel({
          owner: GITHUB_OWNER,
          repo: GITHUB_REPO,
          pullNumber: pr.number,
          label: REVIEW_LABEL
        });
        console.log('✅ Label added');
        
        // Cleanup (unless artifacts should be kept for debugging)
        if (process.env.GITHUB_AI_AGENT_KEEP_ARTIFACTS !== 'true') {
          console.log('🧹 Cleaning up...');
          await bundle.cleanup();
        } else {
          console.log('📦 Keeping artifacts for debugging:', bundle.dir);
        }
        
        console.log(`\n✅ PR #${pr.number} review complete`);
        
      } catch (prError) {
        console.error(`\n❌ Error reviewing PR #${pr.number}:`, prError.message);
        console.error(prError.stack);
        await emitEvent({
          event_type: 'pr_review_failed',
          correlation_id: correlationId,
          repo: `${GITHUB_OWNER}/${GITHUB_REPO}`,
          pr_number: pr.number,
          agent: REVIEW_AGENT,
          payload: { error: prError.message },
        });
      }
    }

    const runDurationMs = Date.now() - runStartedAt;
    await emitEvent({
      event_type: 'run_completed',
      correlation_id: correlationId,
      repo: `${GITHUB_OWNER}/${GITHUB_REPO}`,
      agent: REVIEW_AGENT,
      payload: { prs_reviewed: prsReviewedThisRun, duration_ms: runDurationMs },
    });

    console.log(`\n${'='.repeat(80)}`);
    console.log('✅ Carbon PR Review Agent Complete');
    console.log(`${'='.repeat(80)}\n`);
    
  } catch (error) {
    console.error('\n❌ Fatal error:', error.message);
    console.error(error.stack);
    await emitEvent({
      event_type: 'run_failed',
      correlation_id: correlationId,
      repo: `${GITHUB_OWNER}/${GITHUB_REPO}`,
      agent: REVIEW_AGENT,
      payload: { error: error.message },
    });
  }
}

/** Count occurrences of a field value across an array of objects */
function _countBy(arr, field) {
  return arr.reduce((acc, item) => {
    const val = item[field] || 'unknown';
    acc[val] = (acc[val] || 0) + 1;
    return acc;
  }, {});
}

// Export for module usage
module.exports = { reviewPRs };

// Run if executed directly
if (require.main === module) {
  reviewPRs().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

// Made with Bob
