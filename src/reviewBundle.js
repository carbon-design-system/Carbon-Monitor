/**
 * Review Bundle Builder Module
 * Creates temporary workspace with PR context for agent review
 */

const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const os = require('os');
const { MAX_DIFF_CHARS } = require('./constants');
const { buildReviewPrompt } = require('./reviewPrompt');

// Absolute path to the Carbon Builder Skill reference files shipped with this project
const SKILL_REFERENCES_SRC = path.join(__dirname, '..', '.bob', 'skills', 'carbon-builder', 'references');

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
 * Get the current working directory's Bob settings path
 * @returns {string|null} Path to settings.json or null if not found
 */
function getCurrentBobSettingsPath() {
  const possiblePaths = [
    path.join(process.cwd(), '.bob', 'settings.json'),
    path.join(os.homedir(), '.bob', 'settings.json')
  ];
  
  for (const configPath of possiblePaths) {
    try {
      if (require('fs').existsSync(configPath)) {
        return configPath;
      }
    } catch (error) {
      // Continue to next path
    }
  }
  
  return null;
}

/**
 * Create a default Bob settings with MCP config for carbon-mcp-server
 * @param {string} tempDir - Temporary directory path
 */
async function createDefaultBobSettings(tempDir) {
  const bobSettings = {
    mcpServers: {
      'carbon-mcp-server': {
        command: 'npx',
        args: ['-y', 'carbon-mcp']
      }
    }
  };
  
  await fs.writeFile(
    path.join(tempDir, '.bob', 'settings.json'),
    JSON.stringify(bobSettings, null, 2)
  );
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

/**
 * Copy Carbon Builder Skill reference files into the bundle directory.
 * This makes them available at a predictable local path regardless of where
 * the agent process runs, so the agent can always read them as regular files.
 *
 * @param {string} bundleDir - Root of the temp bundle directory
 * @returns {Promise<string|null>} Destination directory path, or null if source not found
 */
async function copySkillReferences(bundleDir) {
  if (!fsSync.existsSync(SKILL_REFERENCES_SRC)) {
    console.warn(`⚠️  Carbon Builder Skill references not found at: ${SKILL_REFERENCES_SRC}`);
    return null;
  }

  const dest = path.join(bundleDir, '.bob', 'skills', 'carbon-builder', 'references');
  await copyDirectory(SKILL_REFERENCES_SRC, dest);
  return dest;
}

/**
 * Build a review bundle for agent execution
 * @param {Object} options - { owner, repo, pr, diff, files }
 * @returns {Promise<Object>} Bundle object with dir, prompt, and cleanup function
 */
async function buildReviewBundle({ owner, repo, pr, diff, files }) {
  // Create temp directory under /private/tmp (trusted by Bob Shell for MCP access).
  // os.tmpdir() resolves to /var/folders/…/T on macOS which is NOT in Bob's
  // trustedFolders.json, causing Bob to silently disable MCP tools.
  const BOB_TRUSTED_TMP = '/private/tmp';
  const tempDir = await fs.mkdtemp(
    path.join(BOB_TRUSTED_TMP, `${owner}__${repo}__pull-${pr.number}-`)
  );

  try {
    // 1. Write .env file with API key for Bob
    // Bob looks for BOBSHELL_API_KEY in .env file in current directory
    const envContent = `BOBSHELL_API_KEY=${process.env.BOBSHELL_API_KEY || ''}\n`;
    await fs.writeFile(
      path.join(tempDir, '.env'),
      envContent
    );

    // 2. Create .bob directory structure
    const bobDir = path.join(tempDir, '.bob');
    await fs.mkdir(bobDir, { recursive: true });

    // Copy Carbon Builder Skill reference files into the bundle so the agent can
    // read them at a stable local path even when MCP is unavailable.
    const skillRefDest = await copySkillReferences(tempDir);
    if (skillRefDest) {
      console.log(`✅ Skill references copied to bundle: ${skillRefDest}`);
    }

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

    // 5. Write diff (with truncation if needed per spec lines 62-67)
    let diffToWrite = diff;
    let diffTruncated = false;
    
    if (diff.length > MAX_DIFF_CHARS) {
      diffTruncated = true;
      diffToWrite = diff.substring(0, MAX_DIFF_CHARS);
      diffToWrite += '\n\n[... diff truncated due to size ...]\n';
      diffToWrite += `Original size: ${diff.length} chars, truncated to: ${MAX_DIFF_CHARS} chars\n`;
      diffToWrite += `View full diff at: https://github.com/${owner}/${repo}/pull/${pr.number}/files\n`;
    }
    
    await fs.writeFile(
      path.join(tempDir, 'diff.patch'),
      diffToWrite
    );

    // 6. Write PR review request summary
    const prSummary = `# PR Review Request

**Repository:** ${owner}/${repo}
**PR Number:** #${pr.number}
**Title:** ${pr.title}
**Author:** ${pr.user.login}
**Created:** ${pr.created_at}
**Updated:** ${pr.updated_at}

## Description

${pr.body || 'No description provided'}

## Changed Files

${files.map(f => `- \`${f.filename}\` (+${f.additions}/-${f.deletions})`).join('\n')}

## Review Instructions

Review the changes in this PR for:
- Correctness issues
- Accessibility issues
- Test coverage
- Migration concerns
- Carbon Design System compliance

See diff.patch for the full changes.
`;

    await fs.writeFile(
      path.join(tempDir, 'PR_REVIEW_REQUEST.md'),
      prSummary
    );

    // 6. Write agent rules (for all agent types)
    const rules = `# Carbon PR Review Agent Rules

You are reviewing a pull request in ${owner}/${repo}.

Mandatory:
- For Carbon-specific (Category 1) findings: read the Carbon Builder Skill reference files at .bob/skills/carbon-builder/references/ FIRST
- Use Carbon MCP tools (docs_search, code_search, get_charts) SECOND — for API-level precision or when skill files lack evidence
- Set verificationSource to "carbon-builder-skill" when skill reference files provide the supporting evidence
- Set verificationSource to "carbon-mcp" when Carbon MCP tools provide more specific evidence
- Set verificationSource to "not-carbon-specific" for generic code review findings
- Prefer specific actionable findings over general advice
- Do not edit files
- Do not run package manager install commands
- Produce only the requested JSON object and review Markdown
`;

    // Write agent rules for Bob
    const bobRulesDir = path.join(tempDir, '.bob', 'rules');
    await fs.mkdir(bobRulesDir, { recursive: true });
    await fs.writeFile(
      path.join(bobRulesDir, '01-output.md'),
      rules
    );

    // Note: carbon-mcp is configured globally via streamable HTTP in ~/.bob/settings.json
    // No local MCP config is needed in the bundle directory

    // Build the review prompt, telling it the exact local path to skill reference files
    const skillRefsAvailable = !!skillRefDest;
    const prompt = buildReviewPrompt({ owner, repo, skillRefsAvailable });

    // Return bundle object (no settingsPath needed - using global config)
    return {
      dir: tempDir,
      prompt,
      cleanup: async () => {
        try {
          await fs.rm(tempDir, { recursive: true, force: true });
        } catch (error) {
          console.error('Error cleaning up bundle:', error.message);
        }
      }
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

module.exports = { buildReviewBundle };

// Made with Bob
