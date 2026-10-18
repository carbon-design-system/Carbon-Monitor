const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const agents = require('./agents');
const { CARBON_MCP_SERVER, mcpToolName } = require('./agents/common');

const KILL_GRACE_MS = 10 * 1000;

class AgentRunError extends Error {
  constructor(message, { kind, stats = null, stderr = '' } = {}) {
    super(message);
    this.name = 'AgentRunError';
    this.kind = kind;
    this.stats = stats;
    this.stderr = stderr;
  }
}

function buildAgentArgs({ agent, prompt, format, caps = {}, bundleDir }) {
  return agents.get(agent).buildArgs({ prompt, format, caps, bundleDir });
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

// The adapter decides what counts as skill evidence; Bob is the default.
function summarizeToolCalls(toolCalls = [], agent = 'bob') {
  return agents.get(agent).evidence(toolCalls);
}

// Folds an agent's stream-json NDJSON into the run's text, tool calls and stats.
// A chunk can end mid-line, so the tail is carried into the next push().
// adapter.parseEvent turns each vendor event into normalised ones (see src/agents).
function createStreamCollector({ adapter, onProgress, onInit }) {
  let carry = '';
  const messages = [];
  const calls = [];
  const callsById = new Map();
  const errors = [];
  const parseState = {};
  let init = null;
  let result = null;
  let lastWasAssistant = false;
  let lastTextId = null;

  function handle(event) {
    switch (event.type) {
      case 'init':
        if (!init) {
          init = event;
          if (onInit) onInit(event);
        }
        break;
      case 'text': {
        const id = event.messageId ?? null;
        if (event.text) {
          // Without a message id (Bob streams assistant text as many small
          // events with no delta flag, seen live on 2.0.0) consecutive pieces are
          // one message until a tool call, error or other role intervenes.
          // Known limit: two whole back-to-back messages would also be glued.
          // With one (Claude), blocks of one API response share it.
          if (lastWasAssistant && messages.length && id === lastTextId) {
            messages[messages.length - 1] += event.text;
          } else {
            messages.push(event.text);
          }
        }
        lastWasAssistant = true;
        lastTextId = id;
        break;
      }
      case 'break':
        lastWasAssistant = false;
        break;
      case 'tool_use': {
        const call = {
          name: event.name,
          params: event.params || {},
          status: 'unknown',
        };
        if (event.server) {
          call.server = event.server;
          call.tool = event.tool;
        }
        calls.push(call);
        if (event.id) callsById.set(event.id, call);
        if (onProgress) onProgress(`⚙ ${mcpToolName(call) || call.name}`);
        // Text after a tool call starts a new message even when streamed as a delta.
        lastWasAssistant = false;
        break;
      }
      case 'tool_result': {
        const call = callsById.get(event.id);
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
        const json = JSON.parse(trimmed);
        if (json && typeof json.type === 'string') {
          const out = adapter.parseEvent(json, parseState);
          for (const event of [].concat(out || [])) handle(event);
        }
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
      const joined = messages.join('\n\n');
      const text = adapter.finalizeText
        ? adapter.finalizeText(joined, calls)
        : joined;
      const stats =
        result && result.stats && typeof result.stats === 'object'
          ? { ...result.stats }
          : null;
      if (stats && stats.session_costs !== undefined) {
        stats.session_costs = normaliseCost(stats.session_costs);
      }
      return {
        hasResult: !!result,
        text,
        lastMessage: result ? (result.lastMessage ?? null) : null,
        toolCalls: calls,
        stats,
        status: result ? result.status || null : null,
        errors,
        // An error event that names a limit wins, then the result's own subtype.
        limit:
          (errors.find((e) => e.limit) || {}).limit ||
          (result && result.limit) ||
          null,
        denials: result && result.denials ? result.denials : [],
      };
    },
  };
}

function logInit(agent, init) {
  const servers = init.mcpServers.map((s) => `${s.name}=${s.status}`);
  console.log(
    `🧭 ${agent} session: model=${init.model || 'unknown'}, MCP: ${servers.join(', ') || 'none'}, skills: ${init.skills.length}`
  );
  // A fresh config dir still lists the CLI's bundled skills; only ours matters.
  if (!init.skills.includes('carbon-builder')) {
    console.warn(
      `⚠️  carbon-builder skill was not discovered by ${agent} — Carbon claims in this review will be unverified by the skill`
    );
  }
  const carbon = init.mcpServers.find((s) => s.name === CARBON_MCP_SERVER);
  if (!carbon || carbon.status !== 'connected') {
    console.warn(
      `⚠️  ${CARBON_MCP_SERVER} is ${carbon ? carbon.status : 'not configured'} in the ${agent} session — Carbon MCP checks will fall back to model knowledge`
    );
  }
}

/**
 * Run a CLI agent with the given prompt
 *
 * @param {Object} options - Configuration options
 * @param {string} options.agent - Agent id from src/agents ('bob' or 'claude')
 * @param {string} options.cwd - Working directory for the agent (the review bundle)
 * @param {string} options.prompt - Prompt to send to the agent
 * @param {number} [options.timeout=600000] - Timeout in milliseconds (default: 10 minutes)
 * @param {string} [options.format] - Output format; defaults to the adapter's
 * @param {Object} [options.caps] - Spend and turn caps; defaults to the adapter's
 * @param {string} [options.home] - The home seedHome returned; default is this process's
 * @returns {Promise<{text: string, lastMessage: string|null, toolCalls: Array, stats: Object|null, status: string|null, format: string}>}
 * @throws {AgentRunError}
 */
async function runAgent({
  agent,
  cwd,
  prompt,
  home,
  timeout = 10 * 60 * 1000,
  format,
  caps,
}) {
  // Throws for an unknown agent, listing the valid ids
  const adapter = agents.get(agent);
  const defaults = adapter.defaults();
  if (format === undefined) format = defaults.format;
  if (caps === undefined) caps = defaults.caps;

  const streamMode = adapter.streams(format);

  return new Promise((resolve, reject) => {
    const env = adapter.env(
      {
        ...process.env,
        NO_COLOR: '1',
        FORCE_COLOR: '0',
        TERM: 'dumb',
        CI: 'true',
      },
      { home, bundleDir: cwd }
    );

    let stdout = '';
    let stderr = '';

    const args = adapter.buildArgs({ prompt, format, caps, bundleDir: cwd });

    const collector = streamMode
      ? createStreamCollector({
          adapter,
          onProgress: (l) => process.stdout.write(`${l}\n`),
          onInit: (init) => logInit(agent, init),
        })
      : null;

    // Spawn the process with increased timeout for MCP server startup.
    // stdin is set to 'ignore' so bob run never blocks waiting for interactive
    // input (trust prompts, license confirmations, etc.) in a headless context.
    const proc = spawn(adapter.binary, args, {
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
        const saved =
          !streamMode && adapter.plainText ? adapter.plainText(stdout) : text;
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

      if (run && run.denials.length) {
        console.warn(
          `⚠️  ${agent} was denied ${run.denials.length} tool call(s): ${[...new Set(run.denials)].join(', ')}`
        );
      }

      const stats = useEvents ? run.stats : null;
      const fail = (kind, message) =>
        finish(reject, new AgentRunError(message, { kind, stats, stderr }));
      const exitMessage = `${agent} exited with code ${code}\nStderr: ${stderr}`;

      // A warning that mentions a limit must not fail a run that finished cleanly.
      const clean = useEvents && run.status === 'success' && code === 0;
      const limit = run && !clean ? run.limit : null;
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
        format: useEvents ? 'stream-json' : !streamMode ? 'pretty' : 'text',
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
 * @param {string} agent - Agent id from src/agents
 * @returns {Promise<boolean>} - True if agent is available
 */
async function isAgentAvailable(agent) {
  const adapter = agents.find(agent);
  return new Promise((resolve) => {
    const proc = spawn(adapter ? adapter.binary : agent, ['--version'], {
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
 * @returns {string} - Agent id from src/agents
 * @throws {Error} - If GITHUB_AI_AGENT_CLI is not set or invalid
 */
function getConfiguredAgent() {
  const agent = process.env.GITHUB_AI_AGENT_CLI;

  if (!agent) {
    throw new Error('GITHUB_AI_AGENT_CLI environment variable is not set');
  }

  if (!agents.find(agent)) {
    throw new Error(
      `Invalid GITHUB_AI_AGENT_CLI: ${agent}. Must be one of: ${agents.ids().join(', ')}`
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
