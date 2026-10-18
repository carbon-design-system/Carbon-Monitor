'use strict';

const fs = require('fs').promises;
const path = require('path');
const constants = require('../constants');
const { contentToText, summarize } = require('./common');

const SKILL_DIR = '.bob/skills/carbon-builder/';
const SKILL_SENTINEL = 'use_skill:carbon-builder';
// Bob inserts this notice as its own piece when a long answer continues; it is
// not model output and lands inside the review JSON if kept.
const CONTINUATION_NOTICE =
  /^\s*_\[Continuing response due to length limit\.\.\.\]_\s*$/;
const CONTINUATION_GLOBAL =
  /\n*_\[Continuing response due to length limit\.\.\.\]_\n*/g;

// The bundle code is loaded lazily: reviewBundle requires this registry.
const bundle = () => require('../reviewBundle');

// The child gets only these and BOB_*, never the harness's own secrets. NODE_ENV
// stays because Bob's bundle picks its production UI builds from it.
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
    'ALL_PROXY',
    'SSL_CERT_FILE',
    'NODE_EXTRA_CA_CERTS',
  ].flatMap((k) => [k, k.toLowerCase()])
);
for (const k of ['NO_COLOR', 'FORCE_COLOR', 'CI', 'NODE_ENV']) ENV_ALLOW.add(k);

function limitOf(event) {
  if (event.severity && event.severity !== 'error') return null;
  const msg = String(event.message || '');
  if (/cost limit|max-cost/i.test(msg)) return 'cost-limit';
  if (/turn limit|max-turns/i.test(msg)) return 'turn-limit';
  return null;
}

