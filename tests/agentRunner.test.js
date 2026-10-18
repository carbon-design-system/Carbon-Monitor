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

// ── Claude, through the fake claude in tests/fixtures/bin ────────────────────

const cfx = (name) => path.join(fixtures, 'claude', name);

// The bundle dir needs its claude-config, as seedHome would have made it.
function runClaude(env, opts = {}) {
  const cwd = tmp();
  fs.mkdirSync(path.join(cwd, 'claude-config'));
  return run(env, { agent: 'claude', cwd, ...opts }).then(
    ({ result }) => ({ result, cwd }),
    (err) => {
      err.cwd = cwd;
      throw err;
    }
  );
}

// Runs with console output captured instead of silenced (run() silences it).
async function runClaudeLogged(env) {
  const lines = [];
  const { log, warn } = console;
  const write = process.stdout.write;
  const saved = process.env.CLAUDE_FAKE_FIXTURE;
  process.env.CLAUDE_FAKE_FIXTURE = env.CLAUDE_FAKE_FIXTURE;
  const cwd = tmp();
  fs.mkdirSync(path.join(cwd, 'claude-config'));
  console.log = console.warn = (...a) => lines.push(a.join(' '));
  process.stdout.write = () => true;
  try {
    await runAgent({ agent: 'claude', cwd, prompt: 'review' });
    return { lines };
  } finally {
    console.log = log;
    console.warn = warn;
    process.stdout.write = write;
    if (saved === undefined) delete process.env.CLAUDE_FAKE_FIXTURE;
    else process.env.CLAUDE_FAKE_FIXTURE = saved;
  }
}

const step2 =
  '## Step 2\nconfirmed finding — Icon-only button has no accessible name\n\n';

test('claude: blocks of one message join; distinct messages get a blank line', async () => {
  const { result } = await runClaude({
    CLAUDE_FAKE_FIXTURE: cfx('review-ok.ndjson'),
  });
  assert.strictEqual(result.format, 'stream-json');
  assert.ok(
    result.text.startsWith(
      'Loading the carbon-builder skill first.\n\n## Step 1\nButton.stories.js:42'
    )
  );
  assert.ok(result.text.includes(`\n\n${step2}BEGIN_REVIEW_JSON`));
  assert.ok(!result.text.includes('Load the skill first.'), 'thinking dropped');
  assert.ok(result.text.endsWith('END_REVIEW_JSON'));
});

test('claude: the text parses through parseReviewOutput with one finding', async () => {
  const { result } = await runClaude({
    CLAUDE_FAKE_FIXTURE: cfx('review-ok.ndjson'),
  });
  const review = await quiet(() =>
    parseReviewOutput(result.text, { skillReads: ['Skill:carbon-builder'] })
  );
  assert.ok(review, 'review parsed');
  assert.strictEqual(review.findings.length, 1);
  assert.ok(review.hasCatalogue);
});

test('claude: tool calls pair by id and summarise', async () => {
  const { result } = await runClaude({
    CLAUDE_FAKE_FIXTURE: cfx('review-ok.ndjson'),
  });
  assert.deepStrictEqual(
    result.toolCalls.map((c) => c.name),
    [
      'Skill',
      'Read',
      'Read',
      'mcp__carbon-mcp__docs_search',
      'mcp__carbon-mcp__code_audit',
    ]
  );
  assert.ok(result.toolCalls.every((c) => c.status === 'success'));
  assert.strictEqual(result.toolCalls[3].server, 'carbon-mcp');
  assert.strictEqual(result.toolCalls[3].tool, 'docs_search');
  const s = summarizeToolCalls(result.toolCalls, 'claude');
  assert.strictEqual(s.skillInvoked, true);
  assert.deepStrictEqual(s.skillFiles, [
    './.claude/skills/carbon-builder/SKILL.md',
  ]);
  assert.deepStrictEqual(s.mcpCalls, { docs_search: 1, code_audit: 1 });
  assert.strictEqual(s.total, 5);
});

