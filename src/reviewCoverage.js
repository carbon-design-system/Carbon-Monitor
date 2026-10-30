/**
 * Review Coverage Module
 * Assembles the diff the agent sees from each file's `patch` and decides which
 * whole files fit the budget. Pure: no I/O, no environment reads.
 */

// GitHub stops listing a PR's files here, so the rest have no names.
const LISTING_LIMIT = 3000;
// Names listed in the request file and the PR comment; the rest are counted. A comment over
// 65,536 characters is rejected by GitHub, and the request file's list is input the budget does not cover.
const MAX_LISTED_FILES = 200;

const GENERATED =
  /(^|\/)(__snapshots__|dist|es|lib)\/|\.(snap|map)$|\.min\.(js|css)$|(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb|Cargo\.lock|Gemfile\.lock|composer\.lock|poetry\.lock|go\.sum)$/;
const SUPPORT =
  /(^|\/)(__tests__|__testfixtures__)\/|\.test\.|\.spec\.|-test\.|\.stories\.|\.(md|mdx|txt|rst)$/;

/**
 * The unified-diff text for one file. A `patch` that already begins with
 * `diff --git` passes through; otherwise the headers GitHub's `.diff` carries
 * are rebuilt, minus index, similarity and rename lines the mapper ignores.
 * @param {Object} file - A pulls.listFiles entry
 * @returns {string} Empty when the file has no patch; otherwise ends in a newline
 */
function fileDiff(file) {
  const patch = file.patch;
  if (typeof patch !== 'string' || patch === '') return '';
  const body = patch.endsWith('\n') ? patch : `${patch}\n`;
  if (patch.startsWith('diff --git')) return body;

  const from = file.previous_filename || file.filename;
  const headers = [`diff --git a/${from} b/${file.filename}`];
  if (file.status === 'added') headers.push('new file mode 100644');
  if (file.status === 'removed') headers.push('deleted file mode 100644');
  headers.push(file.status === 'added' ? '--- /dev/null' : `--- a/${from}`);
  headers.push(
    file.status === 'removed' ? '+++ /dev/null' : `+++ b/${file.filename}`
  );
  return `${headers.join('\n')}\n${body}`;
}

/**
 * 0 source, config and style; 1 tests, stories and docs; 2 generated.
 * Generated wins, so a snapshot under __tests__ is class 2.
 * @param {string} filename
 * @param {{ generated?: RegExp, support?: RegExp }} [extra] - Optional extra patterns (caic profile).
 * @returns {0|1|2}
 */
function classify(filename, extra) {
  if (GENERATED.test(filename)) return 2;
  if (extra && extra.generated && extra.generated.test(filename)) return 2;
  if (SUPPORT.test(filename)) return 1;
  if (extra && extra.support && extra.support.test(filename)) return 1;
  return 0;
}

function splitPath(filename) {
  const slash = filename.lastIndexOf('/');
  return {
    dir: slash === -1 ? '' : filename.slice(0, slash),
    base: filename.slice(slash + 1),
  };
}

// Button.js, Button.test.js, Button-test.js and Button.stories.js all have the stem "Button".
function stemOf(base) {
  return base
    .replace(/\.[^.]+$/, '')
    .replace(/(\.test|\.spec|\.stories|-test)$/, '');
}

// A test or story may sit beside its source or in a __tests__ or stories child.
function sourceDirsFor(dir) {
  const { dir: parent, base } = splitPath(dir);
  return base === '__tests__' || base === 'stories' ? [dir, parent] : [dir];
}

/**
 * Class 0 files in PR order, each followed by its class 1 siblings so the
 * agent sees a source with its test; then the other class 1 files, then class 2.
 * @returns {number[]} Indexes into `files`
 */
function walkOrder(files, classes) {
  const sourceAt = new Map();
  files.forEach((f, i) => {
    if (classes[i] !== 0) return;
    const { dir, base } = splitPath(f.filename);
    const key = `${dir}\0${stemOf(base)}`;
    if (!sourceAt.has(key)) sourceAt.set(key, i);
  });

  const siblings = new Map();
  const placed = new Set();
  files.forEach((f, i) => {
    if (classes[i] !== 1) return;
    const { dir, base } = splitPath(f.filename);
    for (const d of sourceDirsFor(dir)) {
      const source = sourceAt.get(`${d}\0${stemOf(base)}`);
      if (source !== undefined) {
        if (!siblings.has(source)) siblings.set(source, []);
        siblings.get(source).push(i);
        placed.add(i);
        break;
      }
    }
  });

  const order = [];
  files.forEach((f, i) => {
    if (classes[i] !== 0) return;
    order.push(i, ...(siblings.get(i) || []));
  });
  files.forEach((f, i) => {
    if (classes[i] === 1 && !placed.has(i)) order.push(i);
  });
  files.forEach((f, i) => {
    if (classes[i] === 2) order.push(i);
  });
  return order;
}

// Header lines, then each hunk from its @@ line; the first @@ is never inside content.
function splitHunks(text) {
  const lines = text.split('\n');
  const first = lines.findIndex((l) => l.startsWith('@@'));
  if (first === -1) return { header: text, hunks: [] };
  const hunks = [];
  for (const line of lines.slice(first)) {
    if (line.startsWith('@@')) hunks.push([]);
    hunks[hunks.length - 1].push(line);
  }
  return {
    header: lines.slice(0, first).join('\n') + '\n',
    // The last split element is the empty string after the final newline.
    hunks: hunks.map((h, i) =>
      i === hunks.length - 1
        ? h.slice(0, -1).join('\n') + '\n'
        : h.join('\n') + '\n'
    ),
  };
}

