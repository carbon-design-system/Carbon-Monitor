/**
 * Offline harness for reviewPRs under concurrency: a mock GitHub HTTP server, the
 * fake Bob in tests/fixtures/bin, and a sandbox for the workspace, ledger and HOME.
 * Used by tests/concurrency.test.js and evals/concurrency/*.js. Nothing here
 * touches the network beyond 127.0.0.1.
 */

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const fixtures = __dirname;

// Every PR changes this one file unless o.files[pr] says otherwise. The patch is
// what GitHub sends: no diff --git header, and the finding at line 42 is position 3.
const DEFAULT_FILES = [
  {
    filename: 'Button.stories.js',
    status: 'modified',
    additions: 1,
    deletions: 0,
    changes: 1,
    patch: '@@ -40,2 +40,3 @@\n a\n+b\n c',
  },
];

// A modified file whose assembled diff is exactly `total` characters.
function fileOfSize(filename, total) {
  const { fileDiff } = require(path.join(root, 'src', 'reviewCoverage'));
  const base = {
    filename,
    status: 'modified',
    additions: 1,
    deletions: 0,
    changes: 1,
    patch: '@@ -1 +1 @@\n+',
  };
  const pad = total - fileDiff(base).length;
  return { ...base, patch: base.patch + 'x'.repeat(pad) };
}

// o.files: { [pr]: file[] } replaces a PR's file list; o.changedFiles: { [pr]: n } sets its changed_files.
function startMockGithub(o = {}) {
  const writes = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const m =
        /^\/repos\/[^/]+\/[^/]+\/(pulls|issues|contents)\/([^/]+)(?:\/(\w+))?$/.exec(
          url.pathname
        );
      const json = (status, body) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.method !== 'GET') {
        let body = null;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString() || 'null');
        } catch {
          // Recorded as null.
        }
        writes.push({
          at: Date.now(),
          method: req.method,
          path: url.pathname,
          body,
        });
      }
      if (!m) return json(404, { message: 'Not Found' });
      const [, area, id, sub] = m;
      const n = Number(id);

      if (req.method === 'GET' && area === 'pulls' && !sub) {
        return json(200, {
          number: n,
          title: `Mock PR ${n}`,
          body: '',
          state: 'open',
          draft: false,
          user: { login: 'tester' },
          created_at: '2026-10-01T00:00:00Z',
          updated_at: '2026-10-01T00:00:00Z',
          html_url: `https://github.com/mock/mock/pull/${n}`,
          head: { sha: `sha${n}` },
          labels: [],
          changed_files:
            o.changedFiles?.[n] ?? (o.files?.[n] || DEFAULT_FILES).length,
        });
      }
      if (req.method === 'GET' && area === 'pulls' && sub === 'files') {
        const perPage = Number(url.searchParams.get('per_page')) || 30;
        const page = Number(url.searchParams.get('page')) || 1;
        const all = o.files?.[n] || DEFAULT_FILES;
        return json(200, all.slice((page - 1) * perPage, page * perPage));
      }
      if (req.method === 'POST' && area === 'issues' && sub === 'comments') {
        return json(201, { id: 1, body: '' });
      }
      if (req.method === 'POST' && area === 'issues' && sub === 'labels') {
        return json(200, [{ name: 'AIReviewed' }]);
      }
      if (req.method === 'POST' && area === 'pulls' && sub === 'reviews') {
        if (o.rejectReviews) {
          return json(422, {
            message: 'Unprocessable Entity',
            errors: ['Pull request review thread position is invalid'],
          });
        }
        return json(200, { id: 3, state: 'COMMENTED' });
      }
      if (req.method === 'POST' && area === 'pulls' && sub === 'comments') {
        return json(201, { id: 2, pull_request_review_id: 3 });
      }
      return json(404, { message: 'Not Found' }); // includes ORIGINAL_FILES.json
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        writes,
        close: () => {
          // Keep-alive sockets would hold close() for several seconds.
          server.closeAllConnections();
          return new Promise((r) => server.close(r));
        },
      })
    )
  );
}

