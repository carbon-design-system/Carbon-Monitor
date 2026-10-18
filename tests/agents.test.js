/**
 * Offline tests for the agent adapters in src/agents: the registry, the argument
 * and environment contract, event parsing, evidence, credits and bundle seeding.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// A developer's shell must not change the outcome; constants read these at load.
for (const k of [
  'GITHUB_AI_AGENT_CLI',
  'BOB_OUTPUT_FORMAT',
  'BOB_MAX_COST',
  'BOB_MAX_TURNS',
  'BOB_DISABLE_TOOL_GROUPS',
  'BOB_TEAM_ID',
  'CLAUDE_MODEL',
  'CLAUDE_EFFORT',
  'CLAUDE_MAX_BUDGET_USD',
  'CLAUDE_MAX_TURNS',
  'CLAUDE_ALLOWED_TOOLS',
  'CLAUDE_DISALLOWED_TOOLS',
  'CLAUDE_MONTHLY_BUDGET_USD',
  'CLAUDE_BUDGET_LOW_PCT',
  'BOB_CREDITS_LOW_PCT',
]) {
  delete process.env[k];
}

const agents = require('../src/agents');
const constants = require('../src/constants');
const bob = agents.get('bob');
const claude = agents.get('claude');

const tmpDirs = [];
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-test-'));
  tmpDirs.push(dir);
  return dir;
};

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

test('registry: ids, get, find, current and the invalid-id error', () => {
  assert.deepStrictEqual(agents.ids(), ['bob', 'claude']);
  assert.strictEqual(agents.get('claude'), claude);
  assert.strictEqual(agents.get(), bob);
  assert.strictEqual(agents.current(), bob);
  assert.strictEqual(agents.find('codex'), null);
  assert.strictEqual(agents.DEFAULT_ID, 'bob');
  assert.throws(
    () => agents.get('codex'),
    (err) =>
      err.message === 'Invalid agent type: codex. Must be one of: bob, claude'
  );
});

test('resolve: the environment now, Bob when unset or unknown, never a throw', () => {
  const saved = process.env.GITHUB_AI_AGENT_CLI;
  try {
    delete process.env.GITHUB_AI_AGENT_CLI;
    assert.strictEqual(agents.resolve(), bob);
    process.env.GITHUB_AI_AGENT_CLI = 'claude';
    assert.strictEqual(agents.resolve(), claude);
    assert.strictEqual(agents.resolve('bob'), bob);
    process.env.GITHUB_AI_AGENT_CLI = 'not-an-agent';
    assert.strictEqual(agents.resolve(), bob);
    assert.strictEqual(agents.resolve(''), bob);
  } finally {
    if (saved === undefined) delete process.env.GITHUB_AI_AGENT_CLI;
    else process.env.GITHUB_AI_AGENT_CLI = saved;
  }
});

test('every adapter carries the full contract', () => {
  const fns = [
    'defaults',
    'streams',
    'buildArgs',
    'env',
    'prepareBundle',
    'seedHome',
    'parseEvent',
    'evidence',
    'credits',
  ];
  const strings = [
    'id',
    'displayName',
    'cliName',
    'binary',
    'requiredEnv',
    'costUnit',
    'resultSource',
  ];
  for (const a of agents.ids().map((id) => agents.get(id))) {
    for (const f of fns)
      assert.strictEqual(typeof a[f], 'function', `${a.id}.${f}`);
    for (const f of strings)
      assert.strictEqual(typeof a[f], 'string', `${a.id}.${f}`);
    assert.strictEqual(a.isolated, true);
    assert.deepStrictEqual(Object.keys(a.skill).sort(), [
      'dir',
      'pattern',
      'sentinel',
      'tool',
    ]);
    assert.ok(a.skill.pattern instanceof RegExp);
    assert.deepStrictEqual(Object.keys(a.promptFragments).sort(), [
      'noCompletion',
      'noFileWrite',
      'readTool',
      'skillPath',
    ]);
  }
  assert.deepStrictEqual(
    [bob, claude].map((a) => [a.displayName, a.cliName, a.binary]),
    [
      ['IBM Bob', 'Bob Shell CLI', 'bob'],
      ['Claude', 'Claude Code CLI', 'claude'],
    ]
  );
  assert.deepStrictEqual(
    [bob, claude].map((a) => [a.requiredEnv, a.costUnit, a.resultSource]),
    [
      ['BOB_API_KEY', 'bobcoins', 'bob-result'],
      ['ANTHROPIC_API_KEY', 'usd', 'claude-result'],
    ]
  );
});

test('EFFECTIVE_REVIEW_CONCURRENCY derives from the adapter', () => {
  assert.strictEqual(
    constants.EFFECTIVE_REVIEW_CONCURRENCY,
    constants.REVIEW_CONCURRENCY
  );
});

test('checkStartup requires the key the adapter names', () => {
  const { checkStartup } = require('../src/config/env');
  const saved = { ...process.env };
  const warn = console.warn;
  console.warn = () => {};
  try {
    delete process.env.BOB_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    process.env.GITHUB_AI_AGENT_TOKEN = 't';
    process.env.GITHUB_AI_AGENT_CLI = 'claude';
    let problems = checkStartup({ mode: 'cli' });
    assert.ok(problems.some((p) => p.startsWith('ANTHROPIC_API_KEY ')));
    assert.ok(!problems.some((p) => p.startsWith('BOB_API_KEY ')));
    process.env.GITHUB_AI_AGENT_CLI = 'bob';
    problems = checkStartup({ mode: 'cli' });
    assert.ok(problems.some((p) => p.startsWith('BOB_API_KEY ')));
    assert.ok(!problems.some((p) => p.startsWith('ANTHROPIC_API_KEY ')));
  } finally {
    console.warn = warn;
    for (const k of Object.keys(process.env)) {
      if (!(k in saved)) delete process.env[k];
    }
    Object.assign(process.env, saved);
  }
});

test('Bob buildArgs: the same flags as before, through the adapter', () => {
  const caps = { maxCost: 2.5, maxTurns: 40, disableToolGroups: 'edit' };
  assert.deepStrictEqual(
    bob.buildArgs({ prompt: 'P', format: 'stream-json', caps }),
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
      'edit',
      'P',
    ]
  );
  assert.deepStrictEqual(bob.buildArgs({ prompt: 'P', format: 'pretty' }), [
    'run',
    '--trust',
    '--accept-license',
    'P',
  ]);
  assert.strictEqual(bob.streams('pretty'), false);
  assert.strictEqual(bob.streams('stream-json'), true);
  assert.deepStrictEqual(bob.defaults(), {
    format: 'stream-json',
    caps: { maxCost: 0, maxTurns: 0, disableToolGroups: '' },
  });
});

test('Claude buildArgs: the exact flag list at the defaults', () => {
  assert.deepStrictEqual(
    claude.buildArgs({ prompt: 'P', bundleDir: '/b/dir' }),
    [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'dontAsk',
      '--permission-prompts',
      'none',
      '--allowedTools',
      'Read(./**),Glob,Grep,Skill(carbon-builder),mcp__carbon-mcp',
      '--disallowedTools',
      'Bash,Edit,Write,MultiEdit,NotebookEdit,WebFetch,WebSearch,Agent,Read(./claude-config/**),Read(~/**),Read(//proc/**)',
      '--mcp-config',
      '/b/dir/claude-config/claude-mcp.json',
      '--strict-mcp-config',
      '--setting-sources',
      'project',
      '--no-session-persistence',
      '--model',
      'claude-sonnet-5-5',
      '--effort',
      'high',
      '--max-budget-usd',
      '5',
      '--max-turns',
      '60',
      'P',
    ]
  );
  assert.strictEqual(claude.streams('pretty'), true);
});

test('Claude buildArgs: caps override, zero omits, the prompt stays last', () => {
  const args = claude.buildArgs({
    prompt: 'P',
    bundleDir: '/b',
    caps: {
      model: 'm',
      effort: 'low',
      maxBudgetUsd: 0,
      maxTurns: 0,
      allowedTools: 'Read',
      disallowedTools: 'Bash',
    },
  });
  assert.ok(!args.includes('--max-budget-usd'));
  assert.ok(!args.includes('--max-turns'));
  assert.strictEqual(args[args.indexOf('--model') + 1], 'm');
  assert.strictEqual(args[args.indexOf('--effort') + 1], 'low');
  assert.strictEqual(args[args.indexOf('--allowedTools') + 1], 'Read');
  assert.strictEqual(
    args[args.indexOf('--disallowedTools') + 1],
    'Bash,Read(./claude-config/**),Read(~/**),Read(//proc/**)'
  );
  assert.strictEqual(args[args.length - 1], 'P');
});

test('Claude defaults come from constants', () => {
  assert.deepStrictEqual(claude.defaults(), {
    format: 'stream-json',
    caps: {
      model: 'claude-sonnet-5-5',
      effort: 'high',
      maxBudgetUsd: 5,
      maxTurns: 60,
      allowedTools: constants.CLAUDE_ALLOWED_TOOLS,
      disallowedTools: constants.CLAUDE_DISALLOWED_TOOLS,
    },
  });
  assert.strictEqual(constants.CLAUDE_MONTHLY_BUDGET_USD, 0);
});

test('env: Bob sets HOME and keeps its key; Claude isolates its config and drops it', () => {
  const base = {
    PATH: '/bin',
    HOME: '/real',
    BOB_API_KEY: 'b',
    ANTHROPIC_API_KEY: 'a',
  };
  assert.deepStrictEqual(bob.env(base, { home: '/h', bundleDir: '/b' }), {
    ...base,
    HOME: '/h',
  });
  assert.deepStrictEqual(bob.env(base, { bundleDir: '/b' }), base);
  assert.deepStrictEqual(
    claude.env(base, { home: '/b/claude-config', bundleDir: '/b' }),
    {
      PATH: '/bin',
      HOME: '/real',
      ANTHROPIC_API_KEY: 'a',
      CLAUDE_CONFIG_DIR: '/b/claude-config',
      DISABLE_AUTOUPDATER: '1',
    }
  );
  assert.strictEqual(base.BOB_API_KEY, 'b', 'the base is not mutated');
});

test('env: Claude gets an allowlist, none of the harness secrets', () => {
  const base = {
    PATH: '/bin',
    HOME: '/real',
    TMPDIR: '/t',
    LANG: 'C',
    LC_ALL: 'C',
    TERM: 'dumb',
    USER: 'u',
    LOGNAME: 'u',
    SHELL: '/bin/sh',
    HTTP_PROXY: 'h',
    https_proxy: 's',
    no_proxy: 'n',
    SSL_CERT_FILE: '/c',
    NODE_EXTRA_CA_CERTS: '/e',
    ANTHROPIC_API_KEY: 'a',
    ANTHROPIC_BASE_URL: 'u',
    CLAUDE_MODEL: 'm',
    CLAUDE_CONFIG_DIR: '/elsewhere',
    GITHUB_AI_AGENT_TOKEN: 't',
    BOB_API_KEY: 'b',
    ES_PASSWORD: 'p',
    SLACK_WEBHOOK_URL: 'w',
    CONSOLE_PASSWORD: 'c',
    API_SECRET: 's',
    NO_COLOR: '1',
    CI: 'true',
  };
  const env = claude.env(base, { bundleDir: '/b' });
  assert.deepStrictEqual(Object.keys(env).sort(), [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_BASE_URL',
    'CLAUDE_CONFIG_DIR',
    'CLAUDE_MODEL',
    'DISABLE_AUTOUPDATER',
    'HOME',
    'HTTP_PROXY',
    'LANG',
    'LC_ALL',
    'LOGNAME',
    'NODE_EXTRA_CA_CERTS',
    'PATH',
    'SHELL',
    'SSL_CERT_FILE',
    'TERM',
    'TMPDIR',
    'USER',
    'https_proxy',
    'no_proxy',
  ]);
  assert.strictEqual(env.HOME, '/real', 'HOME stays real');
  assert.strictEqual(env.CLAUDE_CONFIG_DIR, '/b/claude-config');
});

test('effectiveConcurrency: only an isolated agent runs side by side', () => {
  assert.strictEqual(agents.effectiveConcurrency({ isolated: false }, 3), 1);
  assert.strictEqual(agents.effectiveConcurrency({ isolated: true }, 3), 3);
  assert.strictEqual(agents.effectiveConcurrency(undefined, 3), 1);
  assert.strictEqual(agents.effectiveConcurrency(agents.find('nope'), 3), 1);
  assert.strictEqual(agents.effectiveConcurrency(claude, 2), 2);
});

test('Claude always denies the bearer paths, whatever the override holds', () => {
  const denied = (disallowedTools) => {
    const args = claude.buildArgs({
      prompt: 'P',
      bundleDir: '/b',
      caps: { disallowedTools },
    });
    return args[args.indexOf('--disallowedTools') + 1];
  };
  const baseline = 'Read(./claude-config/**),Read(~/**),Read(//proc/**)';
  assert.strictEqual(denied('Bash'), `Bash,${baseline}`);
  assert.strictEqual(denied(''), baseline);
  assert.strictEqual(
    denied('Read(~/**),Bash'),
    'Read(~/**),Bash,Read(./claude-config/**),Read(//proc/**)',
    'a rule already listed is not repeated'
  );
  assert.strictEqual(
    denied('Bash(a,b),Edit'),
    `Bash(a,b),Edit,${baseline}`,
    'commas inside a rule do not split it'
  );

  const saved = constants.CLAUDE_DISALLOWED_TOOLS;
  constants.CLAUDE_DISALLOWED_TOOLS = 'Bash';
  try {
    const args = claude.buildArgs({ prompt: 'P', bundleDir: '/b' });
    assert.strictEqual(
      args[args.indexOf('--disallowedTools') + 1],
      `Bash,${baseline}`
    );
  } finally {
    constants.CLAUDE_DISALLOWED_TOOLS = saved;
  }
});

test('Bob parseEvent reproduces the old handling', () => {
  const p = (j) => bob.parseEvent(j);
  assert.deepStrictEqual(
    p({ type: 'message', role: 'assistant', content: 'hi' }),
    { type: 'text', text: 'hi' }
  );
  assert.deepStrictEqual(
    p({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'a' }, 'b'],
    }),
    { type: 'text', text: 'ab' }
  );
  assert.deepStrictEqual(
    p({ type: 'message', role: 'assistant', isReasoning: true, content: 'x' }),
    { type: 'break' }
  );
  assert.deepStrictEqual(p({ type: 'message', role: 'user', content: 'x' }), {
    type: 'break',
  });
  assert.strictEqual(
    p({
      type: 'message',
      role: 'assistant',
      content: '_[Continuing response due to length limit...]_',
    }),
    null
  );
  assert.deepStrictEqual(
    p({ type: 'tool_use', tool_name: 'read_file', tool_id: 't1' }),
    { type: 'tool_use', id: 't1', name: 'read_file', params: {} }
  );
  assert.deepStrictEqual(
    p({ type: 'tool_result', tool_id: 't1', status: 'success' }),
    { type: 'tool_result', id: 't1', status: 'success' }
  );
  assert.strictEqual(p({ type: 'init' }), null);
  assert.strictEqual(p({ type: 'something-else' }), null);
});

test('Bob parseEvent: limits come from error events, gated on severity', () => {
  const err = (message, severity) =>
    bob.parseEvent({ type: 'error', message, severity }).limit;
  assert.strictEqual(err('Cost limit reached: 1.00', 'error'), 'cost-limit');
  assert.strictEqual(err('stopped by --max-cost', undefined), 'cost-limit');
  assert.strictEqual(err('Turn limit reached', 'error'), 'turn-limit');
  assert.strictEqual(err('--max-turns hit'), 'turn-limit');
  assert.strictEqual(err('Cost limit nearly reached', 'warning'), null);
  assert.strictEqual(err('Something else broke', 'error'), null);
});

test('Bob parseEvent: result keeps the stats object and flattens last_message', () => {
  const r = bob.parseEvent({
    type: 'result',
    status: 'success',
    stats: { session_costs: { a: 1 }, task_id: 'x' },
    last_message: [{ type: 'text', text: 'done' }],
  });
  assert.strictEqual(r.status, 'success');
  assert.deepStrictEqual(r.stats, { session_costs: { a: 1 }, task_id: 'x' });
  assert.strictEqual(r.lastMessage, 'done');
  assert.strictEqual(
    bob.parseEvent({ type: 'result', stats: 'nope' }).stats,
    null
  );
  assert.strictEqual(bob.parseEvent({ type: 'result' }).lastMessage, null);
  assert.strictEqual(bob.parseEvent({ type: 'result' }).status, null);
});

test('Bob finalizeText strips the notice and appends the last completion', () => {
  const calls = [
    { name: 'attempt_completion', params: { result: 'first' } },
    { name: 'attempt_completion', params: { result: 'second' } },
    { name: 'attempt_completion', params: {} },
  ];
  assert.strictEqual(
    bob.finalizeText(
      'a\n_[Continuing response due to length limit...]_\nb',
      []
    ),
    'ab'
  );
  assert.strictEqual(
    bob.finalizeText('text', calls),
    'text\n\n[attempt_completion] Result: second'
  );
  assert.strictEqual(
    bob.finalizeText('', calls),
    '[attempt_completion] Result: second'
  );
  assert.strictEqual(bob.plainText('x'), 'x');
  assert.strictEqual(
    bob.plainText('## Step 1\nold\n## Step 1\nfinal'),
    '## Step 1\nfinal'
  );
});

const asst = (id, ...content) => ({
  type: 'assistant',
  message: { id, content },
  parent_tool_use_id: null,
});

test('Claude parseEvent: init carries model, MCP status and skills', () => {
  assert.deepStrictEqual(
    claude.parseEvent({
      type: 'system',
      subtype: 'init',
      model: 'claude-sonnet-5-5',
      mcp_servers: [{ name: 'carbon-mcp', status: 'connected', extra: 1 }],
      skills: ['carbon-builder', { name: 'other' }],
    }),
    {
      type: 'init',
      model: 'claude-sonnet-5-5',
      mcpServers: [{ name: 'carbon-mcp', status: 'connected' }],
      skills: ['carbon-builder', 'other'],
    }
  );
  assert.deepStrictEqual(
    claude.parseEvent({ type: 'system', subtype: 'init' }).mcpServers,
    []
  );
});

test('Claude parseEvent: one event per content block, text keyed by message id', () => {
  const events = claude.parseEvent(
    asst(
      'msg_1',
      { type: 'thinking', thinking: 'hmm' },
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
      {
        type: 'tool_use',
        id: 'tu1',
        name: 'mcp__carbon-mcp__docs_search',
        input: { query: 'q' },
      },
      { type: 'tool_use', id: 'tu2', name: 'Read', input: { file_path: 'f' } }
    )
  );
  assert.deepStrictEqual(events, [
    { type: 'text', text: 'a', messageId: 'msg_1' },
    { type: 'text', text: 'b', messageId: 'msg_1' },
    {
      type: 'tool_use',
      id: 'tu1',
      name: 'mcp__carbon-mcp__docs_search',
      params: { query: 'q' },
      server: 'carbon-mcp',
      tool: 'docs_search',
    },
    { type: 'tool_use', id: 'tu2', name: 'Read', params: { file_path: 'f' } },
  ]);
  assert.strictEqual(
    claude.parseEvent(asst('m', { type: 'thinking', thinking: 'x' })),
    null
  );
  const sub = asst('m2', { type: 'text', text: 'agent chatter' });
  sub.parent_tool_use_id = 'toolu_parent';
  assert.strictEqual(claude.parseEvent(sub), null);
});

test('Claude parseEvent: tool_result blocks pair by id with a status', () => {
  const user = (...content) => ({ type: 'user', message: { content } });
  assert.deepStrictEqual(
    claude.parseEvent(
      user(
        { type: 'tool_result', tool_use_id: 'a', content: 'ok' },
        {
          type: 'tool_result',
          tool_use_id: 'b',
          is_error: true,
          content: 'no',
        },
        { type: 'text', text: 'ignored' }
      )
    ),
    [
      { type: 'tool_result', id: 'a', status: 'success' },
      { type: 'tool_result', id: 'b', status: 'error' },
    ]
  );
  assert.strictEqual(
    claude.parseEvent(user({ type: 'text', text: 'x' })),
    null
  );
  assert.strictEqual(claude.parseEvent({ type: 'user', message: {} }), null);
});

test('Claude parseEvent: ignored event types return null', () => {
  for (const j of [
    { type: 'stream_event', event: {} },
    { type: 'rate_limit_event' },
    { type: 'system', subtype: 'api_retry' },
    { type: 'system', subtype: 'permission_denied' },
    { type: 'unknown' },
  ]) {
    assert.strictEqual(claude.parseEvent(j), null, JSON.stringify(j));
  }
});

const result = (extra = {}) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 1234,
  num_turns: 3,
  result: 'final text',
  session_id: 'sess-1',
  total_cost_usd: 0.25,
  usage: {
    input_tokens: 100,
    output_tokens: 40,
    cache_read_input_tokens: 700,
    cache_creation_input_tokens: 50,
  },
  permission_denials: [],
  ...extra,
});

test('Claude parseEvent: result maps to the stats shape, counting tool calls', () => {
  const state = {};
  claude.parseEvent(
    asst(
      'm',
      { type: 'tool_use', id: 'a', name: 'Read', input: {} },
      { type: 'tool_use', id: 'b', name: 'Skill', input: {} }
    ),
    state
  );
  claude.parseEvent(
    asst('m2', { type: 'tool_use', id: 'c', name: 'Grep', input: {} }),
    state
  );
  const r = claude.parseEvent(result(), state);
  assert.deepStrictEqual(r, {
    type: 'result',
    status: 'success',
    stats: {
      task_id: 'sess-1',
      session_costs: 0.25,
      input_tokens: 850,
      output_tokens: 40,
      cache_read_tokens: 700,
      cache_write_tokens: 50,
      total_tokens: 890,
      duration_ms: 1234,
      tool_calls: 3,
      cost_unit: 'usd',
    },
    lastMessage: 'final text',
    limit: null,
    denials: [],
  });
});

test('Claude parseEvent: a result with no usage or cost keeps only what exists', () => {
  const r = claude.parseEvent(
    { type: 'result', subtype: 'success', session_id: 's' },
    {}
  );
  assert.deepStrictEqual(r.stats, {
    task_id: 's',
    tool_calls: 0,
    cost_unit: 'usd',
  });
  assert.strictEqual(r.lastMessage, null);
});

test('Claude parseEvent: result subtypes map to limit kinds and status', () => {
  const kind = (subtype, is_error = true) => {
    const r = claude.parseEvent(result({ subtype, is_error }), {});
    return [r.status, r.limit];
  };
  assert.deepStrictEqual(kind('error_max_budget_usd'), ['error', 'cost-limit']);
  assert.deepStrictEqual(kind('error_max_turns'), ['error', 'turn-limit']);
  assert.deepStrictEqual(kind('error_during_execution'), ['error', null]);
  assert.deepStrictEqual(kind('success', false), ['success', null]);
  assert.deepStrictEqual(kind('success', true), ['error', null]);
});

test('Claude parseEvent: permission denials list the tool names', () => {
  const r = claude.parseEvent(
    result({
      permission_denials: [
        { tool_name: 'Bash', tool_use_id: 'x', tool_input: { command: 'ls' } },
        {},
      ],
    }),
    {}
  );
  assert.deepStrictEqual(r.denials, ['Bash', 'unknown']);
});

test('evidence: Bob keeps its sentinel inputs', () => {
  const e = bob.evidence([
    { name: 'use_skill', params: { skill_name: 'carbon-builder' } },
    {
      name: 'read_file',
      params: { path: '/w/.bob/skills/carbon-builder/a.md' },
    },
    { name: 'read_file', params: { path: '/w/src/a.js' } },
    {
      name: 'use_mcp_tool',
      params: { server_name: 'carbon-mcp', tool_name: 'docs_search' },
    },
  ]);
  assert.strictEqual(e.skillInvoked, true);
  assert.deepStrictEqual(e.skillFiles, ['/w/.bob/skills/carbon-builder/a.md']);
  assert.deepStrictEqual(e.mcpCalls, { docs_search: 1 });
  assert.strictEqual(e.total, 4);
  assert.strictEqual(bob.skill.sentinel, 'use_skill:carbon-builder');
  assert.strictEqual(claude.skill.sentinel, 'Skill:carbon-builder');
});

test('evidence: Claude counts a Skill call, a Read under .claude/skills and mcp__ tools', () => {
  const e = claude.evidence([
    { name: 'Skill', params: { skill: 'carbon-builder' } },
    {
      name: 'Read',
      params: { file_path: './.claude/skills/carbon-builder/SKILL.md' },
    },
    {
      name: 'Read',
      params: { file_path: '/w/.bob/skills/carbon-builder/a.md' },
    },
    { name: 'Read', params: { file_path: 'PR_REVIEW_REQUEST.md' } },
    { name: 'mcp__carbon-mcp__docs_search', params: {} },
    { name: 'mcp__carbon-mcp__code_audit', params: {} },
    { name: 'mcp__carbon-mcp__docs_search', params: {} },
    { name: 'mcp__other__docs_lookup', params: {} },
  ]);
  assert.strictEqual(e.skillInvoked, true);
  assert.deepStrictEqual(e.skillFiles, [
    './.claude/skills/carbon-builder/SKILL.md',
  ]);
  assert.deepStrictEqual(e.mcpCalls, { docs_search: 2, code_audit: 1 });
  assert.strictEqual(e.total, 8);

  const other = claude.evidence([
    { name: 'Skill', params: { skill: 'other' } },
  ]);
  assert.strictEqual(other.skillInvoked, false);
  assert.deepStrictEqual(claude.evidence(), {
    skillInvoked: false,
    skillFiles: [],
    mcpCalls: {},
    total: 0,
  });
});

test('prompt fragments: Bob equals the current prompt text, Claude differs', () => {
  const { buildReviewPrompt } = require('../src/reviewPrompt');
  const prompt = buildReviewPrompt({ owner: 'o', repo: 'r' });
  for (const text of Object.values(bob.promptFragments)) {
    assert.ok(prompt.includes(text), text);
  }
  for (const k of Object.keys(bob.promptFragments)) {
    assert.notStrictEqual(claude.promptFragments[k], bob.promptFragments[k]);
  }
  assert.ok(
    !/\.bob|read_file|attempt_completion|write_file/.test(
      Object.values(claude.promptFragments).join('\n')
    )
  );
});

test('credits: Bob reports through bobCredits; the skip fires only on a confirmed low', async () => {
  const bobCredits = require('../src/api/bobCredits');
  const real = bobCredits.getBalance;
  let calls = 0;
  try {
    bobCredits.getBalance = async (opts) => {
      calls++;
      assert.strictEqual(opts, undefined, 'the cached read, not a forced one');
      return { available: true, remaining: 4, percentRemaining: 4 };
    };
    const low = await bob.credits();
    assert.strictEqual(calls, 1);
    assert.deepStrictEqual(
      [low.available, low.low, low.threshold, low.percentRemaining],
      [true, true, 10, 4]
    );
    assert.strictEqual(low.summary, 'Bobcoins at 4% (below 10% threshold)');

    bobCredits.getBalance = async () => ({
      available: false,
      reason: 'no-key',
    });
    const down = await bob.credits();
    assert.deepStrictEqual(
      [down.available, down.low, down.reason],
      [false, false, 'no-key']
    );
  } finally {
    bobCredits.getBalance = real;
  }
});

test('credits: Claude is not metered by default and meters month-to-date when budgeted', async () => {
  assert.deepStrictEqual(await claude.credits(), {
    available: false,
    low: false,
    reason: 'not-metered',
  });

  const ledger = path.join(tmp(), 'ledger.jsonl');
  const now = new Date();
  const lastMonth = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15)
  ).toISOString();
  const entry = (at, coinsSpent, source) =>
    JSON.stringify({ at, coinsSpent, source });
  fs.writeFileSync(
    ledger,
    [
      entry(now.toISOString(), 4, 'claude-result'),
      entry(now.toISOString(), 5.5, 'claude-result'),
      entry(now.toISOString(), 50, 'bob-result'),
      entry(lastMonth, 100, 'claude-result'),
      'not json',
    ].join('\n') + '\n'
  );
  const saved = process.env.CREDIT_LEDGER_PATH;
  process.env.CREDIT_LEDGER_PATH = ledger;
  constants.CLAUDE_MONTHLY_BUDGET_USD = 10;
  try {
    const low = await claude.credits();
    assert.deepStrictEqual(
      [low.available, low.spent, low.remaining, low.percentRemaining, low.low],
      [true, 9.5, 0.5, 5, true]
    );
    assert.strictEqual(
      low.summary,
      'Claude budget at 5% (below 10% threshold)'
    );

    constants.CLAUDE_MONTHLY_BUDGET_USD = 20;
    const fine = await claude.credits();
    assert.deepStrictEqual([fine.percentRemaining, fine.low], [52.5, false]);

    constants.CLAUDE_MONTHLY_BUDGET_USD = 5;
    const over = await claude.credits();
    assert.deepStrictEqual([over.percentRemaining, over.low], [0, true]);
  } finally {
    constants.CLAUDE_MONTHLY_BUDGET_USD = 0;
    if (saved === undefined) delete process.env.CREDIT_LEDGER_PATH;
    else process.env.CREDIT_LEDGER_PATH = saved;
  }
});

test('getCredentials reads the carbon-mcp entry of the current mcp.json', async () => {
  const mcp = require('../src/api/mcpConnection');
  const home = tmp();
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  try {
    assert.strictEqual(await mcp.getCredentials(), null, 'no file');
    const file = mcp.getBobMcpConfigPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const write = (cfg) => fs.writeFileSync(file, JSON.stringify(cfg));

    write({ mcpServers: { 'carbon-mcp': { url: 'u', headers: {} } } });
    assert.strictEqual(await mcp.getCredentials(), null, 'no token');
    write({ mcpServers: {} });
    assert.strictEqual(await mcp.getCredentials(), null, 'no entry');
    fs.writeFileSync(file, '{broken');
    assert.strictEqual(await mcp.getCredentials(), null, 'unreadable');

    write({
      mcpServers: {
        'carbon-mcp': {
          url: 'https://mcp.example/mcp',
          headers: {
            Authorization: 'Bearer t',
            'X-MCP-Session': 's',
            Other: 'dropped',
          },
        },
      },
    });
    assert.deepStrictEqual(await mcp.getCredentials(), {
      url: 'https://mcp.example/mcp',
      headers: { Authorization: 'Bearer t', 'X-MCP-Session': 's' },
    });

    write({
      mcpServers: { 'carbon-mcp': { headers: { authorization: 'Bearer t' } } },
    });
    assert.deepStrictEqual(await mcp.getCredentials(), {
      url: mcp.MCP_URL,
      headers: { Authorization: 'Bearer t' },
    });
  } finally {
    process.env.HOME = savedHome;
  }
});

test('Claude seedHome writes the MCP file 0600 and refresh picks up a new bearer', async () => {
  const mcp = require('../src/api/mcpConnection');
  const home = tmp();
  const bundle = path.join(tmp(), 'bundle');
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const file = mcp.getBobMcpConfigPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const setBearer = (t) =>
      fs.writeFileSync(
        file,
        JSON.stringify({
          mcpServers: {
            'carbon-mcp': {
              url: 'https://mcp.example/mcp',
              headers: { Authorization: `Bearer ${t}`, 'X-MCP-Session': 's' },
            },
          },
        })
      );
    setBearer('old');
    const seeded = await claude.seedHome(bundle, await mcp.getCredentials());
    const target = path.join(bundle, 'claude-config', 'claude-mcp.json');
    assert.strictEqual(seeded.home, path.join(bundle, 'claude-config'));
    assert.strictEqual(fs.statSync(target).mode & 0o777, 0o600);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(target, 'utf8')), {
      mcpServers: {
        'carbon-mcp': {
          type: 'http',
          url: 'https://mcp.example/mcp',
          headers: { Authorization: 'Bearer old', 'X-MCP-Session': 's' },
        },
      },
    });

    setBearer('new');
    await seeded.refresh();
    assert.strictEqual(
      JSON.parse(fs.readFileSync(target, 'utf8')).mcpServers['carbon-mcp']
        .headers.Authorization,
      'Bearer new'
    );
    assert.strictEqual(fs.statSync(target).mode & 0o777, 0o600);

    fs.rmSync(file);
    await seeded.refresh();
    assert.strictEqual(
      JSON.parse(fs.readFileSync(target, 'utf8')).mcpServers['carbon-mcp']
        .headers.Authorization,
      'Bearer new',
      'a missing bearer leaves the file alone'
    );
  } finally {
    process.env.HOME = savedHome;
  }
});

test('Claude seedHome without credentials writes an empty server list and warns', async () => {
  const bundle = path.join(tmp(), 'bundle');
  const warn = console.warn;
  const lines = [];
  console.warn = (...a) => lines.push(a.join(' '));
  try {
    await claude.seedHome(bundle, null);
  } finally {
    console.warn = warn;
  }
  assert.deepStrictEqual(
    JSON.parse(
      fs.readFileSync(path.join(bundle, 'claude-config', 'claude-mcp.json'))
    ),
    { mcpServers: {} }
  );
  assert.ok(lines.some((l) => /No Carbon MCP credentials/.test(l)));
});

test('prepareBundle: Bob keeps .env and .bob; Claude gets CLAUDE.md and .claude/skills, no .env', async () => {
  const skillSource = path.join(tmp(), 'skill');
  fs.mkdirSync(path.join(skillSource, 'refs'), { recursive: true });
  fs.writeFileSync(path.join(skillSource, 'SKILL.md'), '# skill');
  fs.writeFileSync(path.join(skillSource, 'refs', 'a.md'), 'a');
  const rules = '# rules\n';
  const saved = process.env.BOB_API_KEY;
  process.env.BOB_API_KEY = 'bob-test-key';
  try {
    const b = tmp();
    await bob.prepareBundle(b, { rules, skillSource });
    assert.strictEqual(
      fs.readFileSync(path.join(b, '.env'), 'utf8'),
      'BOB_API_KEY=bob-test-key\n'
    );
    assert.strictEqual(fs.statSync(path.join(b, '.env')).mode & 0o777, 0o600);
    assert.strictEqual(
      fs.readFileSync(path.join(b, '.bob/rules/01-output.md'), 'utf8'),
      rules
    );
    assert.strictEqual(
      fs.readFileSync(
        path.join(b, '.bob/skills/carbon-builder/refs/a.md'),
        'utf8'
      ),
      'a'
    );
    assert.ok(!fs.existsSync(path.join(b, 'CLAUDE.md')));

    const c = tmp();
    await claude.prepareBundle(c, { rules, skillSource });
    assert.strictEqual(
      fs.readFileSync(path.join(c, 'CLAUDE.md'), 'utf8'),
      rules
    );
    assert.strictEqual(
      fs.readFileSync(
        path.join(c, '.claude/skills/carbon-builder/SKILL.md'),
        'utf8'
      ),
      '# skill'
    );
    assert.deepStrictEqual(
      JSON.parse(
        fs.readFileSync(path.join(c, '.claude/settings.json'), 'utf8')
      ),
      { permissions: { blockReadsOutsideWorkingDirectories: true } }
    );
    assert.ok(!fs.existsSync(path.join(c, '.env')));
    assert.ok(!fs.existsSync(path.join(c, '.bob')));
  } finally {
    if (saved === undefined) delete process.env.BOB_API_KEY;
    else process.env.BOB_API_KEY = saved;
  }
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
