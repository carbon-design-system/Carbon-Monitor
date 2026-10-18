/**
 * env.js: environment helpers and the startup configuration check
 *
 * Credentials pass through readTrimmedString() before use. Kubernetes and Code
 * Engine secrets created with --from-literal or pasted YAML can carry trailing
 * newlines or spaces that silently cause 401s.
 *
 * checkStartup() lists the variables a mode cannot run without. It only reports:
 * the process stays up so the console can still show what is wrong.
 */

'use strict';

/**
 * Read an env var and trim surrounding whitespace.
 * Returns '' when the var is absent or empty after trimming.
 */
function readTrimmedString(name) {
  return (process.env[name] || '').trim();
}

/**
 * Produce a safe diagnostic description of a credential value.
 * Never logs any part of the value or a hash of it — only whether it is
 * set, its length, and whitespace/control-character flags.
 */
function describeCredential(label, value) {
  // The env var keeps its whitespace for the flags; value covers a default.
  const raw = process.env[label] || value || '';
  const trimmed = raw.trim();
  return {
    label,
    set: trimmed.length > 0,
    length: raw.length,
    trimmedLength: trimmed.length,
    hasLeadingWhitespace: raw.length > 0 && raw[0] !== trimmed[0],
    hasTrailingWhitespace:
      raw.length > 0 && raw[raw.length - 1] !== trimmed[trimmed.length - 1],
    hasInnerControlChars: /[\x00-\x1f\x7f]/.test(trimmed),
  };
}

let startupProblems = [];

/**
 * Log one line per missing required variable and remember them for /api/ready.
 *
 * @param {Object} options
 * @param {'server'|'cli'} options.mode
 * @param {boolean} [options.authRequired] - Console sign-in is enforced (server mode)
 * @param {boolean} [options.bearerEnabled] - API_SECRET bearer path is on (server mode)
 * @returns {string[]} The problems found
 */
function checkStartup({
  mode,
  authRequired = false,
  bearerEnabled = true,
} = {}) {
  const required = [
    [
      'GITHUB_AI_AGENT_TOKEN',
      'reviews cannot read or comment on pull requests',
    ],
  ];

  // Lazy: the registry loads constants, which reads the environment at load.
  const agents = require('../agents');
  const agent = readTrimmedString('GITHUB_AI_AGENT_CLI') || agents.DEFAULT_ID;
  const adapter = agents.find(agent);
  if (adapter && adapter.requiredEnv) {
    required.push([
      adapter.requiredEnv,
      `the ${agent} CLI cannot authenticate in a container`,
    ]);
  }

  if (mode === 'server' && authRequired) {
    required.push(
      ['CONSOLE_USERNAME', 'nobody can sign in to the console'],
      ['CONSOLE_PASSWORD', 'nobody can sign in to the console']
    );
    if (bearerEnabled) {
      required.push(['API_SECRET', 'bearer-token API calls are rejected']);
    }
  }

  startupProblems = required
    .filter(([name]) => !readTrimmedString(name))
    .map(([name, why]) => `${name} is not set: ${why}`);

  for (const problem of startupProblems) {
    console.warn(`[config] ${problem}`);
  }
  return startupProblems;
}

/** The problems from the last checkStartup(), for /api/ready. */
function getStartupProblems() {
  return [...startupProblems];
}

module.exports = {
  readTrimmedString,
  describeCredential,
  checkStartup,
  getStartupProblems,
};
