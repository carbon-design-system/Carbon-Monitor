#!/usr/bin/env node
'use strict';
// evals/caic/run-one.js
//
// Reviews one PR in the scratch repo with the chosen profile. The runner spawns
// this; run it by hand the same way:
//   node evals/caic/run-one.js --profile caic --pr 12

require('../../src/loadEnv');

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

const profile = flag('--profile') || 'core';
const number = Number(flag('--pr'));

if (!['core', 'caic'].includes(profile) || !Number.isSafeInteger(number)) {
  console.error(
    'Usage: node evals/caic/run-one.js --profile core|caic --pr <n>'
  );
  process.exit(1);
}

const profiles = require('../../src/profiles');
// constants.js applies the plural-variable precedence and throws on a bad list.
const { GITHUB_REPOS } = require('../../src/constants');

if (GITHUB_REPOS.length !== 1) {
  console.error(
    `The eval reviews one scratch repo, but the target list is: ${GITHUB_REPOS.join(', ')}.`
  );
  process.exit(1);
}

const repo = GITHUB_REPOS[0];
if (profile === 'caic') profiles.BY_REPO[repo] = profiles.CAIC;

const { reviewPRs } = require('../../src/index');

reviewPRs({ prs: [{ repo, number }] }).catch((err) => {
  console.error(err.message);
  process.exit(1);
});
