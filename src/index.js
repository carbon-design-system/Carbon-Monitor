/******************************************************************************
 * Carbon PR Review Agent
 *
 * Simplified PR review agent for the repositories in GITHUB_AI_AGENT_REPOS
 * Uses modular architecture with CLI agents (see src/agents)
 *
 * Based on the original agent_prs.js but streamlined for Carbon's needs:
 * - Repositories reviewed in list order, each with its own profile
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

// Needed before the other requires: --pr is checked against the repo list.
const { GITHUB_REPOS } = require('./constants');

// Resolve target PR: CLI flag --pr takes precedence over env var
const _cliPrIdx = process.argv.indexOf('--pr');
const _cliPrFlagPresent = _cliPrIdx !== -1;

if (_cliPrFlagPresent && process.argv[_cliPrIdx + 1] === undefined) {
  console.error('❌ --pr flag requires a PR number.');
  console.error(
    '   Example: node src/index.js --pr 12345  or  --pr carbon-ai-chat#12345'
  );
  process.exit(1);
}

const _rawTargetPR = _cliPrFlagPresent
  ? process.argv[_cliPrIdx + 1]
  : process.env.GITHUB_AI_AGENT_PR_NUMBER || null;

// { repo: string|null, number }; a null repo is looked up in reviewPRs.
let TARGET_PR = null;
if (_rawTargetPR != null) {
  const _match = /^(?:([A-Za-z0-9._-]+)#)?(\d+)$/.exec(
    String(_rawTargetPR).trim()
  );
  const _number = _match ? Number(_match[2]) : NaN;
  if (!Number.isSafeInteger(_number) || _number <= 0) {
    console.error(
      `❌ Invalid PR number: "${_rawTargetPR}". Must be a positive integer, or repo#number.`
    );
    console.error(
      '   Example: node src/index.js --pr 12345  or  --pr carbon-ai-chat#12345'
    );
    process.exit(1);
  }
  if (_match[1] && !GITHUB_REPOS.includes(_match[1])) {
    console.error(
      `❌ Unknown repository "${_match[1]}" in "${_rawTargetPR}". Configured repositories: ${GITHUB_REPOS.join(', ')}.`
    );
    process.exit(1);
  }
  TARGET_PR = { repo: _match[1] || null, number: _number };
}

const { randomUUID } = require('crypto');
const { checkStartup } = require('./config/env');
const { createGitHubClient, createOctokit } = require('./githubClient');
const { buildReviewBundle } = require('./reviewBundle');
const { LISTING_LIMIT } = require('./reviewCoverage');
const {
  runAgent,
  getConfiguredAgent,
  isAgentAvailable,
} = require('./agentRunner');
const agents = require('./agents');
const {
  parseReviewOutput,
  extractCarbonBuilderSkillReads,
} = require('./reviewParser');
const {
  formatSummaryComment,
  formatLooksGoodComment,
  formatNotReviewedComment,
  formatInlineComment,
  estimateTokenUsage,
} = require('./reviewPrompt');
const { splitFindings } = require('./diffMapper');
const profiles = require('./profiles');
const { resolveNumbers } = require('./prResolver');
const { emitEvent } = require('./observability/eventService');
const bobCredits = require('./api/bobCredits');
const creditLedger = require('./api/creditLedger');
const reviewLog = require('./api/reviewLog');
const { postRunDigest, postRunFailure } = require('./slackNotifier');
const {
  GITHUB_OWNER,
  REVIEW_LABEL,
  REVIEW_AGENT,
  N_DAYS_SINCE_PR_CREATED,
  MAX_PRS_PER_REPO,
  REVIEW_CONCURRENCY,
} = require('./constants');

// Load GitHub token from environment
const GITHUB_TOKEN = process.env.GITHUB_AI_AGENT_TOKEN;

function reportedCost(stats) {
  const c = stats && stats.session_costs;
  // Same 1e-6 rounding as computeSpend, so the log and ledger never show float noise.
  return typeof c === 'number' && Number.isFinite(c)
    ? Math.round(c * 1e6) / 1e6
    : null;
}

// Exact counts from the agent's result record, or null so the caller falls back
// to the character estimate.
function tokensFromStats(stats, adapter = agents.get(agents.DEFAULT_ID)) {
  if (!stats) return null;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const input = num(stats.input_tokens);
  const output = num(stats.output_tokens);
  if (input === null || output === null) return null;
  return {
    input,
    output,
    total: num(stats.total_tokens) ?? input + output,
    cacheRead: num(stats.cache_read_tokens),
    cacheWrite: num(stats.cache_write_tokens),
    source: adapter.id,
  };
}

// Bob's own figure is the cost of record; the balance delta is the permanent
// fallback and the cross-check. `ledgerSource` keeps the ledger's old label
// when neither figure exists.
function resolveSpend({
  stats,
  delta,
  tracked,
  after,
  label = '',
  adapter = agents.get(agents.DEFAULT_ID),
}) {
  const reported = reportedCost(stats);
  const suffix = label ? ` (${label})` : '';
  if (adapter.costUnit !== 'bobcoins') {
    // No balance to bracket: the result record is the only figure.
    if (reported === null) {
      return { coinsSpent: null, source: 'unknown', ledgerSource: 'unknown' };
    }
    console.log(
      `\n💲 ${adapter.displayName} cost${suffix}: ${reported} ${adapter.costUnit}`
    );
    return {
      coinsSpent: reported,
      source: adapter.resultSource,
      ledgerSource: adapter.resultSource,
    };
  }
  if (reported !== null) {
    if (delta !== null && Math.abs(reported - delta) > 0.01) {
      console.warn(
        `\n🪙 Bobcoins${suffix}: result=${reported} delta=${delta} (mismatch)`
      );
    } else {
      console.log(`\n🪙 Bobcoins spent${suffix}: ${reported}`);
    }
    return {
      coinsSpent: reported,
      source: 'bob-result',
      ledgerSource: 'bob-result',
    };
  }
  if (delta !== null) {
    console.log(`\n🪙 Bobcoins spent${suffix}: ${delta}`);
  } else if (tracked && after && !after.available && !label) {
    console.log(`\n🪙 Bobcoins: balance unavailable (${after.reason})`);
  }
  return {
    coinsSpent: delta,
    source: delta !== null ? 'balance-delta' : 'unknown',
    ledgerSource: tracked ? 'balance-delta' : 'unknown',
  };
}

// The review JSON can arrive only in Bob's final message. The earlier messages
// stay in front of it so the catalogue check still sees the catalogue.
function reviewTextFor(run) {
  const marker = 'BEGIN_REVIEW_JSON';
  if (
    !run.text.includes(marker) &&
    run.lastMessage &&
    run.lastMessage.includes(marker)
  ) {
    return `${run.text}\n\n${run.lastMessage}`;
  }
  return run.text;
}

// Observed tool calls beat the transcript regex. With no recognised event
// evidence the regex runs over the raw tool calls, then the text, so an event
// shape this code does not know about cannot silently drop every Carbon finding.
function skillReadsFor(
  run,
  text,
  evidence,
  adapter = agents.get(agents.DEFAULT_ID)
) {
  if (evidence.skillInvoked) return [adapter.skill.sentinel];
  if (evidence.skillFiles.length > 0) return evidence.skillFiles;
  if (run.format !== 'stream-json') return extractCarbonBuilderSkillReads(text);

  // Matched per call so a skill call for another skill cannot pair with a later
  // mention of carbon-builder.
  const calls = run.toolCalls || [];
  let reads = extractCarbonBuilderSkillReads(JSON.stringify(calls));
  if (
    reads.length === 0 &&
    calls.some((c) => adapter.skill.pattern.test(JSON.stringify(c)))
  ) {
    reads = [adapter.skill.sentinel];
  }
  if (reads.length === 0) reads = extractCarbonBuilderSkillReads(text);
  if (reads.length > 0) {
    console.warn(
      '⚠️  Carbon Builder skill detected from the transcript, not from tool events — the event shape may differ from what summarizeToolCalls expects'
    );
  }
  return reads;
}

// Sum of the first run's and the retry's spend. The source is the retry's when
// the first run has none, and the agent's result source only when both runs
// reported one.
function addSpend(first, retry) {
  if (retry.coinsSpent === null) return first;
  if (first.coinsSpent === null) {
    return { coinsSpent: retry.coinsSpent, source: retry.source };
  }
  return {
    coinsSpent: Math.round((first.coinsSpent + retry.coinsSpent) * 1e6) / 1e6,
    source:
      first.source === retry.source && first.source.endsWith('-result')
        ? first.source
        : 'balance-delta',
  };
}

function sumCalls(calls) {
  return Object.values(calls).reduce((a, b) => a + b, 0);
}

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
 * @param {string} opts.repo - "owner/repo" the PR belongs to
 * @param {Object} opts.pr
 * @param {Object|null} opts.after  - Balance snapshot taken after the run
 * @param {number|null} opts.coinsSpent
 * @param {number} opts.durationMs
 * @param {string} [opts.source='balance-delta'] - How coinsSpent was derived
 * @param {Object|null} [opts.stats] - The agent's result stats, when the run had them
 * @param {number|null} [opts.toolCalls]
 * @param {Object} [opts.adapter] - Whose unit the spend is in; defaults to Bob
 */
