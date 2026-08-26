/******************************************************************************
 * Dependency Health Checks
 *
 * Probes each external dependency the review agent needs and returns a uniform
 * shape the UI can render without knowing anything about the underlying system.
 *
 * Every check is written so a failure is DIAGNOSABLE rather than merely red: an
 * operator looking at the status panel should be able to tell whether the
 * problem is a missing binary, a missing credential, an expired credential, or
 * an unreachable host — because the remedy differs in each case.
 *****************************************************************************/

const { spawn } = require('child_process');
const mcpConnection = require('./mcpConnection');
const bobCredits = require('./bobCredits');

/**
 * Status vocabulary, matching Carbon's IconIndicator `kind` values so the UI can
 * map a check straight onto an indicator without a translation table.
 */
const OK = 'succeeded';
const FAILED = 'failed';
const WARNING = 'caution-major';
const UNKNOWN = 'unknown';

/**
 * Run a command and capture its output.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {number} [timeoutMs=10000]
 * @returns {Promise<{code: number|null, stdout: string, stderr: string}>}
 */
function run(command, args, timeoutMs = 20_000) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(command, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      return resolve({ code: null, stdout: '', stderr: error.message, failure: 'spawn' });
    }

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      proc.kill();
      finish({ code: null, stdout, stderr: 'timed out', failure: 'timeout' });
    }, timeoutMs);

    proc.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    proc.on('close', (code) => finish({ code, stdout, stderr, failure: null }));

    // ENOENT here means the binary is genuinely absent — distinct from a binary
    // that exists but was too slow, which is why the cause is carried through
    // rather than collapsing both into one message.
    proc.on('error', (error) =>
      finish({
        code: null,
        stdout,
        stderr: error.message,
        failure: error.code === 'ENOENT' ? 'missing' : 'spawn',
      })
    );
  });
}

/**
 * Check the Bob Shell CLI: present on PATH, and authenticated.
 *
 * Presence and authentication are reported separately because they fail for
 * different reasons — a missing binary is a broken image, while a missing
 * BOB_API_KEY is a missing secret. Bob defaults to interactive SSO, which cannot
 * complete in a container, so an absent API key is a hard failure here even
 * though the binary itself is fine.
 *
 * @returns {Promise<Object>}
 */
async function checkBob() {
  // Bob is a ~20 MB bundle, so `--version` is not instant: it takes seconds on a
  // cold container and far longer under qemu emulation (measured at ~12s running
  // a linux/amd64 image on an arm64 host). A tight limit here reports a healthy
  // Bob as broken, so the ceiling is generous and overridable.
  const timeoutMs = Number(process.env.BOB_CHECK_TIMEOUT_MS || 20_000);
  const { code, stdout, stderr, failure } = await run('bob', ['--version'], timeoutMs);

  if (failure === 'timeout') {
    return {
      id: 'bob',
      label: 'Bob Shell CLI',
      status: WARNING,
      detail: `Did not respond within ${Math.round(timeoutMs / 1000)}s`,
      hint:
        'Bob is installed but slow to start. Raise BOB_CHECK_TIMEOUT_MS, or give ' +
        'the container more CPU.',
    };
  }

  if (code !== 0) {
    return {
      id: 'bob',
      label: 'Bob Shell CLI',
      status: FAILED,
      detail: failure === 'missing' ? 'Not found on PATH' : 'Failed to run',
      hint: stderr.trim() || 'The image did not install Bob Shell correctly.',
    };
  }

  const version = stdout.trim().split('\n')[0] || 'unknown';
  const hasApiKey = !!process.env.BOB_API_KEY;

  if (!hasApiKey) {
    return {
      id: 'bob',
      label: 'Bob Shell CLI',
      status: FAILED,
      detail: `v${version} — not authenticated`,
      hint:
        'BOB_API_KEY is not set. Bob falls back to browser SSO, which cannot ' +
        'complete in a container, so reviews will fail.',
    };
  }

  return {
    id: 'bob',
    label: 'Bob Shell CLI',
    status: OK,
    detail: `v${version} — API key configured`,
    hint: process.env.BOB_TEAM_ID ? `Team ${process.env.BOB_TEAM_ID}` : null,
  };
}

/**
 * Check the Carbon MCP connection, including a live call to the server.
 *
 * @returns {Promise<Object>}
 */