// What of one over-budget file fits: its leading whole hunks, else the first hunk cut
// at a line. Positions before the cut stay valid because they count from the first @@.
function cutFile(file, text, room, filesUrl) {
  const { header, hunks } = splitHunks(text);
  if (hunks.length === 0) return null;
  const tail = `; the rest is at ${filesUrl} ...]\n`;
  for (let shown = hunks.length - 1; shown >= 1; shown--) {
    const marker = `[... diff truncated: ${shown} of ${hunks.length} hunks of ${file.filename} shown${tail}`;
    const cut = header + hunks.slice(0, shown).join('') + marker;
    if (cut.length <= room) {
      return { text: cut, cut: { unit: 'hunks', shown, total: hunks.length } };
    }
  }

  const lines = hunks[0].split('\n').slice(0, -1);
  const total = hunks.reduce((n, h) => n + h.split('\n').length - 1, 0);
  let size = header.length + lines[0].length + 1;
  let best = 0;
  // At least the @@ line and one line under it; the hunk is cut, never whole.
  for (let k = 2; k < lines.length; k++) {
    size += lines[k - 1].length + 1;
    const marker = `[... diff truncated: ${k} of ${total} lines of ${file.filename} shown${tail}`;
    if (size + marker.length > room) break;
    best = k;
  }
  if (best === 0) return null;
  const marker = `[... diff truncated: ${best} of ${total} lines of ${file.filename} shown${tail}`;
  return {
    text: header + lines.slice(0, best).join('\n') + '\n' + marker,
    cut: { unit: 'lines', shown: best, total },
  };
}

/**
 * Choose the files a review includes and assemble their diff.
 *
 * @param {Object} options
 * @param {Array}  options.files               - pulls.listFiles entries
 * @param {number} options.maxChars            - Diff character budget; not a finite number means none
 * @param {number} options.maxFiles            - Most files in one review; not a positive number means none
 * @param {string} [options.filesUrl]          - The PR's Files changed URL, named in a truncation marker
 * @param {number} [options.changedFilesTotal] - GitHub's changed_files, read when the listing is full
 * @param {{ generated?: RegExp, support?: RegExp }} [options.extraPatterns] - Optional extra classify patterns (caic profile).
 * @returns {{diff: string, reviewed: Array, omitted: Array, coverage: Object}}
 */
function selectCoverage({
  files,
  maxChars,
  maxFiles,
  filesUrl = 'the Files changed tab',
  changedFilesTotal,
  extraPatterns,
}) {
  const texts = files.map(fileDiff);
  const classes = files.map((f) => classify(f.filename, extraPatterns));
  const changesOf = (f) => f.changes ?? (f.additions || 0) + (f.deletions || 0);
  // A mistyped budget or cap (NaN) or a cap of 0 means none, as the old code skipped truncation on NaN.
  const budget = Number.isFinite(maxChars) ? maxChars : Infinity;
  const cap = Number.isFinite(maxFiles) && maxFiles > 0 ? maxFiles : Infinity;

  let used = 0;
  const kept = [];
  const dropped = [];
  for (const i of walkOrder(files, classes)) {
    const chars = texts[i].length;
    if (chars === 0) {
      // Only a pure rename has nothing to show. GitHub sends no patch for a binary,
      // a mode change or a very large file, and may report those with changes 0.
      if (files[i].status === 'renamed' && changesOf(files[i]) === 0) {
        kept.push({ i, chars: 0, text: '', truncated: false });
      } else {
        dropped.push({ i, reason: 'no-patch' });
      }
    } else if (used + chars <= budget) {
      used += chars;
      kept.push({ i, chars, text: texts[i], truncated: false });
    } else {
      dropped.push({ i, reason: 'over-budget' });
    }
  }

  // Only when nothing fits: show the head of the first file that can be cut rather than an
  // empty diff. If not even a line fits, the diff stays empty and the caller runs no agent.
  if (!kept.some((k) => k.chars > 0)) {
    for (const c of dropped.filter((d) => d.reason === 'over-budget')) {
      const part = cutFile(files[c.i], texts[c.i], budget, filesUrl);
      if (!part) continue;
      dropped.splice(dropped.indexOf(c), 1);
      kept.unshift({
        i: c.i,
        chars: part.text.length,
        text: part.text,
        truncated: true,
        cut: part.cut,
      });
      break;
    }
  }

  const capped = kept.splice(cap);
  for (const k of capped) dropped.push({ i: k.i, reason: 'over-file-cap' });
  dropped.sort((a, b) => a.i - b.i);

  const reviewed = kept.map((k) => ({
    filename: files[k.i].filename,
    chars: k.chars,
    truncated: k.truncated,
    ...(k.truncated ? { cut: k.cut } : {}),
  }));
  const omitted = dropped.map((d) => ({
    filename: files[d.i].filename,
    reason: d.reason,
  }));

  const beyondListing =
    files.length === LISTING_LIMIT && changedFilesTotal > LISTING_LIMIT
      ? changedFilesTotal - LISTING_LIMIT
      : 0;
  const filesOmitted = omitted.length + beyondListing;

  return {
    diff: kept.map((k) => k.text).join(''),
    reviewed,
    omitted,
    coverage: {
      files_total: files.length + beyondListing,
      files_reviewed: reviewed.length,
      files_omitted: filesOmitted,
      diff_chars_total: texts.reduce((n, t) => n + t.length, 0),
      diff_chars_reviewed: reviewed.reduce((n, r) => n + r.chars, 0),
      partial: filesOmitted > 0 || reviewed.some((r) => r.truncated),
      beyond_listing: beyondListing,
    },
  };
}

module.exports = {
  fileDiff,
  classify,
  selectCoverage,
  LISTING_LIMIT,
  MAX_LISTED_FILES,
};
