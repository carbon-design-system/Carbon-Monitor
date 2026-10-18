/**
 * Offline tests for the agent runner, using the fake Bob in tests/fixtures/bin.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const fixtures = path.join(__dirname, 'fixtures');
process.env.PATH = `${path.join(fixtures, 'bin')}${path.delimiter}${process.env.PATH}`;
process.env.NO_COLOR = '1';
delete process.env.BOB_TEAM_ID;
// A developer's shell must not change the outcome.
for (const k of [
  'BOB_OUTPUT_FORMAT',
  'BOB_MAX_COST',
  'BOB_MAX_TURNS',
  'BOB_DISABLE_TOOL_GROUPS',
]) {
  delete process.env[k];
}

const {
  runAgent,
  AgentRunError,
  buildAgentArgs,
  summarizeToolCalls,
} = require('../src/agentRunner');
const { parseReviewOutput } = require('../src/reviewParser');

const fx = (name) => path.join(fixtures, 'bob', name);
const tmpDirs = [];
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-runner-'));
  tmpDirs.push(dir);
  return dir;
};
const ndjson = (events) => {
  const file = path.join(tmp(), 'events.ndjson');
  fs.writeFileSync(
    file,
    events.map((e) => JSON.stringify(e)).join('\n') + '\n'
  );
  return file;
};
const quiet = async (fn) => {
  const write = process.stdout.write;
  const warn = console.warn;
  const log = console.log;
  process.stdout.write = () => true;
  console.warn = console.log = () => {};
  try {
    return await fn();
  } finally {
    process.stdout.write = write;
    console.warn = warn;
    console.log = log;
  }
};

function run(env, opts = {}) {
  const cwd = tmp();
  const saved = {};
  for (const k of Object.keys(env)) saved[k] = process.env[k];
  Object.assign(process.env, env);
  const restore = () => {
    for (const k of Object.keys(env)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  };
  return quiet(() =>
    runAgent({ agent: 'bob', cwd, prompt: 'review', ...opts })
  ).then(
    (result) => {
      restore();
      return { result, cwd };
    },
    (err) => {
      restore();
      err.cwd = cwd;
      throw err;
    }
  );
}

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

test('assembles text from assistant messages, reasoning excluded', async () => {
  const { result } = await run({ FAKE_BOB_FIXTURE: fx('review-ok.ndjson') });
  assert.strictEqual(result.format, 'stream-json');
  assert.ok(result.text.includes('BEGIN_REVIEW_JSON'));
  assert.ok(!result.text.includes('should load the carbon-builder skill'));
  assert.ok(!result.text.includes('agentic PR reviewer'));
  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.lastMessage, 'Review complete.');
});

test('text parses through parseReviewOutput with one finding', async () => {
  const { result } = await run({ FAKE_BOB_FIXTURE: fx('review-ok.ndjson') });
  const review = await quiet(() => parseReviewOutput(result.text));
  assert.ok(review, 'review parsed');
  assert.strictEqual(review.findings.length, 1);
});

test('real Bob 2.0.0 stream: token-level message pieces reassemble and parse', async () => {
  // Captured live from a review of carbon-design-system/carbon#22971: 1186
  // assistant pieces with no delta flag, a result with no last_message and no
  // token fields.
  const { result } = await run({ FAKE_BOB_FIXTURE: fx('review-real.ndjson') });
  assert.strictEqual(result.format, 'stream-json');
  assert.ok(result.text.includes('BEGIN_REVIEW_JSON'));
  assert.ok(result.text.includes('END_REVIEW_JSON'));
  assert.ok(!result.text.includes('[prompt omitted from fixture]'));
  assert.strictEqual(result.lastMessage, null);
  assert.ok(Math.abs(result.stats.session_costs - 0.70495) < 1e-6);
  assert.strictEqual(result.stats.input_tokens, undefined);
  assert.strictEqual(result.toolCalls.length, 1);
  assert.strictEqual(result.toolCalls[0].name, 'read_file');
  const review = await quiet(() => parseReviewOutput(result.text));
  assert.ok(review, 'real review parsed');
  assert.ok(Array.isArray(review.findings));
});

test('stats carry session_costs as a number', async () => {
  const { result } = await run({ FAKE_BOB_FIXTURE: fx('review-ok.ndjson') });
  assert.strictEqual(result.stats.session_costs, 0.42);
  assert.strictEqual(result.stats.input_tokens, 41320);
  assert.strictEqual(result.stats.task_id, 'task-ok-0001');
});

test('tool calls pair by id and summarise', async () => {
  const { result } = await run({ FAKE_BOB_FIXTURE: fx('review-ok.ndjson') });
  assert.strictEqual(result.toolCalls.length, 4);
  assert.ok(result.toolCalls.every((c) => c.status === 'success'));
  const s = summarizeToolCalls(result.toolCalls);
  assert.strictEqual(s.skillInvoked, true);
  assert.strictEqual(s.mcpCalls.docs_search, 1);
  assert.strictEqual(s.mcpCalls.code_search, 1);
  assert.strictEqual(s.total, 4);
});

test('summarizeToolCalls collects skill files and unpaired status', () => {
  const s = summarizeToolCalls([
    {
      name: 'read_file',
      params: { path: '/w/.bob/skills/carbon-builder/SKILL.md' },
      status: 'success',
    },
    { name: 'read_file', params: { path: 'src/a.js' }, status: 'unknown' },
    { name: 'docs_search', params: {}, status: 'unknown' },
  ]);
  assert.deepStrictEqual(s.skillFiles, [
    '/w/.bob/skills/carbon-builder/SKILL.md',
  ]);
  assert.strictEqual(s.skillInvoked, false);
  assert.strictEqual(s.mcpCalls.docs_search, 1);
});

test('chunk boundaries: every fixture line becomes one event', async () => {
  const fixture = fx('review-ok.ndjson');
  const { result, cwd } = await run({ FAKE_BOB_FIXTURE: fixture });
  const expected = fs.readFileSync(fixture, 'utf8').trim().split('\n');
  const saved = fs
    .readFileSync(path.join(cwd, 'agent-events.ndjson'), 'utf8')
    .trim()
    .split('\n');
  assert.strictEqual(saved.length, expected.length);
  assert.deepStrictEqual(saved, expected);
  saved.forEach((l) => JSON.parse(l));
  assert.ok(result.stats, 'result event survived the split chunks');
});

test('writes agent-output.txt and agent-events.ndjson', async () => {
  const { result, cwd } = await run({
    FAKE_BOB_FIXTURE: fx('review-ok.ndjson'),
  });
  assert.strictEqual(
    fs.readFileSync(path.join(cwd, 'agent-output.txt'), 'utf8'),
    result.text
  );
  assert.ok(fs.existsSync(path.join(cwd, 'agent-events.ndjson')));
});

test('attempt_completion line is appended', async () => {
  const lines = [
    { type: 'message', role: 'assistant', content: 'Nothing to flag.' },
    {
      type: 'tool_use',
      tool_name: 'attempt_completion',
      tool_id: 'c1',
      parameters: { result: 'No issues found.' },
    },
    { type: 'tool_result', tool_id: 'c1', status: 'success' },
    { type: 'result', status: 'success', stats: { session_costs: 0.1 } },
  ];
  const file = path.join(tmp(), 'completion.ndjson');
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const { result } = await run({ FAKE_BOB_FIXTURE: file });
  assert.ok(
    result.text.endsWith('[attempt_completion] Result: No issues found.')
  );
  const review = await quiet(() => parseReviewOutput(result.text));
  assert.strictEqual(review.summaryMarkdown, 'No issues found.');
});

test('object session_costs are summed', async () => {
  await assert.rejects(
    run({ FAKE_BOB_FIXTURE: fx('review-cost-limit.ndjson') }),
    (err) => {
      assert.strictEqual(err.stats.session_costs, 1);
      return true;
    }
  );
});

test('cost-limit fixture rejects with kind cost-limit and stats', async () => {
  await assert.rejects(
    run({ FAKE_BOB_FIXTURE: fx('review-cost-limit.ndjson') }),
    (err) => {
      assert.ok(err instanceof AgentRunError);
      assert.strictEqual(err.kind, 'cost-limit');
      assert.strictEqual(err.stats.task_id, 'task-cost-0002');
      return true;
    }
  );
});

test('non-zero exit rejects with kind exit', async () => {
  await assert.rejects(
    run({ FAKE_BOB_FIXTURE: fx('review-ok.ndjson'), FAKE_BOB_EXIT: '3' }),
    (err) => {
      assert.ok(err instanceof AgentRunError);
      assert.strictEqual(err.kind, 'exit');
      assert.ok(/bob exited with code 3/.test(err.message));
      assert.ok(err.stderr.includes('fake-bob pid='));
      return true;
    }
  );
});

test('timeout rejects with kind timeout and the child is gone', async () => {
  let caught;
  await assert.rejects(
    run(
      { FAKE_BOB_FIXTURE: fx('review-ok.ndjson'), FAKE_BOB_SLEEP_MS: '5000' },
      { timeout: 1500 }
    ),
    (err) => {
      caught = err;
      assert.strictEqual(err.kind, 'timeout');
      assert.ok(/bob timeout \(1\.5 seconds\)/.test(err.message));
      return true;
    }
  );
  const m = /pid=(\d+)/.exec(caught.stderr);
  assert.ok(m, `no pid captured from stderr: ${JSON.stringify(caught.stderr)}`);
  const pid = Number(m[1]);
  await new Promise((r) => setTimeout(r, 300));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('no result event falls back to raw text and null stats', async () => {
  const { result, cwd } = await run({
    FAKE_BOB_FIXTURE: fx('review-no-result.txt'),
  });
  assert.strictEqual(result.format, 'text');
  assert.strictEqual(result.stats, null);
  assert.deepStrictEqual(result.toolCalls, []);
  assert.strictEqual(
    result.text,
    fs.readFileSync(fx('review-no-result.txt'), 'utf8')
  );
  const review = await quiet(() => parseReviewOutput(result.text));
  assert.ok(review);
  assert.ok(fs.existsSync(path.join(cwd, 'agent-events.ndjson')));
});

test('pretty format omits --format and still runs', async () => {
  const { result, cwd } = await run(
    {
      FAKE_BOB_FIXTURE: fx('review-no-result.txt'),
      FAKE_BOB_ALLOW_PRETTY: '1',
      FAKE_BOB_ARGS: '1',
    },
    { format: 'pretty' }
  );
  assert.strictEqual(result.format, 'pretty');
  assert.strictEqual(result.stats, null);
  const stderr = fs.readFileSync(path.join(cwd, 'agent-stderr.txt'), 'utf8');
  const args = JSON.parse(/args=(.*)/.exec(stderr)[1]);
  assert.ok(!args.includes('--format'));
  assert.ok(!fs.existsSync(path.join(cwd, 'agent-events.ndjson')));
});

test('buildAgentArgs: stream-json, caps and pretty', () => {
  const caps = {
    maxCost: 2.5,
    maxTurns: 40,
    disableToolGroups: 'edit,execute',
  };
  assert.deepStrictEqual(
    buildAgentArgs({ agent: 'bob', prompt: 'P', format: 'stream-json', caps }),
    [
      'run',
      '--format',
      'stream-json',
      '--trust',
      '--accept-license',
      '--max-cost',
      '2.5',
      '--max-turns',
      '40',
      '--disable-tool-groups',
      'edit,execute',
      'P',
    ]
  );
  assert.deepStrictEqual(
    buildAgentArgs({
      agent: 'bob',
      prompt: 'P',
      format: 'stream-json',
      caps: { maxCost: 0, maxTurns: 0, disableToolGroups: '' },
    }),
    ['run', '--format', 'stream-json', '--trust', '--accept-license', 'P']
  );
  assert.deepStrictEqual(
    buildAgentArgs({ agent: 'bob', prompt: 'P', format: 'pretty', caps }),
    [
      'run',
      '--trust',
      '--accept-license',
      '--max-cost',
      '2.5',
      '--max-turns',
      '40',
      '--disable-tool-groups',
      'edit,execute',
      'P',
    ]
  );
  assert.deepStrictEqual(
    buildAgentArgs({ agent: 'bob', prompt: 'P', format: 'pretty', caps: {} }),
    ['run', '--trust', '--accept-license', 'P']
  );
  process.env.BOB_TEAM_ID = 'team-1';
  assert.deepStrictEqual(
    buildAgentArgs({ agent: 'bob', prompt: 'P', format: 'pretty' }),
    ['run', '--trust', '--accept-license', '--team-id', 'team-1', 'P']
  );
  delete process.env.BOB_TEAM_ID;
});

test('turn-limit fixture rejects with kind turn-limit and stats', async () => {
  await assert.rejects(
    run({ FAKE_BOB_FIXTURE: fx('review-turn-limit.ndjson') }),
    (err) => {
      assert.strictEqual(err.kind, 'turn-limit');
      assert.strictEqual(err.stats.task_id, 'task-turns-0003');
      return true;
    }
  );
});

test('a success run with a warning still resolves', async () => {
  const file = ndjson([
    { type: 'message', role: 'assistant', content: 'Done.' },
    { type: 'error', severity: 'warning', message: 'Tool returned no output' },
    { type: 'result', status: 'success', stats: { session_costs: 0.2 } },
  ]);
  const { result } = await run({ FAKE_BOB_FIXTURE: file });
  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.text, 'Done.');
});

test('a success run with a limit-worded error event still resolves', async () => {
  const file = ndjson([
    { type: 'message', role: 'assistant', content: 'Done.' },
    { type: 'error', severity: 'error', message: 'Turn limit nearly reached' },
    { type: 'result', status: 'success', stats: { session_costs: 0.2 } },
  ]);
  const { result } = await run({ FAKE_BOB_FIXTURE: file });
  assert.strictEqual(result.status, 'success');
});

test('delta messages are joined without a gap', async () => {
  const file = ndjson([
    {
      type: 'message',
      role: 'assistant',
      content: 'BEGIN_REVIEW_',
      delta: true,
    },
    { type: 'message', role: 'assistant', content: 'JSON {"a"', delta: true },
    {
      type: 'message',
      role: 'assistant',
      content: ':1}\nEND_REVIEW_JSON',
      delta: true,
    },
    {
      type: 'message',
      role: 'assistant',
      isReasoning: true,
      content: 'thinking',
    },
    { type: 'message', role: 'assistant', content: 'second message' },
    { type: 'result', status: 'success', stats: {} },
  ]);
  const { result } = await run({ FAKE_BOB_FIXTURE: file });
  assert.strictEqual(
    result.text,
    'BEGIN_REVIEW_JSON {"a":1}\nEND_REVIEW_JSON\n\nsecond message'
  );
});

test('a delta after a tool call starts a new message', async () => {
  const file = ndjson([
    { type: 'message', role: 'assistant', content: 'pending', delta: true },
    {
      type: 'tool_use',
      tool_name: 'use_mcp_tool',
      tool_id: 't1',
      parameters: { tool_name: 'docs_search' },
    },
    { type: 'tool_result', tool_id: 't1', status: 'success', output: '{}' },
    { type: 'message', role: 'assistant', content: 'Verified', delta: true },
    { type: 'result', status: 'success', stats: {} },
  ]);
  const { result } = await run({ FAKE_BOB_FIXTURE: file });
  assert.strictEqual(result.text, 'pending\n\nVerified');
});

test('spawn failure rejects with kind spawn', async () => {
  await assert.rejects(run({ PATH: tmp() }), (err) => {
    assert.ok(err instanceof AgentRunError);
    assert.strictEqual(err.kind, 'spawn');
    assert.ok(/Failed to start bob/.test(err.message));
    return true;
  });
});

test('duplicate result events: the last one wins', async () => {
  const file = ndjson([
    { type: 'message', role: 'assistant', content: 'Hi.' },
    { type: 'result', status: 'success', stats: { session_costs: 0.1 } },
    { type: 'result', status: 'success', stats: { session_costs: 0.3 } },
  ]);
  const { result } = await run({ FAKE_BOB_FIXTURE: file });
  assert.strictEqual(result.stats.session_costs, 0.3);
});

test('only the last attempt_completion result is appended', async () => {
  const done = (id, text) => [
    {
      type: 'tool_use',
      tool_name: 'attempt_completion',
      tool_id: id,
      parameters: { result: text },
    },
    { type: 'tool_result', tool_id: id, status: 'success' },
  ];
  const file = ndjson([
    ...done('c1', 'first'),
    ...done('c2', 'second'),
    { type: 'result', status: 'success', stats: {} },
  ]);
  const { result } = await run({ FAKE_BOB_FIXTURE: file });
  assert.strictEqual(result.text, '[attempt_completion] Result: second');
});

test('the home option sets HOME for the child; the default leaves it alone', async () => {
  const home = tmp();
  const env = {
    FAKE_BOB_FIXTURE: fx('review-ok.ndjson'),
    FAKE_BOB_EXPECT_HOME: home,
  };
  const { result } = await run(env, { home });
  assert.strictEqual(result.status, 'success');
  await assert.rejects(run(env), (err) => err.kind === 'exit');
});

(async () => {
  let failed = 0;
  for (const [name, fn] of cases) {
    try {
      await fn();
      console.log(`PASS ${name}`);
    } catch (err) {
      failed++;
      console.log(`FAIL ${name}\n  ${err.stack || err}`);
    }
  }
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${cases.length - failed}/${cases.length} passed`);
  process.exit(failed ? 1 : 0);
})();
