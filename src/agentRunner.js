const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const constants = require('./constants');

const KILL_GRACE_MS = 10 * 1000;
const CONTINUATION_NOTICE =
  /^\s*_\[Continuing response due to length limit\.\.\.\]_\s*$/;
const CARBON_MCP_TOOLS = [
  'docs_search',
  'code_search',
  'get_charts',
  'labs_search',
  'code_audit',
];

class AgentRunError extends Error {
  constructor(message, { kind, stats = null, stderr = '' } = {}) {
    super(message);
    this.name = 'AgentRunError';
    this.kind = kind;
    this.stats = stats;
    this.stderr = stderr;
  }
}

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) =>
      typeof b === 'string' ? b : b && b.type === 'text' ? b.text : ''
    )
    .filter(Boolean)
    .join('');
}

// Bob 2.0.5 rejects a cap of 0, so an unset or zero cap omits its flag. Caps do
// not depend on --format, so the pretty kill switch keeps a spend cap.
function buildAgentArgs({ agent, prompt, format, caps = {} }) {
  switch (agent) {
    case 'bob': {
      const args = ['run'];
      if (format !== 'pretty') args.push('--format', 'stream-json');
      args.push('--trust', '--accept-license');
      // --team-id breaks Inference keys, so only send it when configured.
      if (process.env.BOB_TEAM_ID) {
        args.push('--team-id', process.env.BOB_TEAM_ID);
      }
      if (caps.maxCost > 0) args.push('--max-cost', String(caps.maxCost));
      if (caps.maxTurns > 0) args.push('--max-turns', String(caps.maxTurns));
      if (caps.disableToolGroups) {
        args.push('--disable-tool-groups', caps.disableToolGroups);
      }
      args.push(prompt);
      return args;
    }
    case 'claude':
      return [
        '-p',
        '--dangerously-skip-permissions',
        '--output-format',
        'stream-json',
        '--verbose',
        prompt,
      ];
    case 'codex':
      return ['exec', '--full-auto', prompt];
    default:
      throw new Error(`Invalid agent type: ${agent}`);
  }
}

function normaliseCost(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '' && !isNaN(value)) {
    return Number(value);
  }
  if (value && typeof value === 'object') {
    return Object.values(value).reduce(
      (sum, v) => sum + (typeof v === 'number' ? v : Number(v) || 0),
      0
    );
  }
  return value;
}

// Carbon MCP tool name for a use_mcp_tool call (or a bare MCP tool call), else null.
function mcpToolName(call) {
  const params = call.params || {};
  const candidate =
    call.name === 'use_mcp_tool' ? params.tool_name || params.name : call.name;
  if (typeof candidate !== 'string') return null;
  return (
    CARBON_MCP_TOOLS.find(
      (t) =>
        candidate === t ||
        candidate.endsWith(`__${t}`) ||
        candidate.endsWith(`/${t}`)
    ) || null
  );
}

function summarizeToolCalls(toolCalls = []) {
  const summary = {
    skillInvoked: false,
    skillFiles: [],
    mcpCalls: {},
    total: toolCalls.length,
  };
  for (const call of toolCalls) {
    const params = call.params || {};
    if (call.name === 'use_skill' && params.skill_name === 'carbon-builder') {
      summary.skillInvoked = true;
    } else if (call.name === 'read_file') {
      const p = params.path || params.file_path;
      if (
        typeof p === 'string' &&
        p.includes('.bob/skills/carbon-builder/') &&
        !summary.skillFiles.includes(p)
      ) {
        summary.skillFiles.push(p);
      }
    }
    const mcp = mcpToolName(call);
    if (mcp) summary.mcpCalls[mcp] = (summary.mcpCalls[mcp] || 0) + 1;
  }
  return summary;
}