// spec: { [pr]: { source: 'review-ok' | 'review-cost-limit', cost, severity, sleepMs, emptyFirstRuns } }
// severity replaces every "major" in the fixture: 'nit' gives green, 'blocking' red, none yellow.
// For agent 'claude' the sources are tests/fixtures/claude/*.ndjson.
function writeFixtures(dir, spec, agent = 'bob') {
  for (const [pr, s] of Object.entries(spec)) {
    let body = fs.readFileSync(
      path.join(fixtures, agent, `${s.source || 'review-ok'}.ndjson`),
      'utf8'
    );
    if (agent === 'claude') {
      body = body.replace(/sess-[a-z]+-\d+/g, `sess-${pr}`);
      if (s.cost === null) {
        body = body.replace(/"total_cost_usd":[^,}]+,/, '');
      } else if (s.cost !== undefined) {
        body = body.replace(
          /"total_cost_usd":[^,}]+/,
          `"total_cost_usd":${s.cost}`
        );
      }
    } else {
      body = body.replace(/"task_id":"[^"]+"/, `"task_id":"task-${pr}"`);
      if (s.cost === null) {
        body = body.replace(/"session_costs":[^,}]+,/, '');
      } else if (s.cost !== undefined) {
        body = body.replace(
          /"session_costs":[^,}]+/,
          `"session_costs":${s.cost}`
        );
      }
    }
    if (s.severity) {
      body = body.replace(
        /(\\"severity\\": \\")major(\\")/g,
        `$1${s.severity}$2`
      );
    }
    const directive = {};
    for (const k of ['sleepMs', 'emptyFirstRuns']) {
      if (s[k] !== undefined) directive[k] = s[k];
    }
    fs.writeFileSync(
      path.join(dir, `${pr}.ndjson`),
      `#fake-${agent} ${JSON.stringify(directive)}\n${body}`
    );
  }
}

const state = { digest: null, timeoutMs: 0, balance: null };
let reviewPRs = null;
let reviewLog = null;

// Patched once, before src/index.js destructures them at load.
function install() {
  if (reviewPRs) return;
  process.env.PATH = `${path.join(fixtures, 'bin')}${path.delimiter}${process.env.PATH}`;

  // Writes are serialised one second apart in production; not worth waiting for here.
  const gh = require(path.join(root, 'src', 'githubClient'));
  const createOctokit = gh.createOctokit;
  gh.createOctokit = (opts) =>
    createOctokit({ ...opts, throttle: { enabled: false } });

  const runner = require(path.join(root, 'src', 'agentRunner'));
  const runAgent = runner.runAgent;
  runner.runAgent = (opts) =>
    runAgent(state.timeoutMs ? { ...opts, timeout: state.timeoutMs } : opts);

  const slack = require(path.join(root, 'src', 'slackNotifier'));
  slack.postRunDigest = async (digest) => {
    state.digest = digest;
  };

  const credits = require(path.join(root, 'src', 'api', 'bobCredits'));
  const getBalance = credits.getBalance;
  credits.getBalance = async (o) =>
    typeof state.balance === 'function'
      ? state.balance(o)
      : state.balance || getBalance(o);

  reviewPRs = require(path.join(root, 'src', 'index')).reviewPRs;
  reviewLog = require(path.join(root, 'src', 'api', 'reviewLog'));
}

/**
 * Set up the sandbox (mock GitHub, fake Bob, env, silenced output), run `fn`
 * inside it, and return what the run left behind.
 * @param {Object} o
 * @param {Object} o.fixtures - see writeFixtures
 * @param {number} o.concurrency - REVIEW_CONCURRENCY
 * @param {number} [o.bobTimeoutMs] - override runAgent's 10 minute timeout
 * @param {Object|Function} [o.balance] - fake getBalance() result, or a function of its options
 * @param {Object[]} [o.ledgerSeed] - ledger entries present before the run
 * @param {boolean} [o.rejectReviews] - the mock answers 422 to grouped reviews
 * @param {Object} [o.files] - { [pr]: file[] } a PR's changed files, served paged; see DEFAULT_FILES
 * @param {Object} [o.changedFiles] - { [pr]: n } the changed_files the mock reports for a PR
 * @param {Function} fn - async ({ reviewPRs, reviewLog }) => value
 */