test('claude: the result maps to stats', async () => {
  const { result } = await runClaude({
    CLAUDE_FAKE_FIXTURE: cfx('review-ok.ndjson'),
  });
  assert.strictEqual(result.status, 'success');
  assert.deepStrictEqual(result.stats, {
    task_id: 'sess-ok-0001',
    session_costs: 0.1834,
    input_tokens: 54220,
    output_tokens: 2210,
    cache_read_tokens: 38500,
    cache_write_tokens: 14200,
    total_tokens: 56430,
    duration_ms: 94250,
    tool_calls: 5,
    cost_unit: 'usd',
  });
  assert.ok(result.lastMessage.endsWith('END_REVIEW_JSON'));
});

test('claude: every fixture line survives the split chunks and is saved', async () => {
  const fixture = cfx('review-ok.ndjson');
  const { cwd } = await runClaude({ CLAUDE_FAKE_FIXTURE: fixture });
  const expected = fs.readFileSync(fixture, 'utf8').trim().split('\n');
  const saved = fs
    .readFileSync(path.join(cwd, 'agent-events.ndjson'), 'utf8')
    .trim()
    .split('\n');
  assert.deepStrictEqual(saved, expected);
  assert.strictEqual(
    fs.readFileSync(path.join(cwd, 'agent-output.txt'), 'utf8').slice(0, 20),
    'Loading the carbon-b'
  );
});

test('claude: the budget fixture rejects with cost-limit and its stats', async () => {
  await assert.rejects(
    runClaude({ CLAUDE_FAKE_FIXTURE: cfx('review-budget.ndjson') }),
    (err) => {
      assert.ok(err instanceof AgentRunError);
      assert.strictEqual(err.kind, 'cost-limit');
      assert.strictEqual(err.stats.task_id, 'sess-budget-0002');
      assert.strictEqual(err.stats.session_costs, 5.12);
      assert.ok(/claude exited with code 1/.test(err.message));
      return true;
    }
  );
});

test('claude: the turns fixture rejects with turn-limit', async () => {
  await assert.rejects(
    runClaude({ CLAUDE_FAKE_FIXTURE: cfx('review-turns.ndjson') }),
    (err) => {
      assert.strictEqual(err.kind, 'turn-limit');
      assert.strictEqual(err.stats.session_costs, 1.9);
      return true;
    }
  );
});

test('claude: other error results are agent-error, even with a zero exit', async () => {
  const error = (subtype, is_error = true) =>
    ndjson([
      {
        type: 'assistant',
        message: { id: 'm', content: [{ type: 'text', text: 'x' }] },
      },
      {
        type: 'result',
        subtype,
        is_error,
        session_id: 's',
        total_cost_usd: 0.3,
      },
    ]);
  for (const file of [
    error('error_during_execution'),
    error('success', true),
  ]) {
    await assert.rejects(
      runClaude({ CLAUDE_FAKE_FIXTURE: file, CLAUDE_FAKE_EXIT: '0' }),
      (err) => {
        assert.strictEqual(err.kind, 'agent-error');
        assert.strictEqual(err.stats.session_costs, 0.3);
        assert.ok(/reported an error result/.test(err.message));
        return true;
      }
    );
  }
});

test('claude: a non-zero exit after a clean result is kind exit', async () => {
  await assert.rejects(
    runClaude({
      CLAUDE_FAKE_FIXTURE: cfx('review-ok.ndjson'),
      CLAUDE_FAKE_EXIT: '3',
    }),
    (err) =>
      err.kind === 'exit' && /claude exited with code 3/.test(err.message)
  );
});

test('claude: messages with different ids stay apart, and a tool call splits one id', async () => {
  const text = (id, t) => ({
    type: 'assistant',
    message: { id, content: [{ type: 'text', text: t }] },
  });
  const file = ndjson([
    text('a', 'one'),
    text('a', ' more'),
    text('b', 'two'),
    {
      type: 'assistant',
      message: {
        id: 'b',
        content: [{ type: 'tool_use', id: 'u', name: 'Read', input: {} }],
      },
    },
    {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'u' }] },
    },
    text('b', 'three'),
    { type: 'result', subtype: 'success', is_error: false, session_id: 's' },
  ]);
  const { result } = await runClaude({ CLAUDE_FAKE_FIXTURE: file });
  assert.strictEqual(result.text, 'one more\n\ntwo\n\nthree');
});

