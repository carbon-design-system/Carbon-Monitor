// Pure helpers for PR refs ({ repo, number }). No JSX and no Vite-only imports,
// so tests/prRefs.test.mjs can load this file under plain Node.

// Two repos can both have a #1204, so a bare number is not an identity.
export const keyOf = (ref) => `${ref.repo}#${ref.number}`;

// Groups refs by repo in the configured order; repos with no refs are dropped.
// A ref whose repo is no longer configured goes last, so it is never hidden.
export function groupByRepo(refs, repos = []) {
  const byRepo = new Map(repos.map((repo) => [repo, []]));
  for (const ref of refs || []) {
    if (!byRepo.has(ref.repo)) byRepo.set(ref.repo, []);
    byRepo.get(ref.repo).push(ref.number);
  }
  return [...byRepo]
    .filter(([, numbers]) => numbers.length > 0)
    .map(([repo, numbers]) => ({ repo, numbers }));
}

const TAG_TYPES = ['blue', 'purple', 'teal', 'cyan', 'magenta'];

// Stable tag colour per repo position, then repeat. The tag text names the repo,
// so colour is never the only cue.
export function tagTypeFor(repo, repos = []) {
  const i = repos.indexOf(repo);
  return i < 0 ? 'gray' : TAG_TYPES[i % TAG_TYPES.length];
}

// "a", "a and b", "a, b and c". `word` is "and" or "or".
export function joinList(items, word = 'and') {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} ${word} ${items[items.length - 1]}`;
}

// Matches the CLI's --pr form: "1204" or "carbon-ai-chat#1204".
export const PR_REF_RE = /^(?:([A-Za-z0-9._-]+)#)?(\d+)$/;

// " · merged" / " · closed" for a resolver match; empty while the PR is open.
export function stateSuffix(match) {
  if (match.state === 'open') return '';
  return match.mergedAt ? ' · merged' : ' · closed';
}

// "3 days ago" / "yesterday", from an ISO timestamp.
export function relativeTime(iso, now = Date.now()) {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const seconds = Math.round((then - now) / 1000);
  const units = [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['week', 604_800],
    ['day', 86_400],
    ['hour', 3600],
    ['minute', 60],
  ];
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) {
      return rtf.format(Math.round(seconds / size), unit);
    }
  }
  return rtf.format(0, 'second');
}

// One note per auto-chosen ref (resolution 'only-open'), recording the closed
// PRs it was picked over. Informational only; the server validates them.
export function resolutionNotesFor(results) {
  return results
    .filter((r) => r.resolution === 'only-open' && r.choice)
    .map((r) => ({
      repo: r.choice.repo,
      number: r.choice.number,
      alternatives: r.matches
        .filter((m) => m.repo !== r.choice.repo)
        .map((m) => ({
          repo: m.repo,
          state: m.state,
          mergedAt: m.mergedAt ?? null,
        })),
    }));
}

// Turns the typed entries into refs, in the order typed. `entries` are
// { repo: string|null, number }; a null repo is looked up in `chosen`
// (number -> repo, from the collision dialog) or in the resolver `results`.
// Duplicates by key are dropped, first seen wins: a typed number and a typed
// ref can name the same PR.
export function buildRefs(entries, results, chosen = {}) {
  const byNumber = new Map(results.map((r) => [r.number, r]));
  const seen = new Set();
  const refs = [];
  for (const entry of entries) {
    const repo =
      entry.repo ??
      chosen[entry.number] ??
      byNumber.get(entry.number)?.choice?.repo;
    if (!repo) continue;
    const ref = { repo, number: entry.number };
    if (seen.has(keyOf(ref))) continue;
    seen.add(keyOf(ref));
    refs.push(ref);
  }
  return refs;
}