async function sandbox(o, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'concurrency-'));
  const mock = await startMockGithub({
    rejectReviews: o.rejectReviews,
    files: o.files,
    changedFiles: o.changedFiles,
  });
  const fixtureDir = path.join(tmp, 'fixtures');
  fs.mkdirSync(fixtureDir);
  writeFixtures(fixtureDir, o.fixtures, o.agent || 'bob');

  // A stand-in for the real ~/.bob, which the per-review HOME is seeded from.
  const realHome = path.join(tmp, 'real-home');
  const bob = path.join(realHome, '.bob');
  fs.mkdirSync(path.join(bob, 'settings'), { recursive: true });
  fs.mkdirSync(path.join(bob, 'rules'));
  fs.mkdirSync(path.join(bob, 'skills', 'x'), { recursive: true });
  fs.writeFileSync(path.join(bob, 'settings.json'), '{"licence":true}');
  fs.writeFileSync(path.join(bob, 'settings', 'settings.json'), '{}');
  fs.writeFileSync(
    path.join(bob, 'settings', 'mcp.json'),
    '{"mcpServers":{"carbon-mcp":{"headers":{"Authorization":"Bearer test"}}}}'
  );
  fs.writeFileSync(
    path.join(bob, 'trustedFolders.json'),
    '{"/workspace":true}'
  );
  fs.writeFileSync(path.join(bob, 'rules', 'a.md'), '# rule');
  fs.writeFileSync(path.join(bob, 'skills', 'x', 'SKILL.md'), '# skill');

  const env = {
    HOME: realHome,
    CARBON_MONITOR_SKIP_DOTENV: '1',
    AUTH_REQUIRED: 'false',
    GITHUB_AI_AGENT_CLI: o.agent || 'bob',
    GITHUB_AI_AGENT_TOKEN: 'test-token',
    GITHUB_API_BASE_URL: mock.url,
    BOB_WORKSPACE_ROOT: path.join(tmp, 'ws'),
    CREDIT_LEDGER_PATH: path.join(tmp, 'ledger.jsonl'),
    BOB_FAKE_FIXTURE_DIR: fixtureDir,
    BOB_FAKE_LOG: path.join(tmp, 'bob-runs.jsonl'),
    CLAUDE_FAKE_FIXTURE_DIR: fixtureDir,
    CLAUDE_FAKE_LOG: path.join(tmp, 'claude-runs.jsonl'),
    ...(o.agent === 'claude'
      ? { ANTHROPIC_API_KEY: 'sk-ant-test-not-real' }
      : {}),
    REVIEW_CONCURRENCY: String(o.concurrency),
    GITHUB_AI_AGENT_KEEP_ARTIFACTS: 'true',
    NO_COLOR: '1',
  };
  const unset = [
    'ES_URL',
    'SLACK_WEBHOOK_URL',
    'BOB_API_KEY',
    'BOB_TEAM_ID',
    'BOB_OUTPUT_FORMAT',
    'BOB_MAX_COST',
    'BOB_MAX_TURNS',
    'BOB_DISABLE_TOOL_GROUPS',
    'GITHUB_AI_AGENT_PR_NUMBER',
    'BOB_FAKE_FIXTURE',
    'BOB_FAKE_SLEEP_MS',
    'CLAUDE_FAKE_FIXTURE',
    'CLAUDE_FAKE_SLEEP_MS',
    'CLAUDE_FAKE_EXIT',
    'CLAUDE_MODEL',
    'CLAUDE_EFFORT',
    'CLAUDE_MAX_BUDGET_USD',
    'CLAUDE_MAX_TURNS',
    'CLAUDE_ALLOWED_TOOLS',
    'CLAUDE_DISALLOWED_TOOLS',
    'CLAUDE_MONTHLY_BUDGET_USD',
    ...(o.agent === 'claude' ? [] : ['ANTHROPIC_API_KEY']),
  ];
  const saved = {};
  for (const k of [...Object.keys(env), ...unset]) saved[k] = process.env[k];
  Object.assign(process.env, env);
  for (const k of unset) delete process.env[k];

  if (o.ledgerSeed) {
    fs.writeFileSync(
      env.CREDIT_LEDGER_PATH,
      o.ledgerSeed.map((e) => `${JSON.stringify(e)}\n`).join('')
    );
  }

  state.digest = null;
  state.timeoutMs = o.bobTimeoutMs || 0;
  state.balance = o.balance || null;
  install();

  const realStdout = process.stdout.write;
  const realStderr = process.stderr.write;
  process.stdout.write = () => true;
  process.stderr.write = () => true;
  const startedAt = Date.now();
  let value;
  try {
    value = await fn({ reviewPRs, reviewLog });
  } finally {
    process.stdout.write = realStdout;
    process.stderr.write = realStderr;
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }

  const readJsonl = (file) =>
    fs.existsSync(file)
      ? fs
          .readFileSync(file, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];
  const bundles = {};
  const ws = env.BOB_WORKSPACE_ROOT;
  for (const name of fs.existsSync(ws) ? fs.readdirSync(ws) : []) {
    const pr = Number(/pull-(\d+)-/.exec(name)[1]);
    const dir = path.join(ws, name);
    const envFile = ['fake-bob-env.json', 'fake-claude-env.json']
      .map((f) => path.join(dir, f))
      .find((f) => fs.existsSync(f));
    bundles[pr] = {
      dir,
      env: envFile ? JSON.parse(fs.readFileSync(envFile, 'utf8')) : null,
    };
  }

  const comments = (pr) =>
    mock.writes.filter(
      (w) => w.path.endsWith(`/issues/${pr}/comments`) && w.method === 'POST'
    );
  const reviews = (pr) =>
    mock.writes.filter(
      (w) => w.path.endsWith(`/pulls/${pr}/reviews`) && w.method === 'POST'
    );
  const inlineComments = (pr) =>
    mock.writes.filter(
      (w) => w.path.endsWith(`/pulls/${pr}/comments`) && w.method === 'POST'
    );
  const labels = (pr) =>
    mock.writes.filter(
      (w) => w.path.endsWith(`/issues/${pr}/labels`) && w.method === 'POST'
    );

  return {
    value,
    startedAt,
    writes: mock.writes,
    comments,
    reviews,
    inlineComments,
    labels,
    ledger: readJsonl(env.CREDIT_LEDGER_PATH),
    bobRuns: readJsonl(env.BOB_FAKE_LOG),
    claudeRuns: readJsonl(env.CLAUDE_FAKE_LOG),
    bundles,
    cleanup: async () => {
      await mock.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

/**
 * Run one batch against the mock and fake Bob.
 * @param {Object} o - sandbox options plus:
 * @param {number[]} o.prNumbers
 * @param {boolean} [o.envOnly] - rely on the REVIEW_CONCURRENCY environment variable alone
 */
async function runBatch(o) {
  const snapshots = [];
  const run = await sandbox(o, async ({ reviewPRs, reviewLog }) => {
    reviewLog.start('test');
    try {
      await reviewPRs({
        prNumbers: o.prNumbers,
        triggeredBy: 'schedule',
        ...(o.envOnly ? {} : { concurrency: o.concurrency }),
        onProgress: (s) => snapshots.push({ at: Date.now(), ...s }),
      });
    } finally {
      reviewLog.stop();
    }
    return reviewLog.read(0, 100000).lines;
  });
  return {
    ...run,
    snapshots,
    lines: run.value,
    digest: state.digest,
    maxInFlight: Math.max(0, ...snapshots.map((s) => s.inFlight.length)),
  };
}

module.exports = {
  runBatch,
  sandbox,
  startMockGithub,
  DEFAULT_FILES,
  fileOfSize,
};