test('claude: the child sees its own config dir, no Bob key, and the flags', async () => {
  const marker = path.join(tmp(), 'marker.json');
  const { cwd } = await runClaude({
    CLAUDE_FAKE_FIXTURE: cfx('review-ok.ndjson'),
    CLAUDE_FAKE_MARKER: marker,
    BOB_API_KEY: 'bob-secret',
    ANTHROPIC_API_KEY: 'sk-ant-test',
    GITHUB_AI_AGENT_TOKEN: 'gh-secret',
    ES_PASSWORD: 'es-secret',
    SLACK_WEBHOOK_URL: 'https://hooks.example/secret',
    CONSOLE_PASSWORD: 'console-secret',
  });
  const m = JSON.parse(fs.readFileSync(marker, 'utf8'));
  assert.strictEqual(
    fs.realpathSync(m.claudeConfigDir),
    fs.realpathSync(path.join(cwd, 'claude-config'))
  );
  assert.strictEqual(m.disableAutoupdater, '1');
  assert.strictEqual(m.hasAnthropicKey, true);
  assert.strictEqual(m.hasBobKey, false);
  for (const k of [
    'GITHUB_AI_AGENT_TOKEN',
    'BOB_API_KEY',
    'ES_PASSWORD',
    'SLACK_WEBHOOK_URL',
    'CONSOLE_PASSWORD',
  ]) {
    assert.ok(!m.envKeys.includes(k), `${k} reached the child`);
  }
  assert.ok(m.envKeys.includes('PATH'));
  assert.ok(m.envKeys.includes('ANTHROPIC_API_KEY'));
  assert.ok(m.envKeys.includes('CLAUDE_CONFIG_DIR'));
  assert.ok(m.envKeys.includes('DISABLE_AUTOUPDATER'));
  assert.deepStrictEqual(
    m.envKeys
      .filter((k) => !/^(ANTHROPIC_|CLAUDE_|__CF_)/.test(k)) // macOS adds __CF_*
      .sort(),
    m.envKeys
      .filter((k) =>
        /^(PATH|HOME|TMPDIR|LANG|LC_ALL|TERM|USER|LOGNAME|SHELL|DISABLE_AUTOUPDATER|(HTTPS?|NO)_PROXY|SSL_CERT_FILE|NODE_EXTRA_CA_CERTS)$/i.test(
          k
        )
      )
      .sort(),
    'only allowlisted names'
  );
  assert.strictEqual(
    m.mcpConfig,
    path.join(cwd, 'claude-config', 'claude-mcp.json')
  );
  assert.strictEqual(m.args[0], '-p');
  assert.strictEqual(m.args[m.args.length - 1], 'review');
  assert.ok(m.args.includes('--strict-mcp-config'));
  assert.ok(m.args.includes('--no-session-persistence'));
});

test('claude: the baseline denies reach the CLI even when the deny list is overridden', async () => {
  const marker = path.join(tmp(), 'deny-marker.json');
  await runClaude(
    {
      CLAUDE_FAKE_FIXTURE: cfx('review-ok.ndjson'),
      CLAUDE_FAKE_MARKER: marker,
    },
    { caps: { disallowedTools: 'Bash' } }
  );
  const { args } = JSON.parse(fs.readFileSync(marker, 'utf8'));
  assert.strictEqual(
    args[args.indexOf('--disallowedTools') + 1],
    'Bash,Read(./claude-config/**),Read(~/**),Read(//proc/**)'
  );
  assert.strictEqual(
    args[args.indexOf('--allowedTools') + 1],
    'Read(./**),Glob,Grep,Skill(carbon-builder),mcp__carbon-mcp'
  );
});

test('claude: init is logged once and a connected carbon-mcp raises no warning', async () => {
  const { lines } = await runClaudeLogged({
    CLAUDE_FAKE_FIXTURE: cfx('review-ok.ndjson'),
  });
  const init = lines.filter((l) => l.includes('session:'));
  assert.deepStrictEqual(init, [
    '🧭 claude session: model=claude-sonnet-5-5, MCP: carbon-mcp=connected, skills: 1',
  ]);
  assert.ok(!lines.some((l) => /carbon-mcp is/.test(l)));
});

