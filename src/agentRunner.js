const { spawn } = require('child_process');

/**
 * Run a CLI agent (bob, claude, or codex) with the given prompt
 *
 * @param {Object} options - Configuration options
 * @param {string} options.agent - Agent type: 'bob', 'claude', or 'codex'
 * @param {string} options.cwd - Working directory for the agent
 * @param {string} options.prompt - Prompt to send to the agent
 * @param {number} [options.timeout=600000] - Timeout in milliseconds (default: 10 minutes)
 * @returns {Promise<string>} - Agent output
 */
async function runAgent({ agent, cwd, prompt, timeout = 10 * 60 * 1000 }) {
  // Validate agent type
  const validAgents = ['bob', 'claude', 'codex'];
  if (!validAgents.includes(agent)) {
    throw new Error(`Invalid agent type: ${agent}. Must be one of: ${validAgents.join(', ')}`);
  }

  return new Promise((resolve, reject) => {
    // Set up environment
    const env = {
      ...process.env,
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      TERM: 'dumb',
      CI: 'true',
    };

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

    // Configure CLI command based on agent type
    let command, args;
    
    switch (agent) {
      case 'bob':
        // Bob Shell CLI v2 - headless mode with MCP support
        // Note: carbon-mcp is configured globally via streamable HTTP in ~/.bob/settings.json
        // v2 changes from v1: 'bob run <prompt>' replaces 'bob -p <prompt> --yolo';
        //   --mode agent is the default (v1's 'advanced' mode no longer exists in v2);
        //   --allowed-mcp-server-names removed (unknown option in v2)
        command = 'bob';
        args = [
          'run',
          prompt,
        ];
        break;
        
      case 'claude':
        // Claude CLI - print mode with automation flags
        command = 'claude';
        args = [
          '-p',
          '--dangerously-skip-permissions',
          '--output-format',
          'stream-json',
          '--verbose',
          prompt
        ];
        break;
        
      case 'codex':
        // Codex CLI - exec mode with full automation
        command = 'codex';
        args = ['exec', '--full-auto', prompt];
        break;
    }
    
    // Spawn the process with increased timeout for MCP server startup.
    // stdin is set to 'ignore' so bob run never blocks waiting for interactive
    // input (trust prompts, license confirmations, etc.) in a headless context.
    const proc = spawn(command, args, {
      cwd,
      env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Note: spawn doesn't have a timeout option, we handle it manually below
    });

    // Capture stdout
    proc.stdout.on('data', (data) => {
      const text = data.toString();
      stdout += text;
      // Show progress dots instead of verbose output
      process.stdout.write('.');
    });

    // Capture stderr
    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    // Handle process completion
    proc.on('close', (code) => {
      process.stdout.write('\n'); // New line after progress dots

      // Write agent output to bundle directory for inspection (sync so it
      // completes before resolve/reject hands control back to the caller).
      // Bob advanced mode emits a live-stream phase followed by a final-turn
      // replay. When ## Step 1 appears more than once the output contains a
      // duplicate mid-stream prefix — trim to the last occurrence so the saved
      // file shows only the clean final turn. When it appears once (or not at
      // all) the output is already clean and is saved as-is.
      const fs = require('fs');
      const path = require('path');
      try {
        const step1 = '## Step 1';
        const firstStep1 = stdout.indexOf(step1);
        const lastStep1 = stdout.lastIndexOf(step1);
        const trimmed = lastStep1 > firstStep1
          ? stdout.slice(lastStep1)
          : stdout;
        fs.writeFileSync(path.join(cwd, 'agent-output.txt'), trimmed);
        if (stderr) {
          fs.writeFileSync(path.join(cwd, 'agent-stderr.txt'), stderr);
        }
      } catch (_) {
        // Non-fatal — don't block the review if logging fails
      }

      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`${agent} exited with code ${code}\nStderr: ${stderr}`));
      }
    });

    // Handle process errors
    proc.on('error', (error) => {
      reject(new Error(`Failed to start ${agent}: ${error.message}`));
    });

    // Set timeout
    const timeoutId = setTimeout(() => {
      proc.kill();
      reject(new Error(`${agent} timeout (${timeout / 1000} seconds)`));
    }, timeout);

    // Clear timeout on completion
    proc.on('close', () => {
      clearTimeout(timeoutId);
    });
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
      stdio: 'ignore'
    });

    proc.on('close', (code) => {
      resolve(code === 0);
    });

    proc.on('error', () => {
      resolve(false);
    });

    // Timeout after 5 seconds
    setTimeout(() => {
      proc.kill();
      resolve(false);
    }, 5000);
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
    throw new Error(`Invalid GITHUB_AI_AGENT_CLI: ${agent}. Must be one of: ${validAgents.join(', ')}`);
  }

  return agent;
}

module.exports = {
  runAgent,
  isAgentAvailable,
  getConfiguredAgent
};

// Made with Bob