async function checkCarbonMcp() {
  const status = await mcpConnection.getStatus();

  if (!status.configured || (!status.hasToken && !status.hasSession)) {
    return {
      id: 'carbon-mcp',
      label: 'Carbon MCP',
      status: FAILED,
      detail: 'Not connected',
      hint: 'Connect with IBMid, or paste a bearer token and session id.',
      meta: status,
    };
  }

  if (status.needsReauth) {
    return {
      id: 'carbon-mcp',
      label: 'Carbon MCP',
      status: FAILED,
      detail: 'Refresh token rejected',
      hint: 'The stored grant was invalidated. Connect with IBMid again.',
      meta: status,
    };
  }

  const probeResult = await mcpConnection.probe();

  if (!probeResult.reachable) {
    return {
      id: 'carbon-mcp',
      label: 'Carbon MCP',
      status: FAILED,
      detail: 'Host unreachable',
      hint: probeResult.reason,
      meta: status,
    };
  }

  if (!probeResult.authorized) {
    return {
      id: 'carbon-mcp',
      label: 'Carbon MCP',
      status: FAILED,
      detail: `Credentials rejected (HTTP ${probeResult.status})`,
      hint: probeResult.reason,
      meta: status,
    };
  }

  // Authorized, but flag the case where the token is short-lived and nothing is
  // able to renew it — that connection is working now and dead within hours.
  if (!status.canAutoRefresh && !status.hasSession) {
    return {
      id: 'carbon-mcp',
      label: 'Carbon MCP',
      status: WARNING,
      detail: 'Connected — no refresh path',
      hint:
        'This bearer token cannot be renewed and will expire. Connect with ' +
        'IBMid, or supply a session id, for unattended refresh.',
      meta: status,
    };
  }

  const renewal = status.canAutoRefresh
    ? 'auto-refresh active'
    : 'server-side refresh via session';

  return {
    id: 'carbon-mcp',
    label: 'Carbon MCP',
    status: OK,
    detail: `Connected — ${renewal}`,
    hint: 'AI agent ready for queries.',
    meta: status,
  };
}

/**
 * Check the GitHub token by calling an endpoint that reports its own limits.
 *
 * Probes the target repository so the check fails for the same reasons a review
 * would: an unauthorised org (SAML SSO), an invisible repository, or a role too
 * low to apply the review label. /rate_limit is read afterwards only for the
 * number shown on the tile — it is exempt from rate limiting, so polling it
 * cannot consume the budget it reports.
 *
 * @returns {Promise<Object>}
 */