async function recordReviewCost({
  correlationId,
  repo,
  pr,
  after,
  coinsSpent,
  durationMs,
  source = 'balance-delta',
  stats = null,
  toolCalls = null,
  adapter = agents.get(agents.DEFAULT_ID),
}) {
  try {
    const balance = after && after.available ? after : null;

    await creditLedger.record({
      at: new Date().toISOString(),
      prNumber: pr.number,
      repo,
      correlationId,
      coinsSpent,
      remainingAfter: balance ? balance.remaining : null,
      durationMs,
      source,
      costUnit: adapter.costUnit,
      taskId: stats && stats.task_id ? String(stats.task_id) : null,
      tokens: tokensFromStats(stats, adapter),
      toolCalls,
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
    console.warn(
      `⚠️  Could not remove review bundle ${bundle.dir}: ${error.message}`
    );
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
 * @param {number} [maxPRs] - Most PRs one run may review; defaults to MAX_PRS_PER_REPO across all repos
 * @returns {{ok: boolean, prNumbers: number[]|null, error?: string}}
 *          `ok: true` with `prNumbers: null` means auto-select.
 */
function parsePrNumbers(
  input,
  maxPRs = MAX_PRS_PER_REPO * GITHUB_REPOS.length
) {
  if (input === undefined || input === null)
    return { ok: true, prNumbers: null };

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
        'reviewed per run (GITHUB_AI_AGENT_MAX_PRS per repository, across all repositories).',
    };
  }

  return { ok: true, prNumbers };
}

const refKey = (ref) => `${ref.repo}#${ref.number}`;

/** Deduplicates by key, order preserved: two summary comments on one PR is a bug. */
function dedupeRefs(refs) {
  const seen = new Set();
  return refs.filter((ref) => !seen.has(refKey(ref)) && seen.add(refKey(ref)));
}

/** An error string when any repository has more than `maxPerRepo` refs, else null. */
function overRepoCap(refs, maxPerRepo = MAX_PRS_PER_REPO) {
  for (const repo of GITHUB_REPOS) {
    const n = refs.filter((ref) => ref.repo === repo).length;
    if (n > maxPerRepo) {
      return (
        `Too many PRs for ${repo}: ${n} requested, but at most ${maxPerRepo} may be ` +
        'reviewed per repository (GITHUB_AI_AGENT_MAX_PRS).'
      );
    }
  }
  return null;
}

/**
 * Parse and validate an operator-supplied list of PR refs ({ repo, number }).
 *
 * Total, like parsePrNumbers: every rejection is a returned string. An absent or
 * empty list means "not given". The cap is per repository and counted after
 * deduplication.
 *
 * @param {Array|null|undefined} input
 * @param {number} [maxPerRepo]
 * @returns {{ok: boolean, refs: Array<{repo: string, number: number}>|null, error?: string}}
 */
function parsePrRefs(input, maxPerRepo = MAX_PRS_PER_REPO) {
  if (input === undefined || input === null) return { ok: true, refs: null };
  const fail = (error) => ({ ok: false, refs: null, error });
  if (!Array.isArray(input)) {
    return fail(
      'prs must be an array of { repo, number } objects, ' +
        `but received ${typeof input}: ${describeValue(input)}`
    );
  }
  if (input.length === 0) return { ok: true, refs: null };

  const refs = [];
  for (const entry of input) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return fail(
        `Invalid PR ref ${describeValue(entry)} — every entry must be { repo, number }.`
      );
    }
    if (typeof entry.repo !== 'string' || !GITHUB_REPOS.includes(entry.repo)) {
      return fail(
        `Unknown repository ${describeValue(entry.repo)} — must be one of: ${GITHUB_REPOS.join(', ')}.`
      );
    }
    if (!Number.isSafeInteger(entry.number) || entry.number <= 0) {
      return fail(
        `Invalid PR number ${describeValue(entry.number)} for ${entry.repo} — must be a positive integer.`
      );
    }
    refs.push({ repo: entry.repo, number: entry.number });
  }

  const unique = dedupeRefs(refs);
  const capError = overRepoCap(unique, maxPerRepo);
  return capError ? fail(capError) : { ok: true, refs: unique };
}

/**
 * Decide which PRs a run will actually review.
 *
 * Precedence, strongest first:
 *   1. an explicit `prs` argument — refs that already name their repository
 *   2. an explicit `prNumbers` argument — someone just asked for these; reviewPRs
 *      finds each number's repository
 *   3. TARGET_PR — the --pr flag or GITHUB_AI_AGENT_PR_NUMBER this process started with
 *   4. auto-select the most recent reviewable PRs
 *
 * The argument outranks TARGET_PR because containers are routinely deployed with
 * GITHUB_AI_AGENT_PR_NUMBER pinned for debugging. If the environment won, every
 * trigger from the console would silently re-review that one pinned PR and post
 * a second comment on it, while reporting the numbers the operator typed.
 *
 * @param {Object} [options]
 * @param {number[]|string|null} [options.prNumbers] - Re-validated here
 * @param {Array<{repo: string, number: number}>|null} [options.prs] - Re-validated here
 * @param {{repo: string|null, number: number}|null} [targetPr=TARGET_PR] - This
 *        process's --pr/env target, read at call time. Injectable so precedence can
 *        be tested without reloading the module under a different environment.
 * @returns {{ok: boolean, mode: 'explicit'|'auto', prNumbers: number[]|null, refs: Array<{repo: string, number: number}>|null, source: string, error?: string}}
 *          `prNumbers` still need a repository; `refs` already have one.
 */
