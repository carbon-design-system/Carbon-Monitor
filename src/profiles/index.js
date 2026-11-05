'use strict';

// Profile registry. A profile is a set of overrides applied on top of the core
// review pipeline. The core profile takes every existing code path unchanged.
// A non-core profile is purely additive. A repo's profile is chosen by its name.

const fs = require('fs');
const path = require('path');

const CORE = { id: 'core', extraSkills: [] };

// Caic extra coverage patterns. Generated: es-custom/, storybook-static/,
// storybook-react-static/, custom-elements.json, telemetry.yml.
// Support: *_spec.ts(x) files and /tests/ directories.
const CAIC_EXTRA_PATTERNS = {
  generated:
    /(^|\/)((dist\/)?es-custom|storybook-static|storybook-react-static)\/|(^|\/)custom-elements\.json$|(^|\/)telemetry\.yml$/,
  support: /_spec\.tsx?$|(^|\/)tests\//,
};

const CAIC = {
  id: 'caic',
  // Summary comment header — SPEC §5 "Header: [AI agent review - CAIC]"
  headerLabel: 'AI agent review - CAIC',
  // Extra coverage patterns applied by buildReviewBundle/selectCoverage.
  extraPatterns: CAIC_EXTRA_PATTERNS,
  // Extra skills copied into the bundle's .bob/skills/ alongside carbon-builder.
  extraSkills: [
    {
      name: 'caic-pr-review',
      source: path.join(__dirname, 'caic', 'skills', 'caic-pr-review'),
    },
  ],
  // Prompt builder — called from buildReviewPrompt when profile.id === 'caic'.
  buildPrompt: require('./caic/prompt').buildCaicPrompt,
  // showCarbonVerification: function(review) → bool.
  // The "Carbon verification:" summary line appears only when at least one Cat 1
  // finding is present. This overrides the static default (true) in reviewPrompt.
  showCarbonVerification(review) {
    if (!review || !Array.isArray(review.findings)) return false;
    return review.findings.some(
      (f) => f.verificationSource !== 'not-carbon-specific'
    );
  },
};

// Mutable on purpose: the eval wrapper maps its scratch repo to a profile.
const BY_REPO = { 'carbon-ai-chat': CAIC };

/** The profile for a repo name; any repo not listed is core. */
function forRepo(repo) {
  return Object.hasOwn(BY_REPO, repo) ? BY_REPO[repo] : CORE;
}

/** Throws when a listed repo's profile cannot run with this agent. */
function checkRepos(repos, agentId) {
  for (const repo of repos) {
    if (forRepo(repo) !== CAIC) continue;

    if (agentId !== 'bob') {
      throw new Error(
        `${repo} uses the caic profile, which runs on Bob only (GITHUB_AI_AGENT_CLI is "${agentId}").`
      );
    }

    // A missing skill must fail loudly; the Dockerfile only warns at build time.
    const skillFile = path.join(
      __dirname,
      'caic',
      'skills',
      'caic-pr-review',
      'SKILL.md'
    );
    if (!fs.existsSync(skillFile)) {
      throw new Error(
        `${repo} uses the caic profile, but the caic-pr-review skill is missing at ` +
          'src/profiles/caic/skills/caic-pr-review/SKILL.md. ' +
          'Run the build or check the Dockerfile copy step.'
      );
    }
  }
}

module.exports = { forRepo, checkRepos, BY_REPO, CORE, CAIC };
