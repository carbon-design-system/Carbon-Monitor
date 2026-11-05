'use strict';

// Turns typed PR numbers into PR refs by asking GitHub which configured repos
// have a PR with that number. The API, the CLI and reviewPRs all use it.

const MAX_IN_FLIGHT = 4;

function toMatch(repo, pr) {
  return {
    repo,
    number: pr.number,
    title: pr.title,
    author: pr.user ? pr.user.login : null,
    createdAt: pr.created_at,
    state: pr.state,
    mergedAt: pr.merged_at || null,
    draft: Boolean(pr.draft),
    url: pr.html_url,
  };
}

/** Runs fn over items with a bounded pool; stops starting new work after a failure. */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  let failed = false;
  async function worker() {
    while (!failed && next < items.length) {
      const i = next++;
      try {
        results[i] = await fn(items[i]);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

/**
 * @returns {Promise<Array<{
 *   number: number,
 *   matches: Array<{ repo, number, title, author, createdAt, state, mergedAt, draft, url }>,
 *   choice: { repo, number } | null,
 *   resolution: 'unique' | 'only-open' | 'ambiguous' | 'not-found',
 * }>>}
 */
async function resolveNumbers({ client, owner, repos, numbers }) {
  const lookups = [];
  for (const number of numbers) {
    for (const repo of repos) lookups.push({ number, repo });
  }

  const found = await mapLimit(lookups, MAX_IN_FLIGHT, async (l) => {
    try {
      const pr = await client.fetchSinglePR({
        owner,
        repo: l.repo,
        pullNumber: l.number,
      });
      return toMatch(l.repo, pr);
    } catch (err) {
      if (err && err.status === 404) return null;
      throw err;
    }
  });

  return numbers.map((number, n) => {
    // Lookups were queued number by number, so repos stay in list order.
    const matches = found
      .slice(n * repos.length, (n + 1) * repos.length)
      .filter(Boolean);

    // A merged carbon#1204 from years ago does not compete with an open one elsewhere.
    const open = matches.filter((m) => m.state === 'open');
    let pick = null;
    let resolution = 'not-found';
    if (matches.length === 1) {
      pick = matches[0];
      resolution = 'unique';
    } else if (matches.length > 1 && open.length === 1) {
      pick = open[0];
      resolution = 'only-open';
    } else if (matches.length > 1) {
      resolution = 'ambiguous';
    }

    return {
      number,
      matches,
      choice: pick ? { repo: pick.repo, number: pick.number } : null,
      resolution,
    };
  });
}

module.exports = { resolveNumbers };