async function checkGitHub() {
  const token = process.env.GITHUB_AI_AGENT_TOKEN;

  if (!token) {
    return {
      id: 'github',
      label: 'GitHub',
      status: FAILED,
      detail: 'No token configured',
      hint: 'GITHUB_AI_AGENT_TOKEN is not set.',
    };
  }

  const owner = process.env.GITHUB_AI_AGENT_OWNER || 'carbon-design-system';
  const repo = process.env.GITHUB_AI_AGENT_REPO || 'carbon';
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'carbon-monitor',
  };

  const get = async (url) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    return fetch(url, { headers, signal: controller.signal }).finally(() =>
      clearTimeout(timer)
    );
  };

  try {
    // Probe the TARGET REPOSITORY, not just /rate_limit.
    //
    // /rate_limit is user-scoped: it answers 200 for a token that cannot touch
    // the repository at all. Under SAML SSO enforcement — which
    // carbon-design-system has — an unauthorised token passes /rate_limit and
    // then 403s on the very first real call, so probing it alone reported a
    // healthy tile while every review failed. Verified against a live token:
    // /rate_limit → 200, /repos/carbon-design-system/carbon → 403.
    //
    // This call also returns the viewer's `permissions`, which is the only way to
    // detect the Triage requirement before a run hits it.
    const repoRes = await get(`https://api.github.com/repos/${owner}/${repo}`);

    if (repoRes.status === 401) {
      return {
        id: 'github',
        label: 'GitHub',
        status: FAILED,
        detail: 'Token rejected',
        hint: 'GITHUB_AI_AGENT_TOKEN is invalid, revoked or expired.',
      };
    }

    if (repoRes.status === 403) {
      let message = '';
      try {
        message = (await repoRes.json()).message || '';
      } catch (_) {
        /* body may not be JSON */
      }

      // GitHub returns this verbatim, and it is genuinely actionable: the token
      // exists and works elsewhere, it simply has not been authorised for the org.
      if (/SAML|SSO/i.test(message)) {
        return {
          id: 'github',
          label: 'GitHub',
          status: FAILED,
          detail: `Not SSO-authorized for ${owner}`,
          hint:
            'The token is valid but has not been granted access to this ' +
            `organization. Authorize it at https://github.com/orgs/${owner}/sso ` +
            '(or Settings → Developer settings → your token → Configure SSO).',
        };
      }

      return {
        id: 'github',
        label: 'GitHub',
        status: FAILED,
        detail: 'Access forbidden',
        hint: message || `The token cannot access ${owner}/${repo}.`,
      };
    }

    if (repoRes.status === 404) {
      return {
        id: 'github',
        label: 'GitHub',
        status: FAILED,
        detail: `${owner}/${repo} not found`,
        hint:
          'Either the repository does not exist or the token cannot see it. A ' +
          'fine-grained token must list this repository under Repository access.',
      };
    }

    if (!repoRes.ok) {
      return {
        id: 'github',
        label: 'GitHub',
        status: FAILED,
        detail: `HTTP ${repoRes.status}`,
        hint: 'GitHub API returned an unexpected status.',
      };
    }

    const repoBody = await repoRes.json();

    // Labelling a PR needs Triage or higher, and no token scope grants it — the
    // account itself must hold the role. Worth catching here: addReviewedLabel
    // throws, and because the label is the de-duplication key, a run without it
    // re-reviews the same PRs and posts duplicate comments every time.
    const perms = repoBody.permissions || {};
    const canLabel = !!(perms.push || perms.triage || perms.maintain || perms.admin);

    // Reported second and non-fatally: it is a number for the tile, not a gate,
    // and /rate_limit is itself exempt from rate limiting.
    let quota = '';
    let low = false;
    try {
      const limitRes = await get('https://api.github.com/rate_limit');
      if (limitRes.ok) {
        const core = (await limitRes.json()).resources?.core;
        if (core) {
          quota = `${core.remaining}/${core.limit} API calls remaining`;
          low = core.remaining < 100;
        }
      }
    } catch (_) {
      /* quota is decoration; never fail the check on it */
    }

    if (!canLabel) {
      return {
        id: 'github',
        label: 'GitHub',
        status: WARNING,
        detail: `Read-only on ${owner}/${repo}`,
        hint:
          'The token can read but not apply the review label (needs Triage or ' +
          'higher). Reviews will fail at the labelling step, and because the ' +
          'label marks a PR as done, the same PRs get reviewed again next run.',
      };
    }

    return {
      id: 'github',
      label: 'GitHub',
      status: low ? WARNING : OK,
      detail: quota || `Connected to ${owner}/${repo}`,
      hint: `Monitoring ${owner}/${repo}${quota ? '' : ' — quota unavailable'}`,
    };
  } catch (error) {
    return {
      id: 'github',
      label: 'GitHub',
      status: FAILED,
      detail: 'Unreachable',
      hint: error.message,
    };
  }
}

/**
 * Check the Bobcoins balance backing the agent.
 *
 * An exhausted budget is the failure mode this exists to catch: Bob keeps
 * authenticating right up to the moment a run is refused for cost, so without
 * this the first symptom is a review that dies mid-flight for no visible reason.
 *
 * A lookup that simply could not complete reports UNKNOWN rather than FAILED —
 * the balance is informational, reviews run without it, and a billing endpoint
 * having a bad day must not paint the whole panel red.
 *
 * @returns {Promise<Object>}
 */
