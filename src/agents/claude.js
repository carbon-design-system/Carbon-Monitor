'use strict';

const fs = require('fs').promises;
const path = require('path');
const constants = require('../constants');
const { CARBON_MCP_SERVER, summarize } = require('./common');

const SKILL_DIR = '.claude/skills/carbon-builder/';
const CONFIG_DIR = 'claude-config';
const MCP_FILE = 'claude-mcp.json';

// The bundle code is loaded lazily: reviewBundle requires this registry.
const bundle = () => require('../reviewBundle');

// Always denied, whatever CLAUDE_DISALLOWED_TOOLS holds: the MCP bearer in the
// bundle, the same bearer in ~/.bob, and the process environment.
const BASELINE_DENIES = [
  'Read(./claude-config/**)',
  'Read(~/**)',
  'Read(//proc/**)',
];

// The child gets only these, never the harness's own secrets.
const ENV_ALLOW = new Set(
  [
    'PATH',
    'HOME',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'TERM',
    'USER',
    'LOGNAME',
    'SHELL',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'SSL_CERT_FILE',
    'NODE_EXTRA_CA_CERTS',
  ].flatMap((k) => [k, k.toLowerCase()])
);

// Split on commas outside parentheses, so a rule such as Bash(a,b) stays whole.
function splitRules(list) {
  const rules = [];
  let depth = 0;
  let cur = '';
  for (const ch of String(list)) {
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      rules.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  rules.push(cur);
  return rules.map((r) => r.trim()).filter(Boolean);
}

const num = (v) =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

function mcpConfig(creds) {
  if (!creds) return { mcpServers: {} };
  return {
    mcpServers: {
      [CARBON_MCP_SERVER]: {
        type: 'http',
        url: creds.url,
        headers: creds.headers,
      },
    },
  };
}

function statsFromResult(json, state) {
  const usage = json.usage || {};
  // usage.input_tokens excludes cached context; input here is all the model consumed.
  const fresh = num(usage.input_tokens);
  const input =
    fresh === undefined
      ? undefined
      : fresh +
        (num(usage.cache_creation_input_tokens) || 0) +
        (num(usage.cache_read_input_tokens) || 0);
  const output = num(usage.output_tokens);
  const stats = {
    task_id: json.session_id,
    session_costs: num(json.total_cost_usd),
    input_tokens: input,
    output_tokens: output,
    cache_read_tokens: num(usage.cache_read_input_tokens),
    cache_write_tokens: num(usage.cache_creation_input_tokens),
    total_tokens:
      input !== undefined && output !== undefined ? input + output : undefined,
    duration_ms: num(json.duration_ms),
    tool_calls: state.toolCalls || 0,
    cost_unit: 'usd',
  };
  for (const k of Object.keys(stats)) {
    if (stats[k] === undefined) delete stats[k];
  }
  return stats;
}

function defaults() {
  return {
    format: 'stream-json',
    caps: {
      model: constants.CLAUDE_MODEL,
      effort: constants.CLAUDE_EFFORT,
      maxBudgetUsd: constants.CLAUDE_MAX_BUDGET_USD,
      maxTurns: constants.CLAUDE_MAX_TURNS,
      allowedTools: constants.CLAUDE_ALLOWED_TOOLS,
      disallowedTools: constants.CLAUDE_DISALLOWED_TOOLS,
    },
  };
}

module.exports = {
  id: 'claude',
  displayName: 'Claude',
  cliName: 'Claude Code CLI',
  binary: 'claude',
  requiredEnv: 'ANTHROPIC_API_KEY',
  costUnit: 'usd',
  creditLabel: 'Claude budget',
  resultSource: 'claude-result',
  isolated: true,
  skill: {
    tool: 'Skill',
    dir: SKILL_DIR,
    sentinel: 'Skill:carbon-builder',
    pattern:
      /\bSkill\b[\s\S]{0,300}carbon-builder|\.claude\/skills\/carbon-builder\//,
  },

  defaults,

  streams() {
    return true;
  },

  // --allowedTools and --mcp-config are variadic, so each is followed by another
  // flag and the prompt comes after a single-valued one.
  buildArgs({ prompt, caps = {}, bundleDir = '.' }) {
    const c = { ...defaults().caps, ...caps };
    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'dontAsk',
      '--permission-prompts',
      'none',
      '--allowedTools',
      c.allowedTools,
      '--disallowedTools',
      [...new Set([...splitRules(c.disallowedTools), ...BASELINE_DENIES])].join(
        ','
      ),
      '--mcp-config',
      path.join(bundleDir, CONFIG_DIR, MCP_FILE),
      '--strict-mcp-config',
      '--setting-sources',
      'project',
      '--no-session-persistence',
      '--model',
      c.model,
      '--effort',
      c.effort,
    ];
    if (c.maxBudgetUsd > 0) {
      args.push('--max-budget-usd', String(c.maxBudgetUsd));
    }
    if (c.maxTurns > 0) args.push('--max-turns', String(c.maxTurns));
    args.push(prompt);
    return args;
  },

  // HOME stays real; CLAUDE_CONFIG_DIR is the isolation.
  env(base, { bundleDir = '.' } = {}) {
    const env = {};
    for (const [k, v] of Object.entries(base)) {
      if (
        ENV_ALLOW.has(k) ||
        k.startsWith('ANTHROPIC_') ||
        k.startsWith('CLAUDE_')
      ) {
        env[k] = v;
      }
    }
    env.CLAUDE_CONFIG_DIR = path.join(bundleDir, CONFIG_DIR);
    env.DISABLE_AUTOUPDATER = '1';
    return env;
  },

  async prepareBundle(bundleDir, { rules, skillSource, extraSkills = [] }) {
    if (extraSkills.length > 0) {
      throw new Error(
        'The Claude adapter does not support extra skills (extraSkills). ' +
          'Use GITHUB_AI_AGENT_CLI=bob with REVIEW_PROFILE=caic.'
      );
    }
    await fs.writeFile(path.join(bundleDir, 'CLAUDE.md'), rules);
    // Loaded through --setting-sources project: file tools refuse paths outside the bundle.
    await fs.mkdir(path.join(bundleDir, '.claude'), { recursive: true });
    await fs.writeFile(
      path.join(bundleDir, '.claude', 'settings.json'),
      JSON.stringify(
        { permissions: { blockReadsOutsideWorkingDirectories: true } },
        null,
        2
      )
    );
    await bundle().copySkill(
      skillSource,
      path.join(bundleDir, '.claude', 'skills', 'carbon-builder')
    );
  },

  // The file holds the MCP bearer, so it is 0600 under a directory the agent is
  // denied to Read (see CLAUDE_DISALLOWED_TOOLS).
  async seedHome(bundleDir, creds) {
    const home = path.join(bundleDir, CONFIG_DIR);
    const file = path.join(home, MCP_FILE);
    const write = async (c) => {
      await fs.writeFile(file, JSON.stringify(mcpConfig(c), null, 2), {
        mode: 0o600,
      });
      await fs.chmod(file, 0o600);
    };
    await fs.mkdir(home, { recursive: true, mode: 0o700 });
    if (!creds) {
      console.warn(
        '⚠️  No Carbon MCP credentials found; the Claude review runs without Carbon MCP'
      );
    }
    await write(creds || null);
    return {
      home,
      // A bearer refreshed since seeding is picked up; a missing one leaves the file alone.
      refresh: async () => {
        const fresh = await require('../api/mcpConnection').getCredentials();
        if (fresh) await write(fresh);
      },
    };
  },

  promptFragments: {
    noCompletion: 'Do not call any task-completion tool',
    noFileWrite: 'Do not use Write, Edit, or any file-writing tool',
    skillPath: SKILL_DIR,
    readTool: 'Read',
  },

  // Returns an event, an array of events (one per content block), or null.
  // `state` is per run: it counts tool calls for the result's stats.
  parseEvent(json, state = {}) {
    switch (json.type) {
      case 'system': {
        if (json.subtype !== 'init') return null;
        const name = (s) => (typeof s === 'string' ? s : s && s.name);
        return {
          type: 'init',
          model: json.model || null,
          mcpServers: (json.mcp_servers || []).map((s) => ({
            name: s.name,
            status: s.status,
          })),
          skills: (json.skills || []).map(name).filter(Boolean),
        };
      }
      case 'assistant': {
        const message = json.message || {};
        const events = [];
        for (const block of Array.isArray(message.content)
          ? message.content
          : []) {
          if (!block) continue;
          if (block.type === 'text' && typeof block.text === 'string') {
            // Subagent chatter is not part of the review.
            if (json.parent_tool_use_id) continue;
            events.push({
              type: 'text',
              text: block.text,
              messageId: message.id ?? null,
            });
          } else if (block.type === 'tool_use') {
            state.toolCalls = (state.toolCalls || 0) + 1;
            const mcp = /^mcp__(.+?)__(.+)$/.exec(block.name || '');
            events.push({
              type: 'tool_use',
              id: block.id,
              name: block.name,
              params: block.input || {},
              ...(mcp ? { server: mcp[1], tool: mcp[2] } : {}),
            });
          }
        }
        return events.length ? events : null;
      }
      case 'user': {
        const content = json.message && json.message.content;
        const events = (Array.isArray(content) ? content : [])
          .filter((b) => b && b.type === 'tool_result')
          .map((b) => ({
            type: 'tool_result',
            id: b.tool_use_id,
            status: b.is_error ? 'error' : 'success',
          }));
        return events.length ? events : null;
      }
      case 'result': {
        const ok = json.subtype === 'success' && !json.is_error;
        return {
          type: 'result',
          status: ok ? 'success' : 'error',
          stats: statsFromResult(json, state),
          lastMessage: typeof json.result === 'string' ? json.result : null,
          limit:
            json.subtype === 'error_max_budget_usd'
              ? 'cost-limit'
              : json.subtype === 'error_max_turns'
                ? 'turn-limit'
                : null,
          denials: Array.isArray(json.permission_denials)
            ? json.permission_denials.map(
                (d) => (d && d.tool_name) || 'unknown'
              )
            : [],
        };
      }
      default:
        return null;
    }
  },

  evidence(toolCalls) {
    return summarize(toolCalls, (call) => {
      const params = call.params || {};
      if (call.name === 'Skill' && params.skill === 'carbon-builder') {
        return { skill: true };
      }
      if (call.name === 'Read') {
        const p = params.file_path;
        if (typeof p === 'string' && p.includes(SKILL_DIR)) return { file: p };
      }
      return null;
    });
  },

  // Unmetered unless CLAUDE_MONTHLY_BUDGET_USD is set; then month-to-date USD
  // comes from Elasticsearch, with the ledger as the fallback.
  async credits() {
    const budget = constants.CLAUDE_MONTHLY_BUDGET_USD;
    if (!(budget > 0)) {
      return { available: false, low: false, reason: 'not-metered' };
    }
    try {
      const { spent } = await require('../api/spend').monthToDate(
        module.exports
      );
      const remaining = Math.round((budget - spent) * 1e6) / 1e6;
      const percentRemaining =
        Math.round(
          Math.min(100, Math.max(0, (remaining / budget) * 100)) * 100
        ) / 100;
      const threshold = constants.CLAUDE_BUDGET_LOW_PCT;
      return {
        available: true,
        low: percentRemaining < threshold,
        threshold,
        remaining,
        percentRemaining,
        reason: null,
        summary: `Claude budget at ${percentRemaining}% (below ${threshold}% threshold)`,
        spent,
        budget,
      };
    } catch (error) {
      return { available: false, low: false, reason: error.message };
    }
  },
};