function resolveReviewTargets(options = {}, targetPr = TARGET_PR) {
  const refsParsed = parsePrRefs(options.prs);
  const parsed = refsParsed.ok ? parsePrNumbers(options.prNumbers) : refsParsed;
  if (!parsed.ok) {
    return {
      ok: false,
      mode: 'auto',
      prNumbers: null,
      refs: null,
      source: 'argument',
      error: parsed.error,
    };
  }

  if (refsParsed.refs) {
    return {
      ok: true,
      mode: 'explicit',
      prNumbers: null,
      refs: refsParsed.refs,
      source: 'argument',
    };
  }
  if (parsed.prNumbers) {
    return {
      ok: true,
      mode: 'explicit',
      prNumbers: parsed.prNumbers,
      refs: null,
      source: 'argument',
    };
  }
  if (targetPr) {
    return {
      ok: true,
      mode: 'explicit',
      prNumbers: targetPr.repo ? null : [targetPr.number],
      refs: targetPr.repo
        ? [{ repo: targetPr.repo, number: targetPr.number }]
        : null,
      source: 'cli-env',
    };
  }
  return {
    ok: true,
    mode: 'auto',
    prNumbers: null,
    refs: null,
    source: 'auto',
  };
}

const joinWith = (list, last) =>
  list.length < 2
    ? list.join('')
    : `${list.slice(0, -1).join(', ')} ${last} ${list[list.length - 1]}`;

/** The failure text for a typed number that did not resolve to exactly one PR. */
function unresolvedMessage(result) {
  const found = result.matches.map((m) => m.repo);
  if (found.length === 0) {
    return `PR #${result.number} was not found in ${joinWith(GITHUB_REPOS, 'or')}.`;
  }
  return (
    `PR #${result.number} matches ${joinWith(found, 'and')}. ` +
    `Name it as ${found[found.length - 1]}#${result.number}.`
  );
}

/**
 * The log line for a number the open-PR tiebreak resolved, or null for a note
 * that does not describe a chosen ref. Alternatives are listed in repo order.
 */
function formatResolutionNote(note) {
  if (
    !note ||
    typeof note.repo !== 'string' ||
    !Number.isSafeInteger(note.number) ||
    !Array.isArray(note.alternatives)
  ) {
    return null;
  }
  const order = (alt) => GITHUB_REPOS.indexOf(alt.repo);
  const alternatives = note.alternatives
    .filter((alt) => alt && typeof alt.repo === 'string')
    .sort((a, b) => order(a) - order(b))
    .map(
      (alt) =>
        `${alt.repo}#${note.number} was ${alt.mergedAt ? 'merged' : 'closed'} at lookup`
    );
  return `📌 #${note.number} → ${note.repo}#${note.number} (${alternatives.join(', ')})`;
}

/**
 * Main function to review PRs in the configured repositories
 *
 * @param {Object} [options] - Omitted (the CLI path) falls back to --pr / the env
 *        var, and then to auto-select — exactly as it behaved before options existed
 * @param {Array<{repo: string, number: number}>} [options.prs] - Review exactly
 *        these PRs, outranking prNumbers
 * @param {number[]|string|null} [options.prNumbers] - Review exactly these PRs,
 *        outranking --pr and GITHUB_AI_AGENT_PR_NUMBER; each number's repository
 *        is looked up here
 * @param {Array} [options.resolutionNotes] - With `prs`: numbers the caller
 *        resolved by the open-PR tiebreak, logged before any review starts
 */