// Folds Bob's stream-json NDJSON into the run's text, tool calls and stats.
// A chunk can end mid-line, so the tail is carried into the next push().
function createStreamCollector({ onProgress } = {}) {
  let carry = '';
  const messages = [];
  let completion = null;
  const calls = [];
  const callsById = new Map();
  const errors = [];
  let result = null;
  let lastWasAssistant = false;

  function handle(event) {
    switch (event.type) {
      case 'message': {
        if (event.role === 'assistant' && event.isReasoning !== true) {
          const text = contentToText(event.content);
          // Bob inserts this notice as its own piece when a long answer continues;
          // it is not model output and lands inside the review JSON if kept.
          if (CONTINUATION_NOTICE.test(text)) break;
          if (text) {
            // Bob streams assistant text as many small message events with no
            // delta flag (seen live on 2.0.0), so consecutive assistant pieces
            // are one message until a tool call, error or other role intervenes.
            // Known limit: two whole back-to-back messages would also be glued.
            if (lastWasAssistant && messages.length) {
              messages[messages.length - 1] += text;
            } else {
              messages.push(text);
            }
          }
          lastWasAssistant = true;
        } else {
          lastWasAssistant = false;
        }
        break;
      }
      case 'tool_use': {
        const call = {
          name: event.tool_name,
          params: event.parameters || {},
          status: 'unknown',
        };
        calls.push(call);
        if (event.tool_id) callsById.set(event.tool_id, call);
        if (call.name === 'attempt_completion' && call.params.result != null) {
          completion = String(call.params.result);
        }
        if (onProgress) onProgress(`⚙ ${mcpToolName(call) || call.name}`);
        // Text after a tool call starts a new message even when streamed as a delta.
        lastWasAssistant = false;
        break;
      }
      case 'tool_result': {
        const call = callsById.get(event.tool_id);
        if (call && event.status) call.status = event.status;
        lastWasAssistant = false;
        break;
      }
      case 'error':
        errors.push(event);
        if (onProgress) onProgress(`⚠ ${event.message}`);
        lastWasAssistant = false;
        break;
      case 'result':
        result = event;
        break;
    }
  }

  function line(raw) {
    if (!raw.trim()) return;
    const trimmed = raw.trim();
    if (trimmed.startsWith('{')) {
      try {
        const event = JSON.parse(trimmed);
        if (event && typeof event.type === 'string') return handle(event);
      } catch (_) {
        // fall through: kept as raw in the events file only
      }
    }
  }

  return {
    push(chunk) {
      carry += chunk;
      const lines = carry.split('\n');
      carry = lines.pop();
      lines.forEach(line);
    },
    end() {
      if (carry) line(carry);
      carry = '';
    },
    summary() {
      // The notice can also arrive glued to other text; strip it either way.
      let text = messages
        .join('\n\n')
        .replace(
          /\n*_\[Continuing response due to length limit\.\.\.\]_\n*/g,
          ''
        );
      if (completion !== null) {
        text += `${text ? '\n\n' : ''}[attempt_completion] Result: ${completion}`;
      }
      const stats =
        result && result.stats && typeof result.stats === 'object'
          ? { ...result.stats }
          : null;
      if (stats && stats.session_costs !== undefined) {
        stats.session_costs = normaliseCost(stats.session_costs);
      }
      const last = result ? result.last_message : null;
      return {
        hasResult: !!result,
        text,
        lastMessage:
          last == null
            ? null
            : typeof last === 'string'
              ? last
              : contentToText(last) || null,
        toolCalls: calls,
        stats,
        status: result ? result.status || null : null,
        errors,
      };
    },
  };
}

function limitKind(errors) {
  for (const e of errors) {
    if (e.severity && e.severity !== 'error') continue;
    const msg = String(e.message || '');
    if (/cost limit|max-cost/i.test(msg)) return 'cost-limit';
    if (/turn limit|max-turns/i.test(msg)) return 'turn-limit';
  }
  return null;
}

/**
 * Run a CLI agent (bob, claude, or codex) with the given prompt
 *
 * @param {Object} options - Configuration options
 * @param {string} options.agent - Agent type: 'bob', 'claude', or 'codex'
 * @param {string} options.cwd - Working directory for the agent
 * @param {string} options.prompt - Prompt to send to the agent
 * @param {number} [options.timeout=600000] - Timeout in milliseconds (default: 10 minutes)
 * @param {string} [options.format] - Bob output format; defaults to BOB_OUTPUT_FORMAT
 * @param {Object} [options.caps] - Bob caps { maxCost, maxTurns, disableToolGroups }
 * @param {string} [options.home] - HOME for the child; default is this process's
 * @returns {Promise<{text: string, lastMessage: string|null, toolCalls: Array, stats: Object|null, status: string|null, format: string}>}
 * @throws {AgentRunError}
 */
