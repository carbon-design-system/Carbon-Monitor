/**
 * Diff Mapper Module
 * Maps finding locations to GitHub diff positions for inline comments
 */

/**
 * Parse unified diff to extract line mappings.
 *
 * Returns a Map of file paths to two sub-maps:
 *   lineMap     — new-file line number → GitHub diff position
 *   hunkLines   — ordered list of {diffLine, newFileStart} for each @@ hunk,
 *                 where diffLine is the 1-based line index within the diff string.
 *                 Used by the secondary lookup to convert agent-reported
 *                 PR_REVIEW_REQUEST.md absolute line numbers back to new-file lines.
 *
 * @param {string} diff - Unified diff text
 * @returns {Map} Map of file paths to { lineMap, hunkLines }
 */
function parseDiffLinePositions(diff) {
  const fileMap = new Map();

  const lines = diff.split('\n');
  let currentFile = null;
  let position = 0;
  let oldLine = 0;
  let newLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const diffLine = i + 1; // 1-based line number within the diff string

    // File header: diff --git a/path b/path
    // GitHub resets position per file; the diff --git line itself is not counted.
    // index, new file mode, deleted file mode, ---, +++ are also not counted —
    // GitHub position starts at 1 for the first @@ hunk header of each file.
    if (line.startsWith('diff --git')) {
      const match = line.match(/\sb\/(.+)$/);
      if (match) {
        currentFile = match[1];
        fileMap.set(currentFile, { lineMap: new Map(), hunkLines: [] });
        position = 0;
      }
      continue;
    }

    // Skip file metadata lines — do NOT count these in position.
    // GitHub position counting begins at the @@ hunk header, not before it.
    if (
      line.startsWith('---') ||
      line.startsWith('+++') ||
      line.startsWith('index ') ||
      line.startsWith('new file') ||
      line.startsWith('deleted file')
    ) {
      continue;
    }

    // Hunk header: @@ -old_start,old_count +new_start,new_count @@
    // This is position 1 (or the first position of a subsequent hunk).
    if (line.startsWith('@@')) {
      const match = line.match(/@@ -(\d+),?\d* \+(\d+),?\d* @@/);
      if (match) {
        oldLine = parseInt(match[1], 10);
        newLine = parseInt(match[2], 10);
      }
      position++;
      // Record this hunk's position within the diff string for secondary lookup.
      if (currentFile) {
        fileMap
          .get(currentFile)
          .hunkLines.push({ diffLine, newFileStart: newLine });
      }
      continue;
    }

    if (!currentFile) continue;

    // Increment position for this line (GitHub uses 1-based positions)
    position++;

    // Context line (unchanged)
    if (line.startsWith(' ')) {
      fileMap.get(currentFile).lineMap.set(newLine, position);
      oldLine++;
      newLine++;
    }
    // Addition line
    else if (line.startsWith('+')) {
      fileMap.get(currentFile).lineMap.set(newLine, position);
      newLine++;
    }
    // Deletion line
    else if (line.startsWith('-')) {
      oldLine++;
    }
  }

  return fileMap;
}

/**
 * Map a finding to a diff position for inline commenting.
 *
 * Primary lookup: finding.line is treated as a new-file line number and looked
 * up directly in the lineMap built by parseDiffLinePositions.
 *
 * Secondary lookup (activated when mdDiffStartLine > 0): the agent sometimes
 * reports the absolute line number within PR_REVIEW_REQUEST.md rather than the
 * new-file line number. When the primary lookup fails and mdDiffStartLine is
 * provided, we convert the reported line using:
 *   new_file_line = reported_line - (mdDiffStartLine + hunk_diffLine)
 * where hunk_diffLine is the 1-based position of the file's @@ header within
 * the diff string. We try each hunk and use the first that resolves.
 *
 * @param {Object} finding       - Finding object with file and line
 * @param {string} diff          - Unified diff text
 * @param {Array}  files         - Array of changed file objects from GitHub
 * @param {number} [mdDiffStartLine=0] - 1-based line of the ```diff fence in
 *                                       PR_REVIEW_REQUEST.md; 0 disables secondary lookup
 * @returns {Object|null} - { path, position } or null if not mappable
 */
function mapFindingToDiffPosition(finding, diff, files, mdDiffStartLine = 0) {
  // Validate finding has required fields
  if (!finding.file || !finding.line) {
    return null;
  }

  // Filter out bundle files that shouldn't have inline comments
  // Only exclude specific bundle files, not all files with these extensions
  const excludedFilenames = [
    'diff.patch',
    'pr.json',
    'files.json',
    'PR_REVIEW_REQUEST.md',
  ];

  const fileName = finding.file.split('/').pop();
  const fileExt = finding.file
    .substring(finding.file.lastIndexOf('.'))
    .toLowerCase();

  // Check if it's a bundle file or has a patch/diff extension
  if (
    excludedFilenames.includes(fileName) ||
    fileExt === '.patch' ||
    fileExt === '.diff'
  ) {
    return null;
  }

  // Check if file is in the changed files list
  // Handle both full paths and relative paths
  let changedFile = files.find((f) => f.filename === finding.file);
  let matchedFilename = finding.file;

  if (!changedFile) {
    // Try matching by basename if full path doesn't match
    const findingBasename = finding.file.split('/').pop();
    changedFile = files.find(
      (f) =>
        f.filename.endsWith(finding.file) ||
        f.filename.split('/').pop() === findingBasename
    );
    if (changedFile) {
      matchedFilename = changedFile.filename;
    } else {
      return null;
    }
  }

  // Parse diff to get line-to-position mappings
  const fileMap = parseDiffLinePositions(diff);
  const entry = fileMap.get(matchedFilename);

  if (!entry) {
    return null;
  }

  const { lineMap, hunkLines } = entry;

  // Primary lookup: finding.line as new-file line number (correct per prompt spec)
  const primaryPosition = lineMap.get(finding.line);
  if (primaryPosition) {
    return { path: matchedFilename, position: primaryPosition };
  }

  // Secondary lookup: agent reported PR_REVIEW_REQUEST.md absolute line number.
  // Convert: new_file_line = reported - (mdDiffStartLine + hunk.diffLine)
  // Try each hunk in the file; use the first that resolves in the lineMap.
  if (mdDiffStartLine > 0 && hunkLines.length > 0) {
    for (const hunk of hunkLines) {
      const newFileLine = finding.line - (mdDiffStartLine + hunk.diffLine);
      if (newFileLine > 0) {
        const secondaryPosition = lineMap.get(newFileLine);
        if (secondaryPosition) {
          return { path: matchedFilename, position: secondaryPosition };
        }
      }
    }
  }

  return null;
}

/**
 * Split findings into those that can be posted inline vs summary only
 * @param {Array}  findings         - Array of finding objects
 * @param {string} diff             - Unified diff text
 * @param {Array}  files            - Array of changed file objects
 * @param {number} [mdDiffStartLine=0] - Passed through to mapFindingToDiffPosition
 * @returns {Object} - { inlineFindings, summaryFindings }
 */
function splitFindings(findings, diff, files, mdDiffStartLine = 0) {
  const inlineFindings = [];
  const summaryFindings = [];

  for (const finding of findings) {
    const position = mapFindingToDiffPosition(
      finding,
      diff,
      files,
      mdDiffStartLine
    );

    if (position) {
      inlineFindings.push({
        ...finding,
        diffPosition: position,
      });
    } else {
      summaryFindings.push(finding);
    }
  }

  return { inlineFindings, summaryFindings };
}

module.exports = {
  parseDiffLinePositions,
  mapFindingToDiffPosition,
  splitFindings,
};
