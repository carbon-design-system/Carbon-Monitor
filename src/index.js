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

// Load .env only when this module is the entrypoint (node src/index.js — the
// reviewer, run directly or spawned by the dashboard). When it is imported
// instead — by server.js for its exported helpers, or by a test — .env is NOT
// loaded here: server.js loads it once at its own top, and a test controls
// process.env itself, which loadEnv's override:true would otherwise clobber.
if (require.main === module) require('./loadEnv');

// Resolve target PR: CLI flag --pr takes precedence over env var
const _cliPrIdx = process.argv.indexOf('--pr');
const _cliPrFlagPresent = _cliPrIdx !== -1;

if (_cliPrFlagPresent && process.argv[_cliPrIdx + 1] === undefined) {
  console.error('❌ --pr flag requires a PR number.');
  console.error('   Example: node src/index.js --pr 12345');
  process.exit(1);
}

const _rawTargetPR = _cliPrFlagPresent
  ? process.argv[_cliPrIdx + 1]
  : process.env.GITHUB_AI_AGENT_PR_NUMBER || null;

let TARGET_PR = null;
if (_rawTargetPR != null) {
  const _parsed = Number(_rawTargetPR);
  if (!Number.isInteger(_parsed) || _parsed <= 0) {
    console.error(`❌ Invalid PR number: "${_rawTargetPR}". Must be a positive integer.`);
    console.error('   Example: node src/index.js --pr 12345');
    process.exit(1);
  }
  TARGET_PR = _parsed;
}

const { randomUUID } = require('crypto');
const { createGitHubClient } = require('./githubClient');
const { buildReviewBundle } = require('./reviewBundle');
const { runAgent, getConfiguredAgent, isAgentAvailable } = require('./agentRunner');
const { parseReviewOutput, extractCarbonBuilderSkillReads } = require('./reviewParser');
const { formatSummaryComment, formatInlineComment, estimateTokenUsage } = require('./reviewPrompt');
const { splitFindings } = require('./diffMapper');
const { emitEvent } = require('./observability/eventService');
const bobCredits = require('./api/bobCredits');
const creditLedger = require('./api/creditLedger');
const {
  GITHUB_OWNER,
  GITHUB_REPO,
  REVIEW_LABEL,
  REVIEW_AGENT,
  N_DAYS_SINCE_PR_CREATED,
  MAX_PRS_PER_RUN,
} = require('./constants');

// Load GitHub token from environment
const GITHUB_TOKEN = process.env.GITHUB_AI_AGENT_TOKEN;

/**
 * Record what a single review cost to the local ledger.
 *
 * Called from a `finally`, including on the failure path — a run that timed out
 * after nine minutes is the most expensive kind there is, and omitting it would
 * make the ledger read as if failures were free.
 *
 * Swallows everything. An exception raised inside that `finally` would REPLACE
 * the agent's real error as it propagates, so a billing hiccup would erase the
 * reason the review actually failed.
 *
 * @param {Object} opts
 * @param {string} opts.correlationId
 * @param {Object} opts.pr
 * @param {Object|null} opts.after  - Balance snapshot taken after the run
 * @param {number|null} opts.coinsSpent
 * @param {number} opts.durationMs
 * @param {string} [opts.source='balance-delta'] - How coinsSpent was derived
 */
async function recordReviewCost({
  correlationId,
  pr,
  after,
  coinsSpent,
  durationMs,
  source = 'balance-delta',
}) {
  try {
    const balance = after && after.available ? after : null;

    await creditLedger.record({
      at: new Date().toISOString(),
      prNumber: pr.number,
      repo: `${GITHUB_OWNER}/${GITHUB_REPO}`,
      correlationId,
      coinsSpent,
      remainingAfter: balance ? balance.remaining : null,
      durationMs,
      source,
    });
  } catch (error) {
    console.warn(`⚠️  Could not record review cost: ${error.message}`);
  }
}

/**
 * Delete a review bundle, whatever the outcome of the review.
 *
 * Called from the per-PR `finally` rather than repeated on each success path,
 * because the failure paths are the ones that matter: reviewBundle writes the
 * live BOB_API_KEY into `<bundle>/.env`, so a run that throws — an agent timeout
 * above all, the single most likely failure — would otherwise leave a plaintext
 * copy of the key on a container filesystem that lives for months, alongside
 * half a megabyte of diff, and add another on every subsequent failure.
 *
 * Swallows its own errors: raised from a `finally`, they would REPLACE the error
 * that actually ended the review.
 *
 * @param {Object|null} bundle
 */
