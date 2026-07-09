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
const { createGitHubClient } = require('./githubClient');
const { buildReviewBundle } = require('./reviewBundle');
const { runAgent, getConfiguredAgent, isAgentAvailable } = require('./agentRunner');
const { parseReviewOutput } = require('./reviewParser');
const { formatSummaryComment, formatInlineComment, estimateTokenUsage } = require('./reviewPrompt');
const { splitFindings } = require('./diffMapper');
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

  // Spec-compliant startup logging
  console.log(`[Carbon-Monitor] repo=${GITHUB_OWNER}/${GITHUB_REPO}`);
  console.log(`[Carbon-Monitor] selectedAgent=${REVIEW_AGENT}`);
  console.log(`[Carbon-Monitor] label=${REVIEW_LABEL}`);
  
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
      try {
        console.log(`\n${'='.repeat(80)}`);
        console.log(`📌 Reviewing PR #${pr.number}: ${pr.title}`);
        console.log(`   Author: @${pr.user.login}`);
        console.log(`   Created: ${new Date(pr.created_at).toLocaleDateString()}`);
        console.log(`${'='.repeat(80)}\n`);
        
        // Fetch PR diff
        console.log('📄 Fetching PR diff...');
        const diff = await client.fetchPRDiff({
          owner: GITHUB_OWNER,
          repo: GITHUB_REPO,
          pullNumber: pr.number
        });
        console.log(`✅ Diff: ${diff.length} characters`);
        
        // Fetch changed files
        console.log('📁 Fetching changed files...');
        const files = await client.fetchPRFiles({
          owner: GITHUB_OWNER,
          repo: GITHUB_REPO,
          pullNumber: pr.number
        });
        console.log(`✅ Files: ${files.length} changed`);
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
        
        const agentOutput = await runAgent({
          agent,
          cwd: bundle.dir,
          prompt: bundle.prompt,
          timeout: 10 * 60 * 1000 // 10 minutes per spec
        });
        
        console.log(`\n✅ ${agent} review received`);

        // Parse review output
        console.log('🔍 Parsing review output...');
        const review = parseReviewOutput(agentOutput);
        
        if (!review) {
          console.error('❌ Failed to parse review output');
          console.error('Skipping this PR');
          await bundle.cleanup();
          continue;
        }
        
        console.log(`✅ Parsed: ${review.findings.length} findings`);
        
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
            carbonVerification: review.carbonVerification || null
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
      }
    }
    
    console.log(`\n${'='.repeat(80)}`);
    console.log('✅ Carbon PR Review Agent Complete');
    console.log(`${'='.repeat(80)}\n`);
    
  } catch (error) {
    console.error('\n❌ Fatal error:', error.message);
    console.error(error.stack);
  }
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
