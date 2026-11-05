// The "Review listed PRs" decisions, kept free of React and Vite-only imports so
// tests/listedReview.test.mjs can drive them under plain Node.

import { pluralPRs } from './prPhrasing.js';
import {
  PR_REF_RE,
  buildRefs,
  joinList,
  resolutionNotesFor,
} from './prRefs.js';

/**
 * Parse the comma-separated PR field, mirroring the server's rules exactly.
 *
 * Each entry is a bare number (`1204`, whose repository is looked up) or a named
 * ref (`carbon-ai-chat#1204`). Returns `{ numbers, refs, entries, error }`:
 * `numbers` are the bare ones, `refs` the named ones, and `entries` both in the
 * order typed. A blank field is valid and means auto mode — the server picks the
 * PRs. `maxTotal` may be null before GET /api/config has answered, in which case
 * the count is left to the server rather than checked against a guessed limit;
 * `repos` may be empty for the same reason, and then a named repo is not checked.
 *
 * This is a convenience so the operator learns about a typo immediately instead
 * of after a round trip; POST /api/review/trigger re-validates regardless and
 * its 400 message is the authority.
 */
export function parsePrNumbers(raw, maxTotal, repos) {
  const failed = (error) => ({
    numbers: [],
    refs: [],
    entries: [],
    error,
    duplicatesDropped: 0,
  });
  const trimmed = raw.trim();
  if (!trimmed) return failed(null);

  const entries = [];
  const seen = new Set();
  let duplicatesDropped = 0;

  for (const entry of trimmed.split(',').map((part) => part.trim())) {
    // An empty entry means a doubled or trailing comma. Everything else that
    // is not a number or repo#number — decimals, negatives, "abc" — is a typo,
    // and 0 is not a pull request number.
    if (!entry) {
      return failed('Separate pull request numbers with a single comma.');
    }
    const match = PR_REF_RE.exec(entry);
    const number = match ? Number(match[2]) : 0;
    if (!match || !Number.isSafeInteger(number) || number < 1) {
      return failed(
        `“${entry}” is not a pull request number. Use positive whole numbers, or a repository and number like ${repos?.[0] || 'carbon'}#1204, separated by commas.`
      );
    }

    let repo = null;
    if (match[1]) {
      repo = repos?.length
        ? repos.find((r) => r.toLowerCase() === match[1].toLowerCase())
        : match[1];
      if (!repo) {
        return failed(
          `“${entry}” names a repository that is not configured. The configured repositories are ${joinList(repos)}.`
        );
      }
    }

    // Duplicates are dropped rather than rejected, keeping first-seen order —
    // the same thing the server does, so the count check below agrees with it.
    // Counted so the field can flag it instead of collapsing quietly.
    const key = `${repo ?? ''}#${number}`;
    if (!seen.has(key)) {
      seen.add(key);
      entries.push({ repo, number });
    } else duplicatesDropped++;
  }

  if (maxTotal != null && entries.length > maxTotal) {
    return failed(
      `Up to ${pluralPRs(maxTotal)} per run; ${entries.length} given.`
    );
  }

  return {
    numbers: entries.filter((e) => !e.repo).map((e) => e.number),
    refs: entries.filter((e) => e.repo),
    entries,
    error: null,
    duplicatesDropped,
  };
}

// GITHUB_AI_AGENT_PR_NUMBER as /api/config sends it: "1204" or "carbon-ai-chat#1204".
export function targetPrText(target) {
  const text = String(target).trim();
  const match = PR_REF_RE.exec(text);
  if (match && match[1]) return `${match[1]}#${match[2]}`;
  return `PR #${match ? match[2] : text}`;
}

/**
 * What a click on "Review listed PRs" does before any request: open the busy
 * dialog, start the review, or look the bare numbers up first.
 *
 * @returns {{kind: 'busy'}|{kind: 'not-loaded'}|{kind: 'resolve', numbers: number[]}|
 *   {kind: 'trigger', request: Object}}
 */
export function planBeforeLookup({ running, entries, numbers, repos }) {
  // The lookups take a while, so do not make the operator wait for them only to
  // meet the busy modal. The 409 handler still covers a run that starts between
  // the last poll and this click.
  if (running) return { kind: 'busy' };
  if (repos.length === 0) return { kind: 'not-loaded' };

  // One repository: a bare number can only mean it, so there is no lookup. The
  // server fetches each PR inside the batch and keeps its per-number failure
  // handling.
  if (repos.length === 1) {
    const prs = buildRefs(
      entries.map((e) => ({ repo: e.repo ?? repos[0], number: e.number })),
      []
    );
    return { kind: 'trigger', request: { prs } };
  }

  // Every entry named its repository: nothing to look up.
  if (numbers.length === 0) {
    return planAfterLookup({ entries, results: [], repos });
  }
  return { kind: 'resolve', numbers };
}

/**
 * What to do once POST /api/review/resolve has answered: name the numbers found
 * nowhere, ask about the ones found in several repositories, or start.
 *
 * @returns {{kind: 'not-found', message: string}|
 *   {kind: 'collision', collision: Object}|{kind: 'trigger', request: Object}}
 */
export function planAfterLookup({ entries, results, repos }) {
  const missing = results
    .filter((r) => r.matches.length === 0)
    .map((r) => `#${r.number}`);
  if (missing.length) {
    return {
      kind: 'not-found',
      message: `No pull ${missing.length === 1 ? 'request' : 'requests'} ${joinList(missing)} in ${joinList(repos, 'or')}.`,
    };
  }

  const ambiguous = results.filter((r) => !r.choice);
  if (ambiguous.length) {
    return {
      kind: 'collision',
      collision: {
        groups: ambiguous.map((r) => ({
          number: r.number,
          matches: r.matches,
        })),
        // Typed refs count too: they also need nothing from the operator.
        others: entries.length - ambiguous.length,
        total: entries.length,
        entries,
        results,
      },
    };
  }

  return {
    kind: 'trigger',
    request: {
      prs: buildRefs(entries, results),
      resolutionNotes: resolutionNotesFor(results),
    },
  };
}

/** The refs a confirmed collision dialog sends, in the order typed. */
export function refsAfterChoice(collision, chosen) {
  return buildRefs(collision.entries, collision.results, chosen);
}