async function runAgent({
  agent,
  cwd,
  prompt,
  home,
  timeout = 10 * 60 * 1000,
  format = constants.BOB_OUTPUT_FORMAT,
  caps = {
    maxCost: constants.BOB_MAX_COST,
    maxTurns: constants.BOB_MAX_TURNS,
    disableToolGroups: constants.BOB_DISABLE_TOOL_GROUPS,
  },
}) {
  // Validate agent type
  const validAgents = ['bob', 'claude', 'codex'];
  if (!validAgents.includes(agent)) {
    throw new Error(
      `Invalid agent type: ${agent}. Must be one of: ${validAgents.join(', ')}`
    );
  }

  const streamMode = agent === 'bob' && format !== 'pretty';

  return new Promise((resolve, reject) => {
    // Set up environment
    const env = {
      ...process.env,
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      TERM: 'dumb',
      CI: 'true',
    };

    if (home) env.HOME = home;

    // Only pass BOB_API_KEY to Bob agent
    if (agent !== 'bob') {
      delete env.BOB_API_KEY;
    }

    // Set config paths for each agent to use the bundle's config
    // Note: For Bob, we rely on global settings (~/.bob/settings.json) instead of overriding
    // This ensures MCP servers are consistently available across all workspaces
    if (agent === 'claude') {
      env.CLAUDE_MCP_CONFIG = `${cwd}/.claude/mcp_config.json`;
    } else if (agent === 'codex') {
      env.CODEX_MCP_CONFIG = `${cwd}/.codex/mcp_config.json`;
    }

    let stdout = '';
    let stderr = '';

    // Bob Shell CLI v2: 'bob run <prompt>' replaces v1's 'bob -p <prompt> --yolo'.
    // --trust and --accept-license make the run safe in a fresh container (no
    // trustedFolders.json or licence flag yet) and are no-ops on a trusted Mac.
    // --format stream-json gives NDJSON with exact stats; BOB_OUTPUT_FORMAT=pretty
    // restores the legacy text run. carbon-mcp comes from ~/.bob/settings.
    const command = agent;
    const args = buildAgentArgs({ agent, prompt, format, caps });

    const collector = streamMode
      ? createStreamCollector({
          onProgress: (l) => process.stdout.write(`${l}\n`),
        })
      : null;

    // Spawn the process with increased timeout for MCP server startup.
    // stdin is set to 'ignore' so bob run never blocks waiting for interactive
    // input (trust prompts, license confirmations, etc.) in a headless context.
    const proc = spawn(command, args, {
      cwd,
      env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let settled = false;
    let timedOut = false;
    let killTimer = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };

    // A chunk can split a multi-byte character; the decoder holds the tail back.
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');

    // Capture stdout
    proc.stdout.on('data', (data) => {
      const text = data;
      stdout += text;
      if (collector) {
        collector.push(text);
      } else {
        // Show progress dots instead of verbose output
        process.stdout.write('.');
      }
    });

    // Capture stderr
    proc.stderr.on('data', (data) => {
      stderr += data;
    });

    // Handle process completion
    proc.on('close', (code) => {
      clearTimeout(timeoutId);
      clearTimeout(killTimer);
      if (collector) collector.end();
      else process.stdout.write('\n'); // New line after progress dots

      const run = collector ? collector.summary() : null;
      const useEvents = !!(run && run.hasResult);
      const text = useEvents ? run.text : stdout;

      // Write agent output to bundle directory for inspection (sync so it
      // completes before resolve/reject hands control back to the caller).
      try {
        let saved = text;
        if (!streamMode) {
          // Pretty-mode Bob replays the final turn after a live stream. Keep only
          // the last '## Step 1' so the saved file is the clean final turn.
          const step1 = '## Step 1';
          const firstStep1 = stdout.indexOf(step1);
          const lastStep1 = stdout.lastIndexOf(step1);
          if (lastStep1 > firstStep1) saved = stdout.slice(lastStep1);
        }
        fs.writeFileSync(path.join(cwd, 'agent-output.txt'), saved);
        if (streamMode) {
          fs.writeFileSync(
            path.join(cwd, 'agent-events.ndjson'),
            stdout
              .split('\n')
              .filter((l) => l.trim())
              .map((l) => `${l}\n`)
              .join('')
          );
        }
        if (stderr) {
          fs.writeFileSync(path.join(cwd, 'agent-stderr.txt'), stderr);
        }
      } catch (_) {
        // Non-fatal — don't block the review if logging fails
      }

      if (timedOut) return;

      const stats = useEvents ? run.stats : null;
      const fail = (kind, message) =>
        finish(reject, new AgentRunError(message, { kind, stats, stderr }));
      const exitMessage = `${agent} exited with code ${code}\nStderr: ${stderr}`;

      // A warning that mentions a limit must not fail a run that finished cleanly.
      const clean = useEvents && run.status === 'success' && code === 0;
      const limit = run && !clean ? limitKind(run.errors) : null;
      if (limit) {
        return fail(
          limit,
          code !== 0
            ? exitMessage
            : `${agent} stopped at its ${limit === 'cost-limit' ? 'cost' : 'turn'} limit`
        );
      }
      if (useEvents && run.status === 'error') {
        return fail(
          'agent-error',
          code !== 0 ? exitMessage : `${agent} reported an error result`
        );
      }
      if (code !== 0) return fail('exit', exitMessage);

      finish(resolve, {
        text,
        lastMessage: useEvents ? run.lastMessage : null,
        toolCalls: useEvents ? run.toolCalls : [],
        stats,
        status: useEvents ? run.status : null,
        format: useEvents
          ? 'stream-json'
          : agent === 'bob' && !streamMode
            ? 'pretty'
            : 'text',
      });
    });

    // Handle process errors
    proc.on('error', (error) => {
      clearTimeout(timeoutId);
      clearTimeout(killTimer);
      finish(
        reject,
        new AgentRunError(`Failed to start ${agent}: ${error.message}`, {
          kind: 'spawn',
          stderr,
        })
      );
    });

    // Set timeout: SIGTERM, then SIGKILL if the child ignores it.
    const timeoutId = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
      killTimer = setTimeout(() => {
        if (proc.exitCode === null && proc.signalCode === null) {
          proc.kill('SIGKILL');
        }
      }, KILL_GRACE_MS);
      const summary = collector ? collector.summary() : null;
      finish(
        reject,
        new AgentRunError(`${agent} timeout (${timeout / 1000} seconds)`, {
          kind: 'timeout',
          stats: summary && summary.hasResult ? summary.stats : null,
          stderr,
        })
      );
    }, timeout);
  });
}