async function cleanupBundle(bundle) {
  if (!bundle) return;

  if (process.env.GITHUB_AI_AGENT_KEEP_ARTIFACTS === 'true') {
    console.log('📦 Keeping artifacts for debugging:', bundle.dir);
    return;
  }

  try {
    console.log('🧹 Cleaning up...');
    await bundle.cleanup();
  } catch (error) {
    console.warn(`⚠️  Could not remove review bundle ${bundle.dir}: ${error.message}`);
  }
}

// ── Review targeting ────────────────────────────────────────────────────────

/**
 * Render a rejected value for an error message without ever throwing.
 *
 * These strings go straight into an HTTP 400 body, so the formatter itself must
 * be total — a crash while explaining a bad input would turn a 400 into a 500.
 *
 * @param {*} value
 * @returns {string}
 */
function describeValue(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  try {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : text;
  } catch (_) {
    return String(value);
  }
}

/**
 * Parse and validate an operator-supplied PR list.
 *
 * Exported and used by BOTH callers — POST /api/review/trigger, which turns a
 * rejection into a 400, and reviewPRs itself. A second copy of these rules in
 * the route is the copy that would drift from what actually runs.
 *
 * Deliberately pure and TOTAL: it never throws, and above all it never exits.
 * The TARGET_PR resolution at the top of this module calls process.exit(1) on a
 * bad value, which is right for a CLI and catastrophic for a request handler —
 * one malformed body would take down the single instance, console and review
 * loop together. Every rejection here is a returned string instead.
 *
 * An absent, blank or empty list is not an error: it means AUTO mode, which is
 * exactly what an empty input box in the console posts.
 *
 * @param {Array|string|null|undefined} input - PR numbers, or a comma-separated string
 * @param {number} [maxPRs=MAX_PRS_PER_RUN] - Most PRs one run may review
 * @returns {{ok: boolean, prNumbers: number[]|null, error?: string}}
 *          `ok: true` with `prNumbers: null` means auto-select.
 */
function parsePrNumbers(input, maxPRs = MAX_PRS_PER_RUN) {
  if (input === undefined || input === null) return { ok: true, prNumbers: null };

  let entries;
  if (Array.isArray(input)) {
    entries = input;
  } else if (typeof input === 'string') {
    if (input.trim() === '') return { ok: true, prNumbers: null };
    entries = input.split(',');
  } else {
    return {
      ok: false,
      prNumbers: null,
      error:
        'prNumbers must be an array of numbers or a comma-separated string, ' +
        `but received ${typeof input}: ${describeValue(input)}`,
    };
  }

  if (entries.length === 0) return { ok: true, prNumbers: null };

  const prNumbers = [];

  for (const entry of entries) {
    // Anything that is not a number or a string is rejected before String()
    // touches it: Number(true) is 1 and Number(null) is 0, so coercing first
    // would quietly turn junk into a PR number.
    if (typeof entry !== 'number' && typeof entry !== 'string') {
      return {
        ok: false,
        prNumbers: null,
        error: `Invalid PR number ${describeValue(entry)} — every entry must be a positive integer.`,
      };
    }

    const text = String(entry).trim();

    if (text === '') {
      return {
        ok: false,
        prNumbers: null,
        error: 'The PR list contains an empty value — remove the stray comma.',
      };
    }

    const value = Number(text);

    // Digits only. Number() alone accepts "0x10", "1e3" and "22971.0", so a
    // fat-fingered entry would silently review a PR the operator never named.
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(value) || value <= 0) {
      return {
        ok: false,
        prNumbers: null,
        error: `Invalid PR number ${describeValue(entry)} — must be a positive integer.`,
      };
    }

    // Deduplicated, order preserved: reviewing the same PR twice in one run
    // posts two summary comments on it.
    if (!prNumbers.includes(value)) prNumbers.push(value);
  }

  if (prNumbers.length > maxPRs) {
    return {
      ok: false,
      prNumbers: null,
      error:
        `Too many PRs: ${prNumbers.length} requested, but at most ${maxPRs} may be ` +
        'reviewed in one run (GITHUB_AI_AGENT_MAX_PRS).',
    };
  }

  return { ok: true, prNumbers };
}

