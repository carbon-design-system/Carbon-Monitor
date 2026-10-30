'use strict';

// Profile registry. A profile is a set of overrides applied on top of the core
// review pipeline. The core profile (default, empty string, or 'core') takes
// every existing code path unchanged. A non-core profile is purely additive.

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

const PROFILES = { core: CORE, caic: CAIC };

/**
 * Resolve the active profile.
 *
 * @param {string} agentId - The agent id (e.g. 'bob', 'claude').
 * @returns {{ id: string, extraSkills: Array }}
 * @throws if REVIEW_PROFILE is set to an unknown value, or if 'caic' is used
 *         with a non-Bob agent, or if the caic skill files are missing.
 */
function resolve(agentId) {
  const raw = process.env.REVIEW_PROFILE || 'core';
  const id = raw === '' ? 'core' : raw;

  const profile = PROFILES[id];
  if (!profile) {
    throw new Error(
      `Unknown REVIEW_PROFILE "${raw}". Valid values: ${Object.keys(PROFILES).join(', ')}.`
    );
  }

  if (id === 'caic' && agentId !== 'bob') {
    throw new Error(
      `REVIEW_PROFILE=caic requires GITHUB_AI_AGENT_CLI=bob (got "${agentId}"). ` +
        'The caic profile supports Bob only.'
    );
  }

  if (id === 'caic') {
    // Fail fast if the skill directory is missing so the error is loud rather
    // than silent (the Dockerfile warns about silent-loss at build time).
    const fs = require('fs');
    const path = require('path');
    const skillDir = path.join(
      __dirname,
      'caic',
      'skills',
      'caic-pr-review',
      'SKILL.md'
    );
    if (!fs.existsSync(skillDir)) {
      throw new Error(
        'REVIEW_PROFILE=caic: caic-pr-review skill is missing at ' +
          `src/profiles/caic/skills/caic-pr-review/SKILL.md. ` +
          'Run the build or check the Dockerfile copy step.'
      );
    }
  }

  return profile;
}

module.exports = { resolve, CORE, CAIC };
