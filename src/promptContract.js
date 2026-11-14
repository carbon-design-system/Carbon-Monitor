'use strict';

// Output contract text every profile prompt includes verbatim, so the parser and
// renderer see the same fields whichever profile wrote the review. Kept out of
// reviewPrompt.js because profile prompt builders cannot require it back.

const SHARED_OUTPUT_CONTRACT = Object.freeze({
  // Item 6 of the "read before starting" list: an agent that goes looking for a checkout walks the whole disk
  noFilesystem:
    'Do not search the filesystem or read anything outside this directory (no `find`, `locate` or `grep -r` beyond it). This bundle is not a checkout and has no node_modules, so a repository path that is missing here does not exist for this review; use PR_REVIEW_REQUEST.md, Carbon MCP and the `carbon-builder` skill as you do now.',
  // Follows the profile's own body field rule
  fixFieldRule:
    "**fix field rule:** For findings of severity `blocking` or `major`, add `fix`: a JSON array of strings, one code line per element. Write a surgical fix that is the smallest change that resolves the finding, at the lines quoted. Don't make unecesseary changes, or add prose. The lines must be a drop-in replacement for the code at the finding's `line`, keeping its indentation. If the proper fix needs code outside the diff (for example an import at the top of a file not shown), write only the visible part and keep the explanation in `body`. Omit `fix` for `minor` and `nit` findings. The body rule above still applies in full.",
  // The summary comment renders counts from the findings, so the model's would duplicate or contradict them
  noFindingCount:
    'Do not state how many findings there are or list them by severity; the harness renders that.',
  // Last field of a finding in the JSON schema block, indented by the caller
  fixSchemaLine:
    '"fix": ["replacement code line", "next replacement code line"]  ← blocking and major only: drop-in replacement for the code at line, one line per element; omit for minor and nit',
});

module.exports = { SHARED_OUTPUT_CONTRACT };