/**
 * Decide which PRs a run will actually review.
 *
 * Precedence, strongest first:
 *   1. an explicit `prNumbers` argument — someone just asked for these
 *   2. TARGET_PR — the --pr flag or GITHUB_AI_AGENT_PR_NUMBER this process started with
 *   3. auto-select the most recent reviewable PRs
 *
 * The argument outranks TARGET_PR because containers are routinely deployed with
 * GITHUB_AI_AGENT_PR_NUMBER pinned for debugging. If the environment won, every
 * trigger from the console would silently re-review that one pinned PR and post
 * a second comment on it, while reporting the numbers the operator typed.
 *
 * @param {Object} [options]
 * @param {number[]|string|null} [options.prNumbers] - Re-validated here
 * @param {number|null} [targetPr=TARGET_PR] - This process's --pr/env target, read
 *        at call time. Injectable so precedence can be tested without reloading
 *        the module under a different environment.
 * @returns {{ok: boolean, mode: 'explicit'|'auto', prNumbers: number[]|null, source: string, error?: string}}
 */
function resolveReviewTargets(options = {}, targetPr = TARGET_PR) {
  const parsed = parsePrNumbers(options.prNumbers);
  if (!parsed.ok) {
    return { ok: false, mode: 'auto', prNumbers: null, source: 'argument', error: parsed.error };
  }

  if (parsed.prNumbers) {
    return { ok: true, mode: 'explicit', prNumbers: parsed.prNumbers, source: 'argument' };
  }
  if (targetPr) {
    return { ok: true, mode: 'explicit', prNumbers: [targetPr], source: 'cli-env' };
  }
  return { ok: true, mode: 'auto', prNumbers: null, source: 'auto' };
}

/**
 * Main function to review PRs in the Carbon repository
 *
 * @param {Object} [options] - Omitted (the CLI path) falls back to --pr / the env
 *        var, and then to auto-select — exactly as it behaved before options existed
 * @param {number[]|string|null} [options.prNumbers] - Review exactly these PRs,
 *        outranking --pr and GITHUB_AI_AGENT_PR_NUMBER
 */
