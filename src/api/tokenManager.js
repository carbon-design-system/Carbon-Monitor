/******************************************************************************
 * Token Manager for Carbon MCP Integration — compatibility layer
 *
 * The real implementation now lives in ./mcpConnection, which additionally
 * handles OAuth discovery and unattended refresh. This module remains so the
 * function names referenced by docs/MCP_TOKEN_REFRESH.md keep working, and it
 * delegates rather than reimplementing:
 * two independent writers of Bob's mcp.json would silently clobber each other.
 *****************************************************************************/

const { spawn } = require('child_process');
const mcpConnection = require('./mcpConnection');

/**
 * Execute a command and resolve with its output.
 */
function execCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { shell: false, ...options });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    const timer = setTimeout(() => {
      proc.kill();
      finish(reject, new Error('Command timeout'));
    }, 30000);

    proc.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) finish(resolve, { stdout, stderr, code });
      else finish(reject, new Error(`Command failed with code ${code}\nStderr: ${stderr}`));
    });

    proc.on('error', (error) =>
      finish(reject, new Error(`Failed to execute command: ${error.message}`))
    );
  });
}

/** Whether the Bob CLI is installed and runnable. */
async function isBobAvailable() {
  try {
    await execCommand('bob', ['--version']);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Whether the carbon-mcp package can be resolved.
 *
 * Only meaningful for a stdio-launched MCP server. This deployment talks to the
 * hosted server over streamable HTTP, so a false result here is not a fault.
 */
async function isCarbonMcpAvailable() {
  try {
    await execCommand('npx', ['-y', 'carbon-mcp', '--version']);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Store a Carbon MCP token (and optional session id) for the agent.
 *
 * @param {Object} options
 * @param {string} [options.agent='bob'] - Agent type
 * @param {string} options.token - Carbon MCP bearer token
 * @param {string} [options.sessionId] - X-MCP-Session opaque session id
 * @returns {Promise<Object>} Refresh result
 */
async function refreshMcpToken({ agent = 'bob', token, sessionId }) {
  if (!token) throw new Error('Token is required');
  if (agent !== 'bob') {
    throw new Error(`Token refresh not yet implemented for agent: ${agent}`);
  }

  const result = await mcpConnection.setManualCredentials({ token, sessionId });

  console.log('✅ Carbon MCP token refreshed successfully');
  console.log(`   Agent: ${agent}`);
  console.log(`   Config: ${result.configPath}`);

  return { ...result, updated: true };
}

/**
 * Current MCP configuration status.
 * @returns {Promise<Object>} Status information
 */
async function getMcpStatus() {
  const status = await mcpConnection.getStatus();
  const bobAvailable = await isBobAvailable();

  return {
    bobAvailable,
    carbonMcpAvailable: status.configured,
    configured: status.configured && (status.hasToken || status.hasSession),
    servers: status.configured ? [mcpConnection.SERVER_NAME] : [],
    configPath: status.configPath,
    ...status,
  };
}

/**
 * Basic shape check on a token before it is stored.
 *
 * A malformed value is rejected here rather than silently written into Bob's
 * config, where it would surface much later as an opaque MCP failure.
 *
 * @param {string} token
 * @returns {Promise<boolean>}
 */
async function validateMcpToken(token) {
  if (!token || typeof token !== 'string' || token.length < 10) return false;
  // Carbon MCP issues w3id JWTs; a decodable payload with an exp claim is a
  // meaningful signal, but a non-JWT opaque token is still accepted because the
  // server, not this app, is the authority on what it will honour.
  const claims = mcpConnection.decodeJwt(token);
  if (claims && typeof claims.exp === 'number') {
    return claims.exp * 1000 > Date.now();
  }
  return true;
}

/**
 * Remove the carbon-mcp entry from Bob's configuration.
 * @param {string} [agent='bob']
 * @returns {Promise<Object>}
 */
async function removeMcpConfig(agent = 'bob') {
  if (agent !== 'bob') {
    throw new Error(`Config removal not yet implemented for agent: ${agent}`);
  }

  const fs = require('fs').promises;
  const configPath = mcpConnection.getBobMcpConfigPath();

  let config;
  try {
    config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { removed: false, message: 'No servers configured' };
    }
    throw error;
  }

  if (!config.mcpServers?.[mcpConnection.SERVER_NAME]) {
    return { removed: false, message: 'carbon-mcp not found in configuration' };
  }

  delete config.mcpServers[mcpConnection.SERVER_NAME];
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });

  console.log('✅ Carbon MCP configuration removed');
  return { removed: true, configPath };
}

module.exports = {
  refreshMcpToken,
  getMcpStatus,
  validateMcpToken,
  removeMcpConfig,
  isBobAvailable,
  isCarbonMcpAvailable,
};