module.exports = {
  id: 'bob',
  displayName: 'IBM Bob',
  cliName: 'Bob Shell CLI',
  binary: 'bob',
  requiredEnv: 'BOB_API_KEY',
  costUnit: 'bobcoins',
  creditLabel: 'Bobcoins',
  resultSource: 'bob-result',
  isolated: true,
  skill: {
    tool: 'use_skill',
    dir: SKILL_DIR,
    sentinel: SKILL_SENTINEL,
    pattern: /use_skill[\s\S]{0,300}carbon-builder/i,
  },

  defaults() {
    return {
      format: constants.BOB_OUTPUT_FORMAT,
      caps: {
        maxCost: constants.BOB_MAX_COST,
        maxTurns: constants.BOB_MAX_TURNS,
        disableToolGroups: constants.BOB_DISABLE_TOOL_GROUPS,
      },
    };
  },

  streams(format) {
    return format !== 'pretty';
  },

  // Bob 2.0.5 rejects a cap of 0, so an unset or zero cap omits its flag. Caps do
  // not depend on --format, so the pretty kill switch keeps a spend cap.
  // --trust and --accept-license make the run safe in a fresh container (no
  // trustedFolders.json or licence flag yet) and are no-ops on a trusted Mac.
  // --format stream-json gives NDJSON with exact stats; BOB_OUTPUT_FORMAT=pretty
  // restores the legacy text run. carbon-mcp comes from ~/.bob/settings.
  buildArgs({ prompt, format, caps = {} }) {
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
  },

  env(base, { home } = {}) {
    const env = {};
    for (const [k, v] of Object.entries(base)) {
      if (ENV_ALLOW.has(k) || k.startsWith('BOB_')) env[k] = v;
    }
    if (home) env.HOME = home;
    return env;
  },

  async prepareBundle(bundleDir, { rules, skillSource }) {
    // Bob v2 reads BOB_API_KEY from the environment (renamed from BOBSHELL_API_KEY in v1).
    // 0600, not the 0644 a bare writeFile would produce: this is the only file
    // in the bundle that carries a live credential, and it must not be the most
    // readable one. The bundle directory is already 0700 from mkdtemp.
    await fs.writeFile(
      path.join(bundleDir, '.env'),
      `BOB_API_KEY=${process.env.BOB_API_KEY || ''}\n`,
      { mode: 0o600 }
    );

    const rulesDir = path.join(bundleDir, '.bob', 'rules');
    await fs.mkdir(rulesDir, { recursive: true });
    await fs.writeFile(path.join(rulesDir, '01-output.md'), rules);

    // Bob resolves skills from the CWD's .bob/skills/ directory; without this
    // copy the local .bob/ shadows ~/.bob/skills/ and the skill is never found.
    // This does NOT force activation, it only makes the skill discoverable.
    await bundle().copySkill(
      skillSource,
      path.join(bundleDir, '.bob', 'skills', 'carbon-builder')
    );
  },

  async seedHome(bundleDir) {
    const { seedBobHome, refreshBobMcp } = bundle();
    const home = await seedBobHome(bundleDir);
    return { home, refresh: () => refreshBobMcp(home) };
  },

  promptFragments: {
    noCompletion: 'Do not call attempt_completion',
    noFileWrite:
      'Do not use write_to_file, write_file, or any file-writing tool',
    skillPath: '.bob/skills/carbon-builder/',
    readTool: 'read_file',
  },

  // Returns a normalised event, or null for anything the collector ignores.
  parseEvent(json) {
    switch (json.type) {
      case 'message': {
        if (json.role === 'assistant' && json.isReasoning !== true) {
          const text = contentToText(json.content);
          if (CONTINUATION_NOTICE.test(text)) return null;
          return { type: 'text', text };
        }
        return { type: 'break' };
      }
      case 'tool_use':
        return {
          type: 'tool_use',
          id: json.tool_id,
          name: json.tool_name,
          params: json.parameters || {},
        };
      case 'tool_result':
        return { type: 'tool_result', id: json.tool_id, status: json.status };
      case 'error':
        return {
          type: 'error',
          message: json.message,
          severity: json.severity,
          limit: limitOf(json),
        };
      case 'result': {
        const last = json.last_message;
        return {
          type: 'result',
          status: json.status || null,
          stats:
            json.stats && typeof json.stats === 'object'
              ? { ...json.stats }
              : null,
          lastMessage:
            last == null
              ? null
              : typeof last === 'string'
                ? last
                : contentToText(last) || null,
          limit: null,
          denials: [],
        };
      }
      default:
        return null;
    }
  },

  // The notice can also arrive glued to other text; strip it either way, then
  // append the last attempt_completion result.
  finalizeText(text, toolCalls) {
    let out = text.replace(CONTINUATION_GLOBAL, '');
    let completion = null;
    for (const call of toolCalls) {
      if (call.name === 'attempt_completion' && call.params.result != null) {
        completion = String(call.params.result);
      }
    }
    if (completion !== null) {
      out += `${out ? '\n\n' : ''}[attempt_completion] Result: ${completion}`;
    }
    return out;
  },

  // Pretty-mode Bob replays the final turn after a live stream. Keep only the
  // last '## Step 1' so the saved file is the clean final turn.
  plainText(stdout) {
    const step1 = '## Step 1';
    const firstStep1 = stdout.indexOf(step1);
    const lastStep1 = stdout.lastIndexOf(step1);
    return lastStep1 > firstStep1 ? stdout.slice(lastStep1) : stdout;
  },

  evidence(toolCalls) {
    return summarize(toolCalls, (call) => {
      const params = call.params || {};
      if (call.name === 'use_skill' && params.skill_name === 'carbon-builder') {
        return { skill: true };
      }
      if (call.name === 'read_file') {
        const p = params.path || params.file_path;
        if (typeof p === 'string' && p.includes(SKILL_DIR)) return { file: p };
      }
      return null;
    });
  },

  // The module object is called, not a copy of its functions, so a test can patch it.
  async credits() {
    const bobCredits = require('../api/bobCredits');
    const balance = (await bobCredits.getBalance()) || {};
    const { low, threshold } = bobCredits.isLowBalance(balance);
    return {
      available: !!balance.available,
      low,
      threshold,
      remaining: balance.remaining ?? null,
      percentRemaining: balance.percentRemaining ?? null,
      reason: balance.reason ?? null,
      summary: `Bobcoins at ${balance.percentRemaining}% (below ${threshold}% threshold)`,
      balance,
    };
  },
};
