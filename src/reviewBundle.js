/**
 * Review Bundle Builder Module
 * Creates temporary workspace with PR context for agent review
 */

const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const {
  MAX_DIFF_CHARS,
  CHARS_PER_TOKEN,
  ISSUE_CONTEXT_TOKENS,
} = require('./constants');
const { buildReviewPrompt } = require('./reviewPrompt');
const agents = require('./agents');

/**
 * Strip single-line and multi-line comments from JSON string
 * @param {string} jsonString - JSON string potentially with comments
 * @returns {string} JSON string without comments
 */
function stripJsonComments(jsonString) {
  // Remove single-line comments (// ...)
  let result = jsonString.replace(/\/\/.*$/gm, '');
  // Remove multi-line comments (/* ... */)
  result = result.replace(/\/\*[\s\S]*?\*\//g, '');
  return result;
}

/**
 * Root directory review bundles are created under.
 *
 * Override with BOB_WORKSPACE_ROOT. The macOS default is /private/tmp because that
 * path is in Bob's trustedFolders.json; elsewhere (containers) the platform temp
 * directory is correct and the Dockerfile points BOB_WORKSPACE_ROOT at a writable
 * volume so bundles survive the read-only parts of the image.
 *
 * @returns {string} Absolute path to the bundle root
 */
function getWorkspaceRoot() {
  if (process.env.BOB_WORKSPACE_ROOT) {
    return process.env.BOB_WORKSPACE_ROOT;
  }
  return process.platform === 'darwin' ? '/private/tmp' : os.tmpdir();
}

/**
 * Recursively copy a directory
 * @param {string} src - Source directory
 * @param {string} dest - Destination directory
 */
async function copyDirectory(src, dest) {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      await copyDirectory(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

// Non-fatal: the review continues and the skill simply won't be available.
async function copySkill(src, dest) {
  try {
    await copyDirectory(src, dest);
  } catch (skillErr) {
    console.warn(
      '⚠️  Could not copy carbon-builder skill into bundle:',
      skillErr.message
    );
  }
}

/**
 * Give one Bob process its own HOME, seeded from the real ~/.bob.
 *
 * Two Bob processes must share no file: trustedFolders.json, task history, logs
 * and mcp.json are all read and rewritten under $HOME/.bob. skills/ is
 * read-only to Bob, so it is a symlink; the bundle cleanup removes the rest.
 * @param {string} bundleDir - The bundle directory (also Bob's cwd)
 * @returns {Promise<string>} The HOME to give the child
 */
async function seedBobHome(bundleDir) {
  const src = path.join(os.homedir(), '.bob');
  const home = path.join(bundleDir, 'home');
  const dest = path.join(home, '.bob');
  await fs.mkdir(path.join(dest, 'settings'), { recursive: true });

  for (const rel of [
    'settings.json',
    path.join('settings', 'settings.json'),
    path.join('settings', 'mcp.json'),
  ]) {
    await fs.copyFile(path.join(src, rel), path.join(dest, rel)).catch((e) => {
      if (e.code !== 'ENOENT') throw e;
    });
  }

  // Trust the bundle explicitly as well as passing --trust. A list or a
  // path-keyed map are the two shapes Bob versions have used.
  let trusted = null;
  try {
    trusted = JSON.parse(
      await fs.readFile(path.join(src, 'trustedFolders.json'), 'utf8')
    );
  } catch {
    // Absent or unreadable: rely on --trust.
  }
  if (trusted !== null && typeof trusted === 'object') {
    const dirs = new Set([bundleDir, await fs.realpath(bundleDir)]);
    for (const dir of dirs) {
      if (Array.isArray(trusted)) {
        if (!trusted.includes(dir)) trusted.push(dir);
      } else {
        trusted[dir] = true;
      }
    }
    await fs.writeFile(
      path.join(dest, 'trustedFolders.json'),
      JSON.stringify(trusted, null, 2)
    );
  }

  const rules = path.join(src, 'rules');
  if (
    await fs.stat(rules).then(
      (st) => st.isDirectory(),
      () => false
    )
  ) {
    await copyDirectory(rules, path.join(dest, 'rules'));
  }
  const skills = path.join(src, 'skills');
  if (
    await fs.stat(skills).then(
      (st) => st.isDirectory(),
      () => false
    )
  ) {
    await fs.symlink(skills, path.join(dest, 'skills'));
  }
  return home;
}

/**
 * Copy the real mcp.json into a review's HOME again, so a bearer refreshed
 * since seeding is used. Called at run boundaries only, never mid-run.
 * @param {string} home - The HOME returned by seedBobHome
 */
async function refreshBobMcp(home) {
  const rel = path.join('settings', 'mcp.json');
  await fs
    .copyFile(
      path.join(os.homedir(), '.bob', rel),
      path.join(home, '.bob', rel)
    )
    .catch((e) => {
      if (e.code !== 'ENOENT') throw e;
    });
}

/**
 * Build a review bundle for agent execution
 * @param {Object} options - { owner, repo, pr, diff, files, agent } (agent defaults to the configured one)
 * @returns {Promise<Object>} Bundle object with dir, prompt, and cleanup function
 */
async function buildReviewBundle({
  owner,
  repo,
  pr,
  diff,
  files,
  client,
  agent,
}) {
  const adapter = agents.get(agent);
  // Create the bundle under a directory Bob Shell treats as trusted for MCP access.
  //
  // On macOS this must be /private/tmp: os.tmpdir() resolves to /var/folders/…/T,
  // which is NOT in Bob's trustedFolders.json, so Bob silently disables MCP tools.
  // In a Linux container /private/tmp does not exist, so the root is env-driven and
  // the platform default is used otherwise. agentRunner additionally passes --trust
  // so a fresh container trusts the bundle without a pre-seeded trustedFolders.json.
  const bobTrustedTmp = getWorkspaceRoot();
  await fs.mkdir(bobTrustedTmp, { recursive: true });
  const tempDir = await fs.mkdtemp(
    path.join(bobTrustedTmp, `${owner}__${repo}__pull-${pr.number}-`)
  );

  try {
    // 3. Write PR metadata
    await fs.writeFile(
      path.join(tempDir, 'pr.json'),
      JSON.stringify(pr, null, 2)
    );

    // 4. Write files list
    await fs.writeFile(
      path.join(tempDir, 'files.json'),
      JSON.stringify(files, null, 2)
    );

    // 5. Write diff (with truncation if needed)
    let diffToWrite = diff;
    let diffTruncated = false;

    if (diff.length > MAX_DIFF_CHARS) {
      diffTruncated = true;
      diffToWrite = diff.substring(0, MAX_DIFF_CHARS);
      diffToWrite += '\n\n[... diff truncated due to size ...]\n';
      diffToWrite += `Original size: ${diff.length} chars, truncated to: ~${Math.round(MAX_DIFF_CHARS / CHARS_PER_TOKEN / 1000)}k tokens (${MAX_DIFF_CHARS} chars)\n`;
      diffToWrite += `View full diff at: https://github.com/${owner}/${repo}/pull/${pr.number}/files\n`;
    }

    await fs.writeFile(path.join(tempDir, 'diff.patch'), diffToWrite);

    // 6. Fetch linked issue context if a GitHub client is available
    let issueContextSection = '';
    if (client) {
      const issueContext = await client.fetchLinkedIssueContext({
        owner,
        repo,
        prBody: pr.body,
      });

      if (issueContext.found) {
        const maxIssueChars = ISSUE_CONTEXT_TOKENS * CHARS_PER_TOKEN;
        const { subIssue, parentIssue } = issueContext;

        let issueContent = `### Issue #${subIssue.number}: ${subIssue.title}\n\n${subIssue.body}`;

        if (parentIssue) {
          issueContent += `\n\n### Parent Issue #${parentIssue.number}: ${parentIssue.title}\n\n${parentIssue.body}`;
        }

        if (issueContent.length > maxIssueChars) {
          const hardCut = issueContent.substring(0, maxIssueChars);
          const lastNewline = hardCut.lastIndexOf('\n');
          // Snap to the last complete line if one exists within the cut window.
          // If lastIndexOf returns -1 (no newlines — wall-of-text body), fall back
          // to the hard char cut. Guard > 0 also handles a degenerate \n-at-start case.
          const snapPos = lastNewline > 0 ? lastNewline : maxIssueChars;
          issueContent =
            issueContent.substring(0, snapPos) +
            '\n\n[... issue context truncated ...]';
        }

        issueContextSection = `\n## Linked Issue Context\n\n${issueContent}\n`;
      }
    }

    // 7. Write PR review request summary — embed diff directly so the agent
    // needs only ONE file read to get all context, reducing coin spend.
    const prSummary = `# PR Review Request

**Repository:** ${owner}/${repo}
**PR Number:** #${pr.number}
**Title:** ${pr.title}
**Author:** ${pr.user.login}
**Created:** ${pr.created_at}
**Updated:** ${pr.updated_at}
**Review Date:** ${new Date().toISOString().split('T')[0]}

## Description

${pr.body || 'No description provided'}
${issueContextSection}
## Changed Files

${files.map((f) => `- \`${f.filename}\` (+${f.additions}/-${f.deletions})`).join('\n')}

## Diff

\`\`\`diff
${diffToWrite}
\`\`\`
`;

    // Compute the 1-based line number of the ```diff fence within prSummary.
    // The agent reports finding lines as absolute line numbers within
    // PR_REVIEW_REQUEST.md. diffMapper needs this offset to convert those
    // reported numbers back to new-file line numbers via the secondary lookup.
    const mdDiffStartLine = prSummary.split('\n').indexOf('```diff') + 1;

    await fs.writeFile(path.join(tempDir, 'PR_REVIEW_REQUEST.md'), prSummary);

    // 6. Write agent rules (for all agent types)
    const rules = `# Carbon PR Review Agent Rules

You are reviewing a pull request in ${owner}/${repo}.

## TOOL FALLBACK — MANDATORY (do not stop because a tool is unavailable)

- MANDATORY: Invoke \`carbon-builder\` skill before every Category 1 Carbon finding. Invoke via the \`Skill\` tool.
- MANDATORY: If \`carbon-builder\` is unavailable, fall back to Carbon MCP (code_search, docs_search, get_charts).
  Log: ⚠️ carbon-builder UNAVAILABLE — MCP fallback: [component/attribute]
- MANDATORY: If Carbon MCP is also unavailable, proceed from model knowledge.
  Log: ⚠️ CARBON SKILL/MCP UNAVAILABLE — used model knowledge for: [component] at [file:line]
- MANDATORY: Tool unavailability is NOT a reason to stop or drop a finding. Uptime is mandatory.

## Carbon API source of truth

Before making any Carbon-specific claim — prop, attribute name, token, icon, variant, or accessibility pattern — invoke the \`carbon-builder\` skill.
Before looking up any prop, import path, or token name, invoke \`carbon-builder\`.

- \`carbon-builder\` skill is the preferred ground truth for ALL Carbon-specific claims.
- Carbon MCP (code_search, docs_search, get_charts) is the Tier 2 fallback — use it when \`carbon-builder\` is unavailable.
- Model knowledge is Tier 3 — use it only when both skill and MCP are unreachable.

## Mandatory rules

- Do not edit files.
- Do not run package manager install commands.
- Produce only the requested JSON object and review Markdown.
`;

    // The skill source is the vendored copy; it does not force activation, it
    // only makes the skill discoverable.
    const skillSource = path.join(
      __dirname,
      '..',
      '.bob',
      'skills',
      'carbon-builder'
    );
    await adapter.prepareBundle(tempDir, { rules, skillSource });

    // 6. Create review prompt using the detailed prompt builder
    const prompt = buildReviewPrompt({ owner, repo, agent: adapter.id });

    // Return bundle object (no settingsPath needed - using global config)
    return {
      dir: tempDir,
      prompt,
      mdDiffStartLine,
      cleanup: async () => {
        try {
          await fs.rm(tempDir, { recursive: true, force: true });
        } catch (error) {
          console.error('Error cleaning up bundle:', error.message);
        }
      },
    };
  } catch (error) {
    // Cleanup on error
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (cleanupError) {
      // Ignore cleanup errors
    }
    throw error;
  }
}

module.exports = {
  buildReviewBundle,
  getWorkspaceRoot,
  copySkill,
  seedBobHome,
  refreshBobMcp,
};