test('claude: a carbon-mcp that is not connected is a warning', async () => {
  const init = (mcp_servers) =>
    ndjson([
      { type: 'system', subtype: 'init', model: 'm', mcp_servers, skills: [] },
      { type: 'result', subtype: 'success', is_error: false, session_id: 's' },
    ]);
  const failedLines = (
    await runClaudeLogged({
      CLAUDE_FAKE_FIXTURE: init([{ name: 'carbon-mcp', status: 'failed' }]),
    })
  ).lines;
  assert.ok(failedLines.some((l) => /carbon-mcp is failed/.test(l)));
  const missing = (await runClaudeLogged({ CLAUDE_FAKE_FIXTURE: init([]) }))
    .lines;
  assert.ok(missing.some((l) => /carbon-mcp is not configured/.test(l)));
});

test('claude: permission denials are logged by tool name', async () => {
  const file = ndjson([
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      session_id: 's',
      permission_denials: [{ tool_name: 'Bash' }, { tool_name: 'Bash' }],
    },
  ]);
  const { lines } = await runClaudeLogged({ CLAUDE_FAKE_FIXTURE: file });
  assert.ok(
    lines.some((l) => l === '⚠️  claude was denied 2 tool call(s): Bash'),
    lines.join('\n')
  );
});

test('buildAgentArgs and runAgent accept the id and reject an unknown one', async () => {
  const args = buildAgentArgs({
    agent: 'claude',
    prompt: 'P',
    bundleDir: '/b',
  });
  assert.strictEqual(args[0], '-p');
  assert.strictEqual(args[args.length - 1], 'P');
  assert.throws(
    () => buildAgentArgs({ agent: 'codex', prompt: 'P' }),
    /Invalid agent type: codex\. Must be one of: bob, claude/
  );
  await assert.rejects(
    runAgent({ agent: 'codex', cwd: tmp(), prompt: 'P' }),
    /Invalid agent type: codex\. Must be one of: bob, claude/
  );
});

test('claude: real 2.1.295 stream from carbon#22971 reassembles, maps stats and parses', async () => {
  // Captured live on Oct 18, 2026 (redacted): thinking blocks, system/thinking_tokens
  // events, Read/Skill/ToolSearch/Glob calls, a result with cache token fields.
  const { result } = await runClaude({
    CLAUDE_FAKE_FIXTURE: cfx('review-real.ndjson'),
  });
  assert.strictEqual(result.status, 'success');
  assert.ok(result.text.includes('BEGIN_REVIEW_JSON'));
  assert.ok(result.text.includes('END_REVIEW_JSON'));
  assert.ok(!result.text.includes('[redacted]'), 'thinking blocks dropped');
  assert.ok(result.lastMessage.includes('END_REVIEW_JSON'));
  assert.deepStrictEqual(
    result.toolCalls.map((c) => c.name),
    ['Read', 'Skill', 'ToolSearch', 'Glob']
  );
  assert.ok(Math.abs(result.stats.session_costs - 0.330219) < 1e-6);
  assert.strictEqual(result.stats.input_tokens, 274296);
  assert.strictEqual(result.stats.output_tokens, 14823);
  assert.strictEqual(result.stats.cache_read_tokens, 219020);
  assert.strictEqual(result.stats.tool_calls, 4);
  assert.strictEqual(result.stats.cost_unit, 'usd');
  assert.strictEqual(
    result.stats.task_id,
    '4de90140-0000-4000-8000-000000000001'
  );
  const evidence = require('../src/agents/claude').evidence(result.toolCalls);
  assert.strictEqual(evidence.skillInvoked, true);
  const review = await quiet(() =>
    parseReviewOutput(result.text, { skillReads: ['Skill:carbon-builder'] })
  );
  assert.ok(review, 'real review parsed');
  assert.strictEqual(review.findings.length, 15);
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