async function checkBobCredits() {
  const balance = await bobCredits.getBalance();

  if (!balance.available) {
    // checkBob already reports a missing BOB_API_KEY as a hard failure; repeating
    // it here would show one root cause as two red tiles.
    if (balance.reason === 'no-api-key') {
      return {
        id: 'bobcoins',
        label: 'Bobcoins',
        status: UNKNOWN,
        detail: 'Not configured',
        hint: 'BOB_API_KEY is not set, so the balance cannot be read.',
      };
    }

    if (balance.reason === 'unauthorized') {
      return {
        id: 'bobcoins',
        label: 'Bobcoins',
        status: FAILED,
        detail: 'API key rejected',
        hint: 'The Bob gateway refused BOB_API_KEY. Reviews will fail too.',
      };
    }

    if (balance.reason === 'budget-exceeded') {
      return {
        id: 'bobcoins',
        label: 'Bobcoins',
        status: FAILED,
        detail: 'Budget exhausted',
        hint: 'The monthly Bobcoins allowance is spent. Reviews will be refused.',
      };
    }

    return {
      id: 'bobcoins',
      label: 'Bobcoins',
      status: UNKNOWN,
      detail: 'Balance unavailable',
      hint: `Could not read the balance (${balance.reason}). Reviews are unaffected.`,
    };
  }

  const resets = balance.refreshAt
    ? `Resets ${new Date(balance.refreshAt).toISOString().slice(0, 10)}`
    : null;
  const planNote = balance.planName ? `Plan ${balance.planName}` : null;
  const hint = [resets, planNote].filter(Boolean).join(' · ') || null;

  // No cap reported (an unmetered plan) — show what has been spent and stop
  // there; deriving a percentage from a missing limit would invent a number.
  if (balance.budgetLimit === null || balance.remaining === null) {
    return {
      id: 'bobcoins',
      label: 'Bobcoins',
      status: OK,
      detail: balance.usage !== null ? `${balance.usage} spent this period` : 'No budget reported',
      hint,
    };
  }

  if (balance.remaining <= 0) {
    return {
      id: 'bobcoins',
      label: 'Bobcoins',
      status: FAILED,
      detail: `0 of ${balance.budgetLimit} remaining`,
      hint: resets || 'The monthly allowance is spent. Reviews will be refused.',
    };
  }

  // Same reasoning as the GitHub rate-limit tile: a nearly-spent budget still
  // works right now and fails the next review, so it warns rather than passing.
  const lowPct = Number(process.env.BOB_CREDITS_LOW_PCT || 10);
  const low = balance.percentRemaining !== null && balance.percentRemaining < lowPct;

  return {
    id: 'bobcoins',
    label: 'Bobcoins',
    status: low ? WARNING : OK,
    detail: `${balance.remaining} of ${balance.budgetLimit} remaining`,
    hint: low ? `Below ${lowPct}% of the monthly budget. ${resets || ''}`.trim() : hint,
  };
}

/**
 * Check Elasticsearch, which is optional — the agent logs to the console when it
 * is not configured, so absence is reported as unknown rather than failed.
 *
 * @returns {Promise<Object>}
 */
async function checkElasticsearch() {
  if (!process.env.ES_URL) {
    return {
      id: 'elasticsearch',
      label: 'Elasticsearch',
      status: UNKNOWN,
      detail: 'Not configured',
      hint: 'Optional. Reviews run without it; metrics go to the console.',
    };
  }

  try {
    const { getClient } = require('../observability/esClient');
    const client = getClient();

    if (!client) {
      return {
        id: 'elasticsearch',
        label: 'Elasticsearch',
        status: FAILED,
        detail: 'Client unavailable',
        hint: 'ES_URL is set but the client could not be constructed.',
      };
    }

    const health = await client.cluster.health({}, { requestTimeout: 8000 });
    const clusterStatus = health.status || health.body?.status;

    return {
      id: 'elasticsearch',
      label: 'ElasticDB',
      status: clusterStatus === 'red' ? WARNING : OK,
      detail: `Cluster ${clusterStatus}`,
      // Deliberately not the cluster endpoint. The URL exposes internal IBM
      // Cloud infrastructure and is noise on the tile — a healthy connection
      // only needs to say it is up and what it is for. The failure paths below
      // still surface the actual error message so a broken tile stays diagnosable.
      hint: 'Connected for Telemetry',
    };
  } catch (error) {
    return {
      id: 'elasticsearch',
      label: 'ElasticDB',
      status: FAILED,
      detail: 'Unreachable',
      hint: error.message,
    };
  }
}

/**
 * Run every check concurrently.
 *
 * Checks are independent and each is individually time-boxed, so one slow
 * dependency delays the panel by its own timeout rather than the sum of all of
 * them. A check that throws is reported as a failed tile instead of collapsing
 * the whole response — a broken probe must not hide the checks that did work.
 *
 * @returns {Promise<Object>} { checks: [...], overall: string, timestamp: string }
 */
async function runAll() {
  const runners = [
    ['bob', checkBob],
    ['bobcoins', checkBobCredits],
    ['carbon-mcp', checkCarbonMcp],
    ['github', checkGitHub],
    ['elasticsearch', checkElasticsearch],
  ];

  const checks = await Promise.all(
    runners.map(async ([id, fn]) => {
      try {
        return await fn();
      } catch (error) {
        return {
          id,
          label: id,
          status: FAILED,
          detail: 'Check failed',
          hint: error.message,
        };
      }
    })
  );

  // Optional dependencies report UNKNOWN, which must not drag the overall state
  // down — only a real failure or warning should.
  const overall = checks.some((c) => c.status === FAILED)
    ? FAILED
    : checks.some((c) => c.status === WARNING)
      ? WARNING
      : OK;

  return { checks, overall, timestamp: new Date().toISOString() };
}

module.exports = {
  runAll,
  checkBob,
  checkBobCredits,
  checkCarbonMcp,
  checkGitHub,
  checkElasticsearch,
};