async function reviewPRs(options = {}) {
  // CI/CD safety check - only run on main branch in Travis CI
  if (process.env.TRAVIS_BRANCH && process.env.TRAVIS_BRANCH !== 'main') {
    return;
  }

  // Decided before anything expensive happens, and reported like every other
  // run parameter — "which PRs" is the first question asked of a run's logs.
  //
  // A rejection here is logged and returned, never thrown and never exited on:
  // reviewPRs runs detached in the API server's background, where an escaping
  // error becomes an unhandled rejection.
  const target = resolveReviewTargets(options);
  if (!target.ok) {
    console.error(`❌ ${target.error}`);
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
  console.log(
    `[Carbon-Monitor] target=${
      target.mode === 'explicit'
        ? `${target.prNumbers.map((n) => `#${n}`).join(', ')} (${target.source})`
        : `auto (max ${MAX_PRS_PER_RUN}, last ${N_DAYS_SINCE_PR_CREATED} days)`
    }`
  );
  
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

  // Bobcoins are Bob's currency, and BOB_API_KEY stays configured whichever CLI
  // is selected (checkBob and the MCP config both need it). Bracketing the Bob
  // gateway around a claude or codex run would therefore attribute whatever
  // else touched the account in that window to this review — and, with nothing
  // else touching it, record a hard 0 that drags averagePerReview toward zero
  // for every review. Two gateway round-trips on the review's critical path for
  // a figure that is structurally always zero, at that.
  const tracksBobcoins = agent === 'bob';
  if (!tracksBobcoins) {
    console.log(`ℹ️  Bobcoins accounting skipped — '${agent}' does not spend them\n`);
  }
  
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

  // PRs named explicitly but not fetchable. Counted rather than thrown so the
  // run still closes out with a run_completed event.
  const fetchFailures = [];

  try {
    // Fetch PRs — targeted (API request / --pr / env var) or auto-select
    let prs;
    if (target.mode === 'explicit') {
      console.log(
        `🎯 Targeting ${target.prNumbers.length} specific PR(s) ` +
          `(skipping auto-selection): ${target.prNumbers.map((n) => `#${n}`).join(', ')}`
      );

      // fetchSinglePR deliberately applies no label, draft or age filtering —
      // an explicitly named PR is reviewed on the operator's authority, exactly
      // as --pr has always behaved.
      prs = [];
      for (const pullNumber of target.prNumbers) {
        try {
          prs.push(
            await client.fetchSinglePR({
              owner: GITHUB_OWNER,
              repo: GITHUB_REPO,
              pullNumber
            })
          );
        } catch (fetchError) {
          // One bad number — a typo, a PR from another repo, one since deleted —
          // must not cost the operator the rest of the list. Naming several PRs
          // is a request for one pass over all of them, not an all-or-nothing bet.
          console.error(`❌ Could not fetch PR #${pullNumber}: ${fetchError.message}`);
          fetchFailures.push(pullNumber);
          await emitEvent({
            event_type: 'pr_review_failed',
            correlation_id: correlationId,
            repo: `${GITHUB_OWNER}/${GITHUB_REPO}`,
            pr_number: pullNumber,
            agent: REVIEW_AGENT,
            payload: { error: `Could not fetch PR: ${fetchError.message}` },
          });
        }
      }

      if (prs.length === 0) {
        console.error('❌ None of the requested PRs could be fetched');
      }
    } else {
      console.log('📥 Fetching reviewable PRs...');
      prs = await client.fetchReviewablePRs({
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
    }

    // Review each PR
    for (const pr of prs) {
      const prStartedAt = Date.now();
      // Declared outside the try so the `finally` below can remove it however
      // the review ends — the bundle holds a plaintext copy of BOB_API_KEY.
      let bundle = null;
      try {
        console.log(`\n${'='.repeat(80)}`);
        console.log(`📌 Reviewing PR #${pr.number}: ${pr.title}`);
        console.log(`   Author: @${pr.user.login}`);
        console.log(`   Created: ${new Date(pr.created_at).toLocaleDateString()}`);
        console.log(`   URL: ${pr.html_url}`);
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
        bundle = await buildReviewBundle({
          owner: GITHUB_OWNER,
          repo: GITHUB_REPO,
          pr,
          diff,
          files,
          client
        });
        console.log(`✅ Bundle: ${bundle.dir}`);

        // Run agent review
        console.log(`\n🤖 Running ${agent} review...`);
        console.log('This may take a few minutes...\n');

        // ── Bobcoins accounting ─────────────────────────────────────────────
        // Bob only reports a run's own cost in stream-json output, and this app
        // must keep the pretty format that reviewParser reads. The account's
        // running usage total is bracketed around the run instead. Both reads
        // bypass the cache: a stale "before" would silently report zero spend.
        let coinsBefore = null;
        let coinsAfter = null;
        let coinsSpent = null;
        let agentSucceeded = false;

        if (tracksBobcoins) {
          coinsBefore = await bobCredits.getBalance({ force: true }).catch(() => null);
        }

        let agentOutput;
        try {
          agentOutput = await runAgent({
            agent,
            cwd: bundle.dir,
            prompt: bundle.prompt,
            timeout: 10 * 60 * 1000 // 10 minutes per spec
          });
          agentSucceeded = true;
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
        } finally {
          // `finally` runs before the rethrow above propagates, so a failed or
          // timed-out run — which still burned coins — is recorded too, and the
          // original error still reaches the per-PR catch block below.
          //
          // Everything here is wrapped: an exception thrown from a `finally`
          // REPLACES the in-flight error, so an unguarded billing failure would
          // erase the reason the review actually failed.
          try {
            if (tracksBobcoins) {
              coinsAfter = await bobCredits.getBalance({ force: true });
              coinsSpent = bobCredits.computeSpend(coinsBefore, coinsAfter);

              if (coinsSpent !== null) {
                console.log(`\n🪙 Bobcoins spent: ${coinsSpent}`);
              } else if (coinsAfter && !coinsAfter.available) {
                console.log(`\n🪙 Bobcoins: balance unavailable (${coinsAfter.reason})`);
              }
            }

            await recordReviewCost({
              correlationId,
              pr,
              after: coinsAfter,
              coinsSpent,
              durationMs: Date.now() - prStartedAt,
              source: tracksBobcoins ? 'balance-delta' : 'unknown',
            });
          } catch (costErr) {
            console.warn(`⚠️  Bobcoins accounting failed: ${costErr.message}`);
          }
        }

        console.log(`\n✅ ${agent} review received`);

        // ── Carbon Builder skill activation observability ─────────────────
        // Reuse the shared extractor from reviewParser — handles both v1
        // (read_file calls to .bob/skills/carbon-builder/) and v2 (use_skill
        // tool with skill_name: carbon-builder).
        const skillFilesRead = extractCarbonBuilderSkillReads(agentOutput);
        if (skillFilesRead.length > 0) {
          // v2 leaves a single "use_skill:carbon-builder" signal; v1 leaves one
          // entry per skill file the agent read. Either form means the agent
          // loaded the skill before reviewing.
          const how = skillFilesRead.includes('use_skill:carbon-builder')
            ? 'invoked it via the use_skill tool'
            : `read ${skillFilesRead.length} skill file(s): ${skillFilesRead.join(', ')}`;
          console.log(`\n🔬 Carbon Builder skill: ✅ loaded and used by the agent — ${how}`);
        } else {
          console.log('\n🔬 Carbon Builder skill: ⚠️  NOT loaded — the agent transcript shows no use_skill call and no read of .bob/skills/carbon-builder/. Carbon claims in this review are unverified by the skill.');
        }
        // ─────────────────────────────────────────────────────────────────

        // Parse review output
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
          // The `finally` below removes the bundle on the way out.
          continue;
        }
        
        console.log(`✅ Parsed: ${review.findings.length} findings`);
        console.log(`✅ Recommendation: ${review.recommendation} — ${review.recommendationRationale}`);

        // Warn when the agent skipped its catalogue step.
        if (!review.hasCatalogue) {
          console.warn('⚠️  No visible catalogue in agent output — agent may have skipped Step 1');
          console.warn('   Zero findings from this run should be treated as unreliable');
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
        const { inlineFindings, summaryFindings } = splitFindings(
          review.findings,
          diff,
          files,
          bundle.mdDiffStartLine
        );
        console.log(`✅ Inline: ${inlineFindings.length}, Summary: ${summaryFindings.length}`);
        
        // Post inline review comments if any (check env flag)
        const postInline = process.env.GITHUB_AI_AGENT_POST_INLINE_COMMENTS !== 'false';
        if (inlineFindings.length > 0 && review.shouldPostInlineComments !== false && postInline) {
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
        const tokenUsage = estimateTokenUsage({
          prompt: bundle.prompt,
          diff: diff,
          agentOutput: agentOutput
        });
        console.log(`✅ Estimated tokens: ~${tokenUsage.total.toLocaleString()} (input: ~${tokenUsage.input.toLocaleString()}, output: ~${tokenUsage.output.toLocaleString()})`);

        // ── Emit metrics event for this review ──────────────────────────────
        await emitEvent({
          event_type:     'pr_review_completed',
          correlation_id: correlationId,
          repo:           `${GITHUB_OWNER}/${GITHUB_REPO}`,
          pr_number:      pr.number,
          agent:          REVIEW_AGENT,
          commit_sha:     pr.head.sha,
          payload: {
            // pr_title is stored so Kibana runtime fields can extract any embedded
            // identifiers (e.g. original Carbon PR numbers in test PR titles).
            pr_title: pr.title,
            recommendation: review.recommendation,
            findings_total:    review.findings.length,
            findings_blocking: review.findings.filter(f => f.severity === 'blocking').length,
            findings_major:    review.findings.filter(f => f.severity === 'major').length,
            findings_minor:    review.findings.filter(f => f.severity === 'minor').length,
            findings_nit:      review.findings.filter(f => f.severity === 'nit').length,
            cat1_findings: review.findings.filter(f => f.verificationSource !== 'not-carbon-specific').length,
            cat2_findings: review.findings.filter(f => f.verificationSource === 'not-carbon-specific').length,
            token_input:  tokenUsage.input,
            token_output: tokenUsage.output,
            token_total:  tokenUsage.total,
          },
        });

        prsReviewedThisRun++;
        // ────────────────────────────────────────────────────────────────────
        
        // Format and post summary comment (check env flag)
        const postSummary = process.env.GITHUB_AI_AGENT_POST_SUMMARY_COMMENT !== 'false';
        if (postSummary) {
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
        await client.addReviewedLabel({
          owner: GITHUB_OWNER,
          repo: GITHUB_REPO,
          pullNumber: pr.number,
          label: REVIEW_LABEL
        });
        console.log('✅ Label added');
        
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
      } finally {
        // Runs on every exit from this PR — success, parse failure, agent
        // timeout, or any other throw — so no bundle, and no copy of
        // BOB_API_KEY, is ever left behind.
        await cleanupBundle(bundle);
      }
    }

    const runDurationMs = Date.now() - runStartedAt;
    await emitEvent({
      event_type: 'run_completed',
      correlation_id: correlationId,
      repo: `${GITHUB_OWNER}/${GITHUB_REPO}`,
      agent: REVIEW_AGENT,
      payload: {
        prs_reviewed: prsReviewedThisRun,
        duration_ms: runDurationMs,
        // Flat scalars, matching the rest of the payloads: a run that reviewed
        // two of the three PRs it was given is not the same as one given two.
        prs_requested: target.mode === 'explicit' ? target.prNumbers.length : null,
        prs_fetch_failed: fetchFailures.length,
        target_mode: target.mode,
      },
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

// Export for module usage.
//
// parsePrNumbers and resolveReviewTargets are exported so the API server enforces
// exactly the rules this module obeys, rather than a second copy of them.
module.exports = { reviewPRs, parsePrNumbers, resolveReviewTargets };

// Run if executed directly
if (require.main === module) {
  reviewPRs().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

// Made with Bob