async function reviewPRs(options = {}) {
  // Decided before anything expensive happens, and reported like every other
  // run parameter — "which PRs" is the first question asked of a run's logs.
  //
  // A rejection is logged and thrown, never exited on: the CLI's .catch turns it
  // into a non-zero exit, and the API server's .catch keeps the message in status.
  const target = resolveReviewTargets(options);
  if (!target.ok) {
    console.error(`❌ ${target.error}`);
    throw new Error(target.error);
  }

  // One UUID ties every ES event + log line from this invocation together
  const correlationId = randomUUID();
  const runStartedAt = Date.now();
  let prsReviewedThisRun = 0;
  // Accumulates per-PR outcomes for the Slack digest (scheduled runs only)
  const runResults = [];

  const fullNames = GITHUB_REPOS.map((r) => `${GITHUB_OWNER}/${r}`);
  const runRepo = fullNames.join(',');

  // Spec-compliant startup logging
  console.log(`[Carbon-Monitor] repos=${runRepo}`);
  console.log(`[Carbon-Monitor] selectedAgent=${REVIEW_AGENT}`);
  console.log(`[Carbon-Monitor] label=${REVIEW_LABEL}`);
  console.log(`[Carbon-Monitor] correlationId=${correlationId}`);
  console.log(
    `[Carbon-Monitor] target=${
      target.mode === 'explicit'
        ? `${(target.refs ? target.refs.map(refKey) : target.prNumbers.map((n) => `#${n}`)).join(', ')} (${target.source})`
        : `auto (max ${MAX_PRS_PER_REPO}, last ${N_DAYS_SINCE_PR_CREATED} days)`
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
  const adapter = agents.find(agent);
  if (!adapter) {
    console.error(
      `❌ Invalid agent: ${agent}. Must be one of: ${agents.ids().join(', ')}`
    );
    return;
  }

  // A repo whose profile cannot run with this agent must stop the run before
  // any PR is touched, and be visible: log, event, Slack for scheduled runs.
  try {
    profiles.checkRepos(GITHUB_REPOS, agent);
  } catch (profileErr) {
    console.error(`❌ Profile error: ${profileErr.message}`);
    try {
      await emitEvent({
        event_type: 'run_failed',
        correlation_id: correlationId,
        repo: runRepo,
        agent: REVIEW_AGENT,
        payload: { repos: fullNames, error: profileErr.message },
      });
      if (options.triggeredBy === 'schedule') {
        await postRunFailure({
          startedAt: runStartedAt,
          repos: fullNames,
          error: profileErr.message,
        });
      }
    } catch (reportErr) {
      // Reporting must not replace the configuration error the caller needs.
      console.warn(
        `⚠️  Could not report the failed start: ${reportErr.message}`
      );
    }
    // Thrown, not returned: the server and scheduler clear their error on a normal return.
    throw profileErr;
  }

  // Check if agent is available
  const available = await isAgentAvailable(agent);
  if (!available) {
    console.error(`❌ Agent '${agent}' is not available in PATH`);
    console.error(`   Please install ${agent} CLI tool`);
    return;
  }

  // Only the bobcoins unit brackets the Bob gateway: around another agent's run it
  // would attribute unrelated account activity, or a hard 0, to this review.
  const tracksBobcoins = adapter.costUnit === 'bobcoins';
  const spendWord = tracksBobcoins ? 'Bobcoins' : 'Spend';
  if (!tracksBobcoins) {
    console.log(
      `ℹ️  Bobcoins accounting skipped — '${agent}' does not spend them\n`
    );
  }

  // Create GitHub client
  const octokit = await createOctokit({
    auth: GITHUB_TOKEN,
    baseUrl: process.env.GITHUB_API_BASE_URL || 'https://api.github.com',
  });
  const client = createGitHubClient(octokit);

  // Finding each typed number's repository and the per-repo cap come before the
  // run exists: a failure here throws, so a CLI exits non-zero and a caller's
  // .catch keeps the message.
  const reject = (message) => {
    console.error(`❌ ${message}`);
    throw new Error(message);
  };
  let refs = target.refs;
  const notes =
    refs && target.source === 'argument' ? options.resolutionNotes : [];
  const resolutionNotes = Array.isArray(notes) ? [...notes] : [];
  if (target.prNumbers) {
    const resolved = await resolveNumbers({
      client,
      owner: GITHUB_OWNER,
      repos: GITHUB_REPOS,
      numbers: target.prNumbers,
    });
    const unresolved = resolved.filter((r) => !r.choice);
    if (unresolved.length > 0)
      reject(unresolved.map(unresolvedMessage).join(' '));
    refs = resolved.map((r) => r.choice);
    for (const r of resolved) {
      if (r.resolution !== 'only-open') continue;
      resolutionNotes.push({
        repo: r.choice.repo,
        number: r.choice.number,
        alternatives: r.matches
          .filter((m) => m.repo !== r.choice.repo)
          .map((m) => ({ repo: m.repo, state: m.state, mergedAt: m.mergedAt })),
      });
    }
  }
  if (refs) {
    refs = dedupeRefs(refs);
    const capError = overRepoCap(refs);
    if (capError) reject(capError);
  }

  // After capture has started and before any review: the operator typed a bare
  // number and a different PR may have been meant.
  for (const note of resolutionNotes) {
    if (
      !refs.some((ref) => ref.repo === note.repo && ref.number === note.number)
    )
      continue;
    const line = formatResolutionNote(note);
    if (line) console.log(line);
  }

  await emitEvent({
    event_type: 'run_started',
    correlation_id: correlationId,
    repo: runRepo,
    agent: REVIEW_AGENT,
    payload: { repos: fullNames },
  });

  // PRs named explicitly but not fetchable. Counted rather than thrown so the
  // run still closes out with a run_completed event.
  const fetchFailures = [];

  try {
    // One list of work items across the repositories. List order is batch
    // order, for the budget too: every PR of the first repo is queued first.
    const explicit = target.mode === 'explicit';
    if (explicit) {
      console.log(
        `🎯 Targeting ${refs.length} specific PR(s) ` +
          `(skipping auto-selection): ${refs.map(refKey).join(', ')}`
      );
    }
    const items = [];
    for (const repo of GITHUB_REPOS) {
      const profile = profiles.forRepo(repo);
      let prs = [];
      if (explicit) {
        // fetchSinglePR deliberately applies no label, draft or age filtering —
        // an explicitly named PR is reviewed on the operator's authority, exactly
        // as --pr has always behaved.
        for (const { number: pullNumber } of refs.filter(
          (ref) => ref.repo === repo
        )) {
          try {
            prs.push(
              await client.fetchSinglePR({
                owner: GITHUB_OWNER,
                repo,
                pullNumber,
              })
            );
          } catch (fetchError) {
            // One bad number — a typo, one since deleted — must not cost the
            // operator the rest of the list. Naming several PRs is a request for
            // one pass over all of them, not an all-or-nothing bet.
            console.error(
              `❌ Could not fetch ${repo}#${pullNumber}: ${fetchError.message}`
            );
            fetchFailures.push(pullNumber);
            await emitEvent({
              event_type: 'pr_review_failed',
              correlation_id: correlationId,
              repo: `${GITHUB_OWNER}/${repo}`,
              pr_number: pullNumber,
              agent: REVIEW_AGENT,
              profile: profile.id,
              payload: { error: `Could not fetch PR: ${fetchError.message}` },
            });
          }
        }
      } else {
        console.log(`📥 Fetching reviewable PRs from ${repo}...`);
        prs = await client.fetchReviewablePRs({
          owner: GITHUB_OWNER,
          repo,
          label: REVIEW_LABEL,
          maxPRs: MAX_PRS_PER_REPO,
          daysBack: N_DAYS_SINCE_PR_CREATED,
        });
      }
      for (const pr of prs) {
        items.push({ pr, owner: GITHUB_OWNER, repo, profile });
      }
    }

    if (items.length === 0) {
      if (explicit) {
        console.error('❌ None of the requested PRs could be fetched');
      } else {
        console.log('✅ No PRs need review');
        // Scheduled run: post a "nothing to review" ping so the channel
        // confirms the scheduler fired even when no PRs were eligible.
        if (options.triggeredBy === 'schedule') {
          await postRunDigest({
            startedAt: runStartedAt,
            repo: runRepo,
            repos: fullNames,
            results: [],
            maxPRs: MAX_PRS_PER_REPO,
            daysBack: N_DAYS_SINCE_PR_CREATED,
            emitEvent,
          });
        }
        return;
      }
    }

    // Pool state, read by reviewOne's balance brackets as well as the workers.
    const inFlight = [];
    let started = 0;
    // A balance bracket that overlaps a sibling's run includes the sibling's
    // spend, so it proves nothing about this review's cost.
    const overlapped = (mark) =>
      mark.inFlight > 1 || inFlight.length > 1 || mark.starts !== started;
    const markNow = () => ({ inFlight: inFlight.length, starts: started });

    // Review each PR
    const reviewOne = async (item) => {
      const { pr, owner, repo, profile } = item;
      const fullName = `${owner}/${repo}`;
      // This review's outcomes; the pool joins them back in list order.
      const prResults = [];
      const prStartedAt = Date.now();
      // Declared outside the try so the `finally` below can remove it however
      // the review ends — the bundle holds a plaintext copy of BOB_API_KEY.
      let bundle = null;
      try {
        // Scheduled batches stop spending once the balance is confirmed low,
        // the same rule the scheduler applies before it starts one.
        if (options.triggeredBy === 'schedule') {
          const credits = await adapter.credits();
          if (credits.available && credits.low) {
            console.warn(
              `⏭️  ${repo}#${pr.number} skipped — ${credits.summary}`
            );
            prResults.push({
              prNumber: pr.number,
              repo,
              prUrl: pr.html_url,
              skipped: true,
              reason: credits.summary,
            });
            return prResults;
          }
        }

        console.log(`\n${'='.repeat(80)}`);
        console.log(`📌 Reviewing ${repo}#${pr.number}: ${pr.title}`);
        console.log(`   Author: @${pr.user.login}`);
        console.log(
          `   Created: ${new Date(pr.created_at).toLocaleDateString()}`
        );
        console.log(`   URL: ${pr.html_url}`);
        console.log(`${'='.repeat(80)}\n`);

        // Test PRs from create-test-pr.js carry their files, with real patches, in
        // ORIGINAL_FILES.json; any other PR lists them from GitHub.
        let files;
        try {
          const { data: filesFile } = await octokit.rest.repos.getContent({
            owner,
            repo,
            path: 'ORIGINAL_FILES.json',
            ref: pr.head.sha,
          });
          files = JSON.parse(
            Buffer.from(filesFile.content, 'base64').toString('utf8')
          );
          console.log(
            `✅ Files: ${files.length} changed (from ORIGINAL_FILES.json)`
          );
        } catch {
          files = await client.fetchPRFiles({
            owner,
            repo,
            pullNumber: pr.number,
          });
          console.log(`✅ Files: ${files.length} changed`);
        }
        files.forEach((f) =>
          console.log(`   - ${f.filename} (+${f.additions}/-${f.deletions})`)
        );

        await emitEvent({
          event_type: 'pr_review_started',
          correlation_id: correlationId,
          repo: fullName,
          pr_number: pr.number,
          agent: REVIEW_AGENT,
          profile: profile.id,
          commit_sha: pr.head.sha,
        });

        // A full listing may be cut short; the PR itself says how many files there are.
        let changedFilesTotal;
        if (files.length === LISTING_LIMIT) {
          try {
            ({ changed_files: changedFilesTotal } = await client.fetchSinglePR({
              owner,
              repo,
              pullNumber: pr.number,
            }));
          } catch (countErr) {
            console.warn(
              `⚠️  Could not read ${repo}#${pr.number}'s file count: ${countErr.message}`
            );
          }
        }

        // Build review bundle; it assembles the diff from the files' patches
        bundle = await buildReviewBundle({
          owner,
          repo,
          pr,
          files,
          client,
          agent,
          changedFilesTotal,
          profile,
        });
        console.log(`✅ Bundle: ${bundle.dir}`);
        const { coverage } = bundle;
        console.log(
          `✅ Diff: ${bundle.diff.length} characters, ${coverage.files_reviewed} of ${coverage.files_total} files${coverage.partial ? ' (partial review)' : ''}`
        );
        // The event and the digest carry the counts, not the omitted names
        const coverageFields = {
          files_total: coverage.files_total,
          files_reviewed: coverage.files_reviewed,
          files_omitted: coverage.files_omitted,
          diff_chars_total: coverage.diff_chars_total,
          diff_chars_reviewed: coverage.diff_chars_reviewed,
          partial: coverage.partial,
        };

        // Not even a line of any file fits: no agent runs, but the author is told and the
        // label is set, or the PR would be picked again on every run.
        if (bundle.diff === '' && coverage.partial) {
          console.warn(
            `⚠️  ${repo}#${pr.number}: no changed file fits the diff budget, so no agent runs`
          );
          await emitEvent({
            event_type: 'pr_review_completed',
            correlation_id: correlationId,
            repo: fullName,
            pr_number: pr.number,
            agent: REVIEW_AGENT,
            profile: profile.id,
            commit_sha: pr.head.sha,
            payload: {
              pr_title: pr.title,
              findings_total: 0,
              runs: 0,
              durationMs: Date.now() - prStartedAt,
              coverage: coverageFields,
            },
          });
          if (process.env.GITHUB_AI_AGENT_POST_SUMMARY_COMMENT !== 'false') {
            await client.postSummaryComment({
              owner,
              repo,
              pullNumber: pr.number,
              body: formatNotReviewedComment({
                commitSha: pr.head.sha,
                coverage,
                filesUrl: `${pr.html_url}/files`,
                ...(profile.headerLabel
                  ? { headerLabel: profile.headerLabel }
                  : {}),
              }),
            });
          }
          await client.addReviewedLabel({
            owner,
            repo,
            pullNumber: pr.number,
            label: REVIEW_LABEL,
          });
          prResults.push({
            prNumber: pr.number,
            repo,
            prUrl: pr.html_url,
            skipped: true,
            reason: `Nothing fit the diff budget (0 of ${coverage.files_total} files reviewed)`,
            coverage: coverageFields,
          });
          return prResults;
        }

        // Two agent processes must share no file, so each review gets its own
        // HOME (Bob) or config directory (Claude).
        const creds = await require('./api/mcpConnection')
          .getCredentials()
          .catch(() => null);
        const { home, refresh: refreshHome } = await adapter.seedHome(
          bundle.dir,
          creds
        );

        // Run agent review
        console.log(`\n🤖 Running ${agent} review...`);
        console.log('This may take a few minutes...\n');

        // ── Bobcoins accounting ─────────────────────────────────────────────
        // Cost comes from Bob's result record (stats.session_costs). The
        // account's running usage total is still bracketed around the run as the
        // fallback when no result arrived, as the cross-check, and for the
        // remaining balance. Both reads bypass the cache: a stale "before" would
        // silently report zero spend.
        let coinsBefore = null;
        let coinsMark = markNow();
        let coinsAfter = null;
        let coinsSpent = null;
        let coinsSource = 'unknown';
        let agentSucceeded = false;

        if (tracksBobcoins) {
          coinsMark = markNow();
          coinsBefore = await bobCredits
            .getBalance({ force: true })
            .catch(() => null);
        }

        const emitLimitReached = async (err, stats) => {
          if (err.kind !== 'cost-limit' && err.kind !== 'turn-limit') return;
          await emitEvent({
            event_type: 'agent_limit_reached',
            correlation_id: correlationId,
            repo: fullName,
            pr_number: pr.number,
            agent: REVIEW_AGENT,
            profile: profile.id,
            commit_sha: pr.head.sha,
            payload: {
              kind: err.kind,
              error: err.message,
              coinsSpent: reportedCost(stats),
            },
          });
        };

        let agentOutput;
        let agentRun; // full runner result, kept for cost and token accounting
        let runStats = null;
        try {
          agentRun = await runAgent({
            agent,
            cwd: bundle.dir,
            home,
            prompt: bundle.prompt,
            timeout: 10 * 60 * 1000, // 10 minutes
          });
          runStats = agentRun.stats;
          agentOutput = reviewTextFor(agentRun);
          agentSucceeded = true;
        } catch (agentErr) {
          runStats = agentErr.stats || null;
          // Non-AgentRunError failures keep the old message test.
          const isTimeout = agentErr.kind
            ? agentErr.kind === 'timeout'
            : /timeout/i.test(agentErr.message);
          if (isTimeout) {
            await emitEvent({
              event_type: 'agent_timeout',
              correlation_id: correlationId,
              repo: fullName,
              pr_number: pr.number,
              agent: REVIEW_AGENT,
              profile: profile.id,
              commit_sha: pr.head.sha,
              payload: { error: agentErr.message },
            });
          } else {
            await emitLimitReached(agentErr, runStats);
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
            let delta = null;
            let shared = false;
            if (tracksBobcoins) {
              coinsAfter = await bobCredits.getBalance({ force: true });
              shared = overlapped(coinsMark);
              if (!shared) {
                delta = bobCredits.computeSpend(coinsBefore, coinsAfter);
              }
            }
            const spend = resolveSpend({
              stats: runStats,
              delta,
              tracked: tracksBobcoins && !shared,
              after: coinsAfter,
              adapter,
            });
            coinsSpent = spend.coinsSpent;
            coinsSource = spend.source;

            await recordReviewCost({
              correlationId,
              repo: fullName,
              pr,
              after: coinsAfter,
              coinsSpent,
              durationMs: Date.now() - prStartedAt,
              source: spend.ledgerSource,
              stats: runStats,
              toolCalls: runStats ? (runStats.tool_calls ?? null) : null,
              adapter,
            });
          } catch (costErr) {
            console.warn(
              `⚠️  ${spendWord} accounting failed: ${costErr.message}`
            );
          }
        }

        console.log(`\n✅ ${agent} review received`);

        // ── Carbon Builder skill activation observability ─────────────────
        // Evidence is the tool calls seen in the agent's event stream (a skill
        // call, or reads of the bundle's carbon-builder files); runs without an
        // event stream fall back to the shared transcript extractor.
        let evidence = adapter.evidence(agentRun.toolCalls);
        let skillFilesRead = skillReadsFor(
          agentRun,
          agentOutput,
          evidence,
          adapter
        );
        if (skillFilesRead.length > 0) {
          // The skill invocation leaves a single sentinel entry; file reads leave
          // one entry per skill file. Either form means the agent loaded the
          // skill before reviewing.
          const how = skillFilesRead.includes(adapter.skill.sentinel)
            ? `invoked it via the ${adapter.skill.tool} tool`
            : `read ${skillFilesRead.length} skill file(s): ${skillFilesRead.join(', ')}`;
          console.log(
            `\n🔬 Carbon Builder skill: ✅ loaded and used by the agent — ${how}`
          );
        } else {
          console.log(
            `\n🔬 Carbon Builder skill: ⚠️  NOT loaded — the agent transcript shows no ${adapter.skill.tool} call and no read of ${adapter.skill.dir}. Carbon claims in this review are unverified by the skill.`
          );
        }
        if (agentRun.format === 'stream-json') {
          const mcp = Object.entries(evidence.mcpCalls)
            .map(([name, n]) => `${name}=${n}`)
            .join(' ');
          console.log(`🔎 Carbon MCP calls: ${mcp || 'none'}`);
        }
        // ─────────────────────────────────────────────────────────────────

        // Parse review output
        let review = parseReviewOutput(agentOutput, {
          skillReads: skillFilesRead,
          skillDir: adapter.skill.dir,
          readTool: adapter.promptFragments.readTool,
        });

        // Run of record: the first run, or the retry when it produced the review.
        let finalRun = agentRun;
        let runs = 1;
        let totalSpent = coinsSpent;
        let totalSource = coinsSource;
        let balanceAfter = coinsAfter;

        // Retry once on parse failure. Bob's JSON block is a fresh, non-deterministic
        // generation each run: a malformed-output parse failure (an escape/quote
        // sequence the sanitiser can't repair) frequently clears on a second attempt.
        // Re-run the agent once and re-parse before skipping the PR entirely.
        if (!review) {
          console.warn(
            `⚠️  Parse failed — retrying ${agent} review once (output is non-deterministic)`
          );
          try {
            runs = 2;
            let retryCoinsBefore = null;
            let retryMark = markNow();
            // A bearer refreshed during the first run is picked up here.
            await refreshHome?.().catch(() => {});
            if (tracksBobcoins) {
              retryMark = markNow();
              retryCoinsBefore = await bobCredits
                .getBalance({ force: true })
                .catch(() => null);
            }
            let retryOutput;
            let retryRun;
            let retryStats = null;
            try {
              retryRun = await runAgent({
                agent,
                cwd: bundle.dir,
                home,
                prompt: bundle.prompt,
                timeout: 10 * 60 * 1000,
              });
              retryStats = retryRun.stats;
              retryOutput = reviewTextFor(retryRun);
            } catch (retryRunErr) {
              retryStats = retryRunErr.stats || null;
              await emitLimitReached(retryRunErr, retryStats);
              throw retryRunErr;
            } finally {
              // Mirror the first run's billing: the retry burns coins too, so record
              // its spend. Guarded so an accounting failure never masks the retry.
              try {
                let retryCoinsAfter = null;
                let retryDelta = null;
                let retryShared = false;
                if (tracksBobcoins) {
                  retryCoinsAfter = await bobCredits.getBalance({
                    force: true,
                  });
                  retryShared = overlapped(retryMark);
                  retryDelta = retryShared
                    ? null
                    : bobCredits.computeSpend(
                        retryCoinsBefore,
                        retryCoinsAfter
                      );
                  balanceAfter = retryCoinsAfter;
                }
                const retrySpend = resolveSpend({
                  stats: retryStats,
                  delta: retryDelta,
                  tracked: tracksBobcoins && !retryShared,
                  after: retryCoinsAfter,
                  label: 'retry',
                  adapter,
                });
                const sum = addSpend(
                  { coinsSpent, source: coinsSource },
                  retrySpend
                );
                totalSpent = sum.coinsSpent;
                totalSource = sum.source;
                await recordReviewCost({
                  correlationId,
                  repo: fullName,
                  pr,
                  after: retryCoinsAfter,
                  coinsSpent: retrySpend.coinsSpent,
                  durationMs: Date.now() - prStartedAt,
                  source: retrySpend.ledgerSource,
                  stats: retryStats,
                  toolCalls: retryStats
                    ? (retryStats.tool_calls ?? null)
                    : null,
                  adapter,
                });
              } catch (costErr) {
                console.warn(
                  `⚠️  ${spendWord} accounting failed (retry): ${costErr.message}`
                );
              }
            }
            if (retryOutput) {
              const retryEvidence = adapter.evidence(retryRun.toolCalls);
              const retrySkillReads = skillReadsFor(
                retryRun,
                retryOutput,
                retryEvidence,
                adapter
              );
              review = parseReviewOutput(retryOutput, {
                skillReads: retrySkillReads,
                skillDir: adapter.skill.dir,
                readTool: adapter.promptFragments.readTool,
              });
              if (review) {
                // Adopt the successful retry as the run of record so the token
                // figures and skill_unavailable metric below reflect the output
                // actually used.
                agentOutput = retryOutput;
                skillFilesRead = retrySkillReads;
                evidence = retryEvidence;
                finalRun = retryRun;
                console.log(
                  '✅ Retry succeeded — parsed review from second attempt'
                );
              }
            }
          } catch (retryErr) {
            console.warn(`⚠️  Retry run failed: ${retryErr.message}`);
          }
        }

        if (!review) {
          console.error('❌ Failed to parse review output');
          console.error('Skipping this PR');
          await emitEvent({
            event_type: 'parse_failed',
            correlation_id: correlationId,
            repo: fullName,
            pr_number: pr.number,
            agent: REVIEW_AGENT,
            profile: profile.id,
            commit_sha: pr.head.sha,
          });
          // The `finally` below removes the bundle on the way out.
          return prResults;
        }

        console.log(`✅ Parsed: ${review.findings.length} findings`);
        console.log(
          `✅ Recommendation: ${review.recommendation} — ${review.recommendationRationale}`
        );

        // Warn when the agent skipped its catalogue step.
        if (!review.hasCatalogue) {
          console.warn(
            '⚠️  No visible catalogue in agent output — agent may have skipped Step 1'
          );
          console.warn(
            '   Zero findings from this run should be treated as unreliable'
          );
        }

        // Emit skill_unavailable when carbon-builder was never read
        if (skillFilesRead.length === 0) {
          await emitEvent({
            event_type: 'skill_unavailable',
            correlation_id: correlationId,
            repo: fullName,
            pr_number: pr.number,
            agent: REVIEW_AGENT,
            profile: profile.id,
            commit_sha: pr.head.sha,
          });
        }

        // Nits are never inline: a convention-only remark is not worth a diff comment
        const nitFindings = review.findings.filter((f) => f.severity === 'nit');
        const nonNitFindings = review.findings.filter(
          (f) => f.severity !== 'nit'
        );

        // Split findings into inline-able and summary-only
        const { inlineFindings, summaryFindings } = splitFindings(
          nonNitFindings,
          bundle.diff,
          files,
          bundle.mdDiffStartLine
        );
        console.log(
          `✅ Inline: ${inlineFindings.length}, Summary: ${summaryFindings.length}, Nits: ${nitFindings.length}`
        );

        // Post inline review comments if any (check env flag)
        const postInline =
          process.env.GITHUB_AI_AGENT_POST_INLINE_COMMENTS !== 'false';
        if (
          inlineFindings.length > 0 &&
          review.shouldPostInlineComments !== false &&
          postInline
        ) {
          const inlineComments = inlineFindings.map((finding) => ({
            path: finding.diffPosition.path,
            position: finding.diffPosition.position,
            body: formatInlineComment(finding),
          }));

          const reviewResult = await client.postReviewComments({
            owner,
            repo,
            pullNumber: pr.number,
            commitId: pr.head.sha,
            comments: inlineComments,
          });

          if (
            reviewResult &&
            reviewResult.comments &&
            reviewResult.comments.length > 0
          ) {
            console.log(
              `✅ Posted ${reviewResult.comments.length} of ${inlineFindings.length} inline comment(s)`
            );

            // Move findings whose inline comment failed into summaryFindings
            if (reviewResult.comments.length < inlineFindings.length) {
              const postedKeys = new Set(
                reviewResult.comments.map((c) => `${c.path}:${c.position}`)
              );
              const failedFindings = inlineFindings.filter(
                (f) =>
                  !postedKeys.has(
                    `${f.diffPosition.path}:${f.diffPosition.position}`
                  )
              );
              if (failedFindings.length > 0) {
                console.log(
                  `⚠️  ${failedFindings.length} inline comment(s) failed, moving to summary`
                );
                summaryFindings.push(...failedFindings);
              }
            }
          } else {
            console.log(
              '⚠️  All inline comments failed, will include in summary'
            );
            summaryFindings.push(...inlineFindings);
            inlineFindings.length = 0;
          }
        } else if (inlineFindings.length > 0) {
          // The kill switch must not lose findings: they move to the summary.
          console.log(
            `ℹ️  Inline comments disabled, including ${inlineFindings.length} finding(s) in the summary`
          );
          summaryFindings.push(...inlineFindings);
          inlineFindings.length = 0;
        }

        // Exact counts from the agent's result record, else the character estimate.
        const tokenUsage = tokensFromStats(finalRun.stats, adapter) || {
          ...estimateTokenUsage({
            prompt: bundle.prompt,
            diff: bundle.diff,
            agentOutput: agentOutput,
          }),
          source: 'estimate',
        };
        if (tokenUsage.source !== 'estimate') {
          console.log(
            `✅ Tokens: ${tokenUsage.total.toLocaleString()} (input: ${tokenUsage.input.toLocaleString()}, output: ${tokenUsage.output.toLocaleString()})`
          );
        } else {
          console.log(
            `✅ Estimated tokens: ~${tokenUsage.total.toLocaleString()} (input: ~${tokenUsage.input.toLocaleString()}, output: ~${tokenUsage.output.toLocaleString()})`
          );
        }
        const observed = finalRun.format === 'stream-json';

        // ── Emit metrics event for this review ──────────────────────────────
        await emitEvent({
          event_type: 'pr_review_completed',
          correlation_id: correlationId,
          repo: fullName,
          pr_number: pr.number,
          agent: REVIEW_AGENT,
          profile: profile.id,
          commit_sha: pr.head.sha,
          payload: {
            // pr_title is stored so Kibana runtime fields can extract any embedded
            // identifiers (e.g. original Carbon PR numbers in test PR titles).
            pr_title: pr.title,
            recommendation: review.recommendation,
            findings_total: review.findings.length,
            findings_blocking: review.findings.filter(
              (f) => f.severity === 'blocking'
            ).length,
            findings_major: review.findings.filter(
              (f) => f.severity === 'major'
            ).length,
            findings_minor: review.findings.filter(
              (f) => f.severity === 'minor'
            ).length,
            findings_nit: review.findings.filter((f) => f.severity === 'nit')
              .length,
            cat1_findings: review.findings.filter(
              (f) => f.verificationSource !== 'not-carbon-specific'
            ).length,
            cat2_findings: review.findings.filter(
              (f) => f.verificationSource === 'not-carbon-specific'
            ).length,
            token_input: tokenUsage.input,
            token_output: tokenUsage.output,
            token_total: tokenUsage.total,
            token_cache_read: tokenUsage.cacheRead ?? null,
            token_cache_write: tokenUsage.cacheWrite ?? null,
            token_source: tokenUsage.source,
            cost_unit: adapter.costUnit,
            coins_source: totalSpent === null ? 'unknown' : totalSource,
            bob_task_id: finalRun.stats
              ? (finalRun.stats.task_id ?? null)
              : null,
            tool_calls: observed ? evidence.total : null,
            mcp_tool_calls: observed ? sumCalls(evidence.mcpCalls) : null,
            // Bob use_skill calls for this profile's extra skills; absent without any.
            ...(profile.extraSkills && profile.extraSkills.length > 0
              ? {
                  extra_skills_used: (finalRun.toolCalls || [])
                    .filter(
                      (c) =>
                        c.name === 'use_skill' &&
                        profile.extraSkills.some(
                          (s) => s.name === (c.params || {}).skill_name
                        )
                    )
                    .map((c) => (c.params || {}).skill_name),
                }
              : {}),
            runs,
            coinsSpent: totalSpent,
            remainingAfter:
              balanceAfter && balanceAfter.available
                ? balanceAfter.remaining
                : null,
            durationMs: Date.now() - prStartedAt,
            coverage: coverageFields,
          },
        });

        prsReviewedThisRun++;
        // ────────────────────────────────────────────────────────────────────

        // Format and post summary comment (check env flag)
        const postSummary =
          process.env.GITHUB_AI_AGENT_POST_SUMMARY_COMMENT !== 'false';
        if (postSummary) {
          // The attempt_completion fallback says looks-good with a warning; a quiet comment would drop it
          const commentBody =
            review.recommendation === 'looks-good' && !review.catalogueWarning
              ? formatLooksGoodComment({
                  agent,
                  agentName: adapter.displayName,
                  summaryMarkdown: review.summaryMarkdown,
                  commitSha: pr.head.sha,
                  nitFindings,
                  coverage,
                  filesUrl: `${pr.html_url}/files`,
                  ...(profile.headerLabel
                    ? { headerLabel: profile.headerLabel }
                    : {}),
                })
              : formatSummaryComment({
                  agent,
                  agentName: adapter.displayName,
                  summaryMarkdown: review.summaryMarkdown,
                  prNumber: pr.number,
                  commitSha: pr.head.sha,
                  inlineFindings,
                  summaryFindings,
                  tokenUsage,
                  recommendation: review.recommendation,
                  recommendationRationale: review.recommendationRationale,
                  catalogueWarning: review.catalogueWarning,
                  findingsTable: review.findingsTable,
                  nitFindings,
                  coverage,
                  filesUrl: `${pr.html_url}/files`,
                  ...(profile.headerLabel
                    ? { headerLabel: profile.headerLabel }
                    : {}),
                  ...(() => {
                    // A boolean (core) or a function of the review (caic: only with Cat 1 findings).
                    const scv = profile.showCarbonVerification;
                    const val = typeof scv === 'function' ? scv(review) : scv;
                    return val !== undefined
                      ? { showCarbonVerification: val }
                      : {};
                  })(),
                });

          await client.postSummaryComment({
            owner,
            repo,
            pullNumber: pr.number,
            body: commentBody,
          });
          console.log('✅ Summary comment posted');
        } else {
          console.log('⏭️  Summary comment skipped (disabled by env var)');
        }

        // Add AIReviewed label
        await client.addReviewedLabel({
          owner,
          repo,
          pullNumber: pr.number,
          label: REVIEW_LABEL,
        });
        console.log('✅ Label added');

        console.log(`\n✅ ${repo}#${pr.number} review complete`);

        // Record success for the Slack digest
        prResults.push({
          prNumber: pr.number,
          repo,
          prUrl: pr.html_url,
          findingsCount: review.findings.length,
          summary: review.summaryMarkdown,
          recommendation: review.recommendation,
          coverage: coverageFields,
        });
      } catch (prError) {
        console.error(
          `\n❌ Error reviewing ${repo}#${pr.number}:`,
          prError.message
        );
        console.error(prError.stack);
        await emitEvent({
          event_type: 'pr_review_failed',
          correlation_id: correlationId,
          repo: fullName,
          pr_number: pr.number,
          agent: REVIEW_AGENT,
          profile: profile.id,
          payload: { error: prError.message },
        });
        // Record failure for the Slack digest so it appears as a ⚠️ entry
        // rather than silently vanishing from the summary.
        prResults.push({
          prNumber: pr.number,
          repo,
          failed: true,
          error: prError.message,
        });
      } finally {
        // Runs on every exit from this PR — success, parse failure, agent
        // timeout, or any other throw — so no bundle, and no copy of
        // BOB_API_KEY, is ever left behind.
        await cleanupBundle(bundle);
      }
      return prResults;
    };

    // REVIEW_CONCURRENCY workers, numbered from 1, each take the next item in
    // list order and take another when it finishes. `options.concurrency` is a
    // test hook. One review's failure never reaches another; the batch waits
    // for all of them.
    const requested = Math.max(
      1,
      Math.floor(options.concurrency) || REVIEW_CONCURRENCY
    );
    // Only an isolated agent gets a private HOME or config directory; any other
    // keeps per-user state in the real one and so runs alone.
    const concurrency = agents.effectiveConcurrency(adapter, requested);
    if (concurrency < requested) {
      console.log(
        `ℹ️  REVIEW_CONCURRENCY=${requested} ignored — '${agent}' shares one HOME, so reviews run one at a time`
      );
    }
    const pending = items.map((item, index) => ({ item, index }));
    const perPr = [];
    const report = () =>
      options.onProgress?.({
        inFlight: inFlight.map((entry) => ({ ...entry })),
        queued: pending.map(({ item }) =>
          refKey({ repo: item.repo, number: item.pr.number })
        ),
        concurrency,
      });
    report();

    const work = async (slot) => {
      while (pending.length > 0) {
        const { item, index } = pending.shift();
        const entry = {
          worker: slot,
          repo: item.repo,
          pr: item.pr.number,
          startedAt: new Date().toISOString(),
        };
        inFlight.push(entry);
        started++;
        report();
        try {
          perPr[index] = await reviewLog.runWithContext(
            { worker: slot, repo: item.repo, pr: item.pr.number },
            () => reviewOne(item)
          );
        } catch (error) {
          // reviewOne handles its own errors; this is a failure in its handler.
          perPr[index] = [
            {
              prNumber: item.pr.number,
              repo: item.repo,
              failed: true,
              error: error.message,
            },
          ];
        } finally {
          inFlight.splice(inFlight.indexOf(entry), 1);
          report();
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(concurrency, items.length) }, (_, i) =>
        work(i + 1)
      )
    );
    for (const outcomes of perPr) runResults.push(...outcomes);

    const runDurationMs = Date.now() - runStartedAt;
    await emitEvent({
      event_type: 'run_completed',
      correlation_id: correlationId,
      repo: runRepo,
      agent: REVIEW_AGENT,
      payload: {
        repos: fullNames,
        prs_reviewed: prsReviewedThisRun,
        duration_ms: runDurationMs,
        // Flat scalars, matching the rest of the payloads: a run that reviewed
        // two of the three PRs it was given is not the same as one given two.
        prs_requested: explicit ? refs.length : null,
        prs_fetch_failed: fetchFailures.length,
        target_mode: target.mode,
      },
    });

    // Post Slack digest for scheduled runs only
    if (options.triggeredBy === 'schedule') {
      await postRunDigest({
        startedAt: runStartedAt,
        repo: runRepo,
        repos: fullNames,
        results: runResults,
        maxPRs: MAX_PRS_PER_REPO,
        daysBack: N_DAYS_SINCE_PR_CREATED,
        emitEvent,
      });
    }

    console.log(`\n${'='.repeat(80)}`);
    console.log('✅ Carbon PR Review Agent Complete');
    console.log(`${'='.repeat(80)}\n`);
  } catch (error) {
    console.error('\n❌ Fatal error:', error.message);
    console.error(error.stack);
    await emitEvent({
      event_type: 'run_failed',
      correlation_id: correlationId,
      repo: runRepo,
      agent: REVIEW_AGENT,
      payload: { repos: fullNames, error: error.message },
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
module.exports = {
  reviewPRs,
  parsePrNumbers,
  parsePrRefs,
  resolveReviewTargets,
  resolveSpend,
  tokensFromStats,
  reviewTextFor,
  skillReadsFor,
  addSpend,
};

// Run if executed directly
if (require.main === module) {
  checkStartup({ mode: 'cli' });
  // Capture tags terminal lines with their worker and PR, as the console does.
  reviewLog.start(`cli-${Date.now()}`);
  reviewPRs()
    .catch((error) => {
      console.error('Fatal error:', error);
      process.exitCode = 1;
    })
    .finally(() => reviewLog.stop());
}