/**
 * Check if a CLI agent is available in the system PATH
 *
 * @param {string} agent - Agent type: 'bob', 'claude', or 'codex'
 * @returns {Promise<boolean>} - True if agent is available
 */
async function isAgentAvailable(agent) {
  return new Promise((resolve) => {
    const proc = spawn(agent, ['--version'], {
      shell: false,
      stdio: 'ignore',
    });

    // Timeout after 5 seconds; cleared on exit so it cannot hold the process open.
    const timer = setTimeout(() => {
      proc.kill();
      resolve(false);
    }, 5000);

    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });

    proc.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

/**
 * Get the configured agent from environment variables
 *
 * @returns {string} - Agent type: 'bob', 'claude', or 'codex'
 * @throws {Error} - If GITHUB_AI_AGENT_CLI is not set or invalid
 */
function getConfiguredAgent() {
  const agent = process.env.GITHUB_AI_AGENT_CLI;

  if (!agent) {
    throw new Error('GITHUB_AI_AGENT_CLI environment variable is not set');
  }

  const validAgents = ['bob', 'claude', 'codex'];
  if (!validAgents.includes(agent)) {
    throw new Error(
      `Invalid GITHUB_AI_AGENT_CLI: ${agent}. Must be one of: ${validAgents.join(', ')}`
    );
  }

  return agent;
}

module.exports = {
  runAgent,
  AgentRunError,
  buildAgentArgs,
  summarizeToolCalls,
  isAgentAvailable,
  getConfiguredAgent,
};
