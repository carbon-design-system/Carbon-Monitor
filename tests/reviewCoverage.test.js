/**
 * Offline tests for partial coverage: the diff assembled from each file's patch,
 * which whole files fit the budget, and how a partial review is told to the author.
 *
 *  1. classify, walk order (class then PR order) and the sibling rule
 *  2. Whole files only: the budget boundary, no-patch, renames, the file cap,
 *     the 3,000-file listing, and the hunk-aligned last resort
 *  3. Header synthesis, verbatim passthrough and position parity with a raw diff
 *  4. The request file (Files Not Reviewed, Changed Files, mdDiffStartLine)
 *  5. formatCoverageNote, its place in both comments, the digest line
 *  6. A whole review of a 3,000-file listing through the mock GitHub server
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
// Captured before the event service loads; it keeps the reference it finds.
const indexed = [];
require('../src/observability/esClient').esCall = async (fn) =>
  fn({ index: async (doc) => indexed.push(doc.document) });
const constants = require('../src/constants');
const { fileDiff, classify, selectCoverage } = require('../src/reviewCoverage');
const {
  parseDiffLinePositions,
  mapFindingToDiffPosition,
} = require('../src/diffMapper');
const { buildReviewBundle } = require('../src/reviewBundle');
const {
  formatCoverageNote,
  formatSummaryComment,
  formatLooksGoodComment,
  formatNotReviewedComment,
} = require('../src/reviewPrompt');
const { _buildPayload } = require('../src/slackNotifier');
const { runBatch, fileOfSize } = require('./fixtures/concurrencyHarness');

let passed = 0;
let failed = 0;

async function test(description, fn) {
  try {
    await fn();
    console.log(`  ✅ ${description}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ ${description}`);
    console.error(`     ${err.message}`);
    failed++;
  }
}

const FILES_URL = 'https://github.com/o/r/pull/7/files';
const names = (list) => list.map((e) => e.filename);
const select = (files, o = {}) =>
  selectCoverage({
    files,
    maxChars: 1e6,
    maxFiles: 300,
    filesUrl: FILES_URL,
    ...o,
  });
// A file with one patch; sized(name, n) assembles to exactly n characters.
const sized = fileOfSize;
const plain = (filename, extra = {}) => ({
  filename,
  status: 'modified',
  additions: 1,
  deletions: 0,
  changes: 1,
  patch: '@@ -1 +1 @@\n+x',
  ...extra,
});

async function main() {
  console.log('\nPartial coverage tests\n');

  await test('classify: source, tests and docs, generated; generated wins', () => {
    for (const f of [
      'src/Button.js',
      'src/Button.scss',
      'package.json',
      '.github/workflows/test.yml',
      'src/delib/x.js',
    ]) {
      assert.strictEqual(classify(f), 0, f);
    }
    for (const f of [
      'src/__tests__/Button-test.js',
      'src/__testfixtures__/a.js',
      'src/Button.test.js',
      'src/Button.spec.ts',
      'src/Button-test.js',
      'src/Button.stories.js',
      'docs/guide.md',
      'docs/guide.mdx',
      'notes.txt',
      'notes.rst',
    ]) {
      assert.strictEqual(classify(f), 1, f);
    }
    for (const f of [
      'src/__snapshots__/a.snap',
      'src/__tests__/__snapshots__/Button-test.js.snap',
      'package-lock.json',
      'packages/x/yarn.lock',
      'pnpm-lock.yaml',
      'dist/index.js',
      'packages/x/es/index.js',
      'packages/x/lib/index.js',
      'build.min.js',
      'build.min.css',
      'bundle.js.map',
    ]) {
      assert.strictEqual(classify(f), 2, f);
    }
  });

  await test('files are taken by class, then in PR order', () => {
    const r = select([
      plain('docs/README.md'),
      plain('dist/index.js'),
      plain('src/a.js'),
      plain('src/__snapshots__/a.snap'),
      plain('src/b.scss'),
      plain('notes/other.test.js'),
    ]);
    assert.deepStrictEqual(names(r.reviewed), [
      'src/a.js',
      'src/b.scss',
      'docs/README.md',
      'notes/other.test.js',
      'dist/index.js',
      'src/__snapshots__/a.snap',
    ]);
    assert.strictEqual(r.coverage.partial, false);
  });

  await test('a test or story follows its own source; others keep class order', () => {
    const r = select([
      plain('src/Button/Button.js'),
      plain('src/Tag/Tag.js'),
      plain('src/Tag/__tests__/Tag-test.js'),
      plain('src/Button/Button.stories.js'),
      plain('src/Button/__tests__/Button-test.js'),
      plain('src/Button/stories/Button.mdx'),
      plain('src/Other/Button.test.js'),
      plain('src/Tag/Tag.test.js'),
    ]);
    assert.deepStrictEqual(names(r.reviewed), [
      'src/Button/Button.js',
      'src/Button/Button.stories.js',
      'src/Button/__tests__/Button-test.js',
      'src/Button/stories/Button.mdx',
      'src/Tag/Tag.js',
      'src/Tag/__tests__/Tag-test.js',
      'src/Tag/Tag.test.js',
      'src/Other/Button.test.js',
    ]);
  });

  await test('whole files only: a file over the boundary is omitted and the walk goes on', () => {
    const a = sized('src/a.js', 600);
    const b = sized('src/b.js', 700);
    const c = sized('src/c.js', 300);
    const r = select([a, b, c], { maxChars: 1000 });
    assert.deepStrictEqual(names(r.reviewed), ['src/a.js', 'src/c.js']);
    assert.deepStrictEqual(r.omitted, [
      { filename: 'src/b.js', reason: 'over-budget' },
    ]);
    assert.strictEqual(r.diff, fileDiff(a) + fileDiff(c));
    assert.ok(!r.diff.includes('src/b.js'), 'no part of the omitted file');
    assert.ok(!r.diff.includes('truncated'));
    assert.ok(r.reviewed.every((f) => f.truncated === false));
    assert.strictEqual(r.coverage.diff_chars_reviewed, 900);
    assert.strictEqual(r.coverage.diff_chars_total, 1600);
  });

  await test('a file that fills the budget exactly is taken', () => {
    const r = select([sized('src/a.js', 400), sized('src/b.js', 600)], {
      maxChars: 1000,
    });
    assert.strictEqual(r.reviewed.length, 2);
    assert.strictEqual(r.diff.length, 1000);
    assert.strictEqual(r.coverage.partial, false);
  });

  await test('one file over the budget does not cost the others', () => {
    const r = select(
      [sized('src/huge.js', 5000), plain('src/a.js'), plain('src/b.js')],
      { maxChars: 1000 }
    );
    assert.deepStrictEqual(names(r.reviewed), ['src/a.js', 'src/b.js']);
    assert.deepStrictEqual(r.omitted, [
      { filename: 'src/huge.js', reason: 'over-budget' },
    ]);
    assert.ok(!r.diff.includes('truncated'));
    assert.strictEqual(r.coverage.files_omitted, 1);
    assert.strictEqual(r.coverage.partial, true);
  });

  await test('no patch with changes is omitted as no-patch', () => {
    const r = select([
      plain('src/a.js'),
      { filename: 'logo.png', status: 'modified', changes: 5 },
    ]);
    assert.deepStrictEqual(r.omitted, [
      { filename: 'logo.png', reason: 'no-patch' },
    ]);
    assert.deepStrictEqual(names(r.reviewed), ['src/a.js']);
    assert.strictEqual(r.coverage.partial, true);
  });

  await test('a pure rename has no patch and no changes: reviewed, nothing omitted, not partial', () => {
    const r = select([
      {
        filename: 'src/new.js',
        previous_filename: 'src/old.js',
        status: 'renamed',
        additions: 0,
        deletions: 0,
        changes: 0,
      },
      plain('src/a.js'),
    ]);
    assert.deepStrictEqual(names(r.reviewed), ['src/new.js', 'src/a.js']);
    assert.strictEqual(r.reviewed[0].chars, 0);
    assert.deepStrictEqual(r.omitted, []);
    assert.strictEqual(r.coverage.partial, false);
    assert.strictEqual(r.coverage.files_reviewed, 2);
    assert.strictEqual(r.diff, fileDiff(plain('src/a.js')));
  });

  await test('files past the cap are omitted as over-file-cap, in PR order', () => {
    const files = ['a', 'b', 'c', 'd', 'e'].map((n) => plain(`src/${n}.js`));
    const r = select(files, { maxFiles: 2 });
    assert.deepStrictEqual(names(r.reviewed), ['src/a.js', 'src/b.js']);
    assert.deepStrictEqual(r.omitted, [
      { filename: 'src/c.js', reason: 'over-file-cap' },
      { filename: 'src/d.js', reason: 'over-file-cap' },
      { filename: 'src/e.js', reason: 'over-file-cap' },
    ]);
    assert.ok(!r.diff.includes('src/c.js'));
    assert.strictEqual(r.coverage.files_omitted, 3);
    assert.strictEqual(
      r.coverage.diff_chars_total,
      5 * fileDiff(files[0]).length
    );
  });

  await test('a full 3,000-file listing counts the files beyond it', () => {
    const files = Array.from({ length: 3000 }, (_, i) => plain(`src/f${i}.js`));
    const r = select(files, { maxFiles: 5000, changedFilesTotal: 3012 });
    assert.strictEqual(r.coverage.beyond_listing, 12);
    assert.strictEqual(r.coverage.files_total, 3012);
    assert.strictEqual(r.coverage.files_reviewed, 3000);
    assert.strictEqual(r.coverage.files_omitted, 12);
    assert.strictEqual(r.coverage.partial, true);
    assert.deepStrictEqual(r.omitted, []);

    const exact = select(files, { maxFiles: 5000, changedFilesTotal: 3000 });
    assert.strictEqual(exact.coverage.beyond_listing, 0);
    assert.strictEqual(exact.coverage.partial, false);
    const short = select(files.slice(1), { changedFilesTotal: 3012 });
    assert.strictEqual(short.coverage.beyond_listing, 0, 'only a full listing');
  });

  const hunk = (n) =>
    `@@ -${n},1 +${n},1 @@\n-old${n}\n+new${n}${'y'.repeat(200)}`;
  const multi = (name) => ({
    ...plain(name),
    patch: [1, 2, 3, 4, 5].map(hunk).join('\n'),
  });

  await test('when nothing fits, the first file is cut at the last hunk that fits, with a marker', () => {
    const big = multi('src/big.js');
    const whole = fileDiff(big).length;
    const r = select([big, multi('src/next.js')], { maxChars: whole - 100 });
    assert.strictEqual(r.reviewed.length, 1);
    assert.strictEqual(r.reviewed[0].filename, 'src/big.js');
    assert.strictEqual(r.reviewed[0].truncated, true);
    assert.ok(r.diff.length <= whole - 100, `${r.diff.length} over budget`);
    assert.ok(
      r.diff.endsWith(
        `[... diff truncated: 4 of 5 hunks of src/big.js shown; the rest is at ${FILES_URL} ...]\n`
      ),
      r.diff.slice(-160)
    );
    assert.strictEqual(r.diff.match(/^@@ /gm).length, 4, 'whole hunks only');
    assert.ok(!r.diff.includes('-old5'), 'the cut hunk is gone, not clipped');
    assert.deepStrictEqual(r.omitted, [
      { filename: 'src/next.js', reason: 'over-budget' },
    ]);
    assert.strictEqual(r.coverage.partial, true);
    assert.strictEqual(r.coverage.diff_chars_reviewed, r.diff.length);
  });

  await test('the last resort skips a one-line hunk it cannot cut and cuts the next file', () => {
    const one = sized('src/one.js', 5000);
    const r = select([one, multi('src/big.js')], { maxChars: 700 });
    assert.deepStrictEqual(names(r.reviewed), ['src/big.js']);
    assert.strictEqual(r.reviewed[0].truncated, true);
    assert.ok(r.diff.length <= 700);
    assert.deepStrictEqual(r.omitted, [
      { filename: 'src/one.js', reason: 'over-budget' },
    ]);
  });

  await test('a binary with changes 0 and an empty new file have no patch; only a rename is free', () => {
    const r = select([
      { filename: 'logo.png', status: 'modified', changes: 0 },
      { filename: 'src/empty.js', status: 'added', changes: 0 },
      {
        filename: 'src/b.js',
        previous_filename: 'src/a.js',
        status: 'renamed',
        changes: 0,
      },
    ]);
    assert.deepStrictEqual(r.omitted, [
      { filename: 'logo.png', reason: 'no-patch' },
      { filename: 'src/empty.js', reason: 'no-patch' },
    ]);
    assert.deepStrictEqual(names(r.reviewed), ['src/b.js']);
  });

  const longHunk = (name, n) => ({
    ...plain(name),
    status: 'added',
    patch:
      `@@ -0,0 +1,${n} @@\n` +
      Array.from({ length: n }, (_, i) => `+line ${i} ${'z'.repeat(40)}`).join(
        '\n'
      ),
  });

  await test('when nothing fits and the file is one hunk, it is cut at the last line that fits, with a marker', () => {
    const big = longHunk('src/new.js', 60);
    const whole = fileDiff(big).length;
    const budget = whole - 500;
    const r = select([big, longHunk('src/next.js', 60)], {
      maxChars: budget,
    });
    assert.strictEqual(r.reviewed.length, 1);
    assert.strictEqual(r.reviewed[0].truncated, true);
    assert.strictEqual(r.reviewed[0].cut.unit, 'lines');
    const shown = r.reviewed[0].cut.shown;
    assert.strictEqual(r.reviewed[0].cut.total, 61, 'the @@ line and 60 lines');
    assert.ok(
      r.diff.endsWith(
        `[... diff truncated: ${shown} of 61 lines of src/new.js shown; the rest is at ${FILES_URL} ...]\n`
      ),
      r.diff.slice(-160)
    );
    assert.ok(r.diff.length <= budget);
    assert.ok(
      budget - r.diff.length < 50,
      'the cut is at the last line that fits'
    );
    assert.strictEqual(r.diff.match(/^@@ /gm).length, 1);
    // Positions before the cut are the positions in the whole diff.
    const lineMap = (d) => [
      ...parseDiffLinePositions(d).get('src/new.js').lineMap.entries(),
    ];
    assert.deepStrictEqual(
      lineMap(r.diff),
      lineMap(fileDiff(big)).slice(0, shown - 1)
    );
    assert.deepStrictEqual(r.omitted, [
      { filename: 'src/next.js', reason: 'over-budget' },
    ]);
    assert.strictEqual(r.coverage.partial, true);
  });

  await test('when not even a line fits the diff is empty and nothing is reviewed', () => {
    const r = select([sized('src/a.js', 500), longHunk('src/b.js', 60)], {
      maxChars: 100,
    });
    assert.strictEqual(r.diff, '');
    assert.deepStrictEqual(r.reviewed, []);
    assert.strictEqual(r.omitted.length, 2);
    assert.strictEqual(r.coverage.files_reviewed, 0);
    assert.strictEqual(r.coverage.diff_chars_reviewed, 0);
    assert.strictEqual(r.coverage.partial, true);
  });

  await test('a budget that is not a number is no budget; a cap that is 0 or not a number is no cap', () => {
    const files = [
      sized('src/a.js', 600),
      sized('src/b.js', 700),
      plain('src/c.js'),
    ];
    for (const maxChars of [NaN, undefined, Infinity]) {
      const r = select(files, { maxChars });
      assert.strictEqual(r.reviewed.length, 3, `maxChars ${maxChars}`);
      assert.strictEqual(r.coverage.partial, false);
    }
    for (const maxFiles of [0, NaN, undefined, -1]) {
      const r = select(files, { maxFiles });
      assert.strictEqual(r.reviewed.length, 3, `maxFiles ${maxFiles}`);
      assert.deepStrictEqual(r.omitted, []);
    }
  });

  await test('the marker never appears when something fits', () => {
    const r = select([multi('src/big.js'), plain('src/a.js')], {
      maxChars: 300,
    });
    assert.deepStrictEqual(names(r.reviewed), ['src/a.js']);
    assert.ok(!r.diff.includes('truncated'));
  });

  await test('headers are rebuilt for added, removed, renamed and modified files', () => {
    const patch = '@@ -1 +1 @@\n-a\n+b';
    const header = (status, extra = {}) =>
      fileDiff({ filename: 'src/n.js', status, patch, ...extra });
    assert.strictEqual(
      header('added'),
      `diff --git a/src/n.js b/src/n.js\nnew file mode 100644\n--- /dev/null\n+++ b/src/n.js\n${patch}\n`
    );
    assert.strictEqual(
      header('removed'),
      `diff --git a/src/n.js b/src/n.js\ndeleted file mode 100644\n--- a/src/n.js\n+++ /dev/null\n${patch}\n`
    );
    assert.strictEqual(
      header('renamed', { previous_filename: 'src/o.js' }),
      `diff --git a/src/o.js b/src/n.js\n--- a/src/o.js\n+++ b/src/n.js\n${patch}\n`
    );
    assert.strictEqual(
      header('modified'),
      `diff --git a/src/n.js b/src/n.js\n--- a/src/n.js\n+++ b/src/n.js\n${patch}\n`
    );
    for (const status of ['added', 'removed', 'renamed', 'modified']) {
      assert.ok(!/^(index|similarity|rename) /m.test(header(status)), status);
    }
    assert.strictEqual(fileDiff({ filename: 'x', status: 'added' }), '');
  });

  await test('a patch that starts with diff --git passes through verbatim', () => {
    const whole =
      'diff --git a/a.js b/a.js\nnew file mode 100644\nindex 0000000..0000000\n--- /dev/null\n+++ b/a.js\n@@ -0,0 +1 @@\n+x\n';
    assert.strictEqual(
      fileDiff({ filename: 'a.js', status: 'added', patch: whole }),
      whole
    );
    const r = select([plain('b.js'), { ...plain('a.js'), patch: whole }]);
    assert.ok(r.diff.includes(whole));
  });

  await test('positions in the assembled diff equal positions in the raw diff', () => {
    const raw = fs.readFileSync(
      path.join(__dirname, 'fixtures/diff/ailabel-two-hunks.patch'),
      'utf8'
    );
    const filename = 'packages/react/code-connect/AILabel/AILabel.figma.tsx';
    const patch = raw.slice(raw.indexOf('@@')).replace(/\n$/, '');
    const { diff } = select([{ filename, status: 'modified', patch }]);
    const maps = (d) => [
      ...parseDiffLinePositions(d).get(filename).lineMap.entries(),
    ];
    assert.ok(maps(raw).length > 10);
    assert.deepStrictEqual(maps(diff), maps(raw));

    const added = select([
      {
        filename: 'src/n.js',
        status: 'added',
        patch: '@@ -0,0 +1,2 @@\n+a\n+b',
      },
    ]).diff;
    assert.deepStrictEqual(
      [...parseDiffLinePositions(added).get('src/n.js').lineMap.entries()],
      [
        [1, 1],
        [2, 2],
      ]
    );
  });

  // ── The request file ───────────────────────────────────────────────────────
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-'));
  process.env.BOB_WORKSPACE_ROOT = path.join(tmp, 'ws');
  const pr = {
    number: 7,
    title: 'T',
    body: '',
    user: { login: 'u' },
    created_at: 'c',
    updated_at: 'u',
  };
  const bundleOf = async (files, limits = {}, extra = {}) => {
    const saved = [constants.MAX_DIFF_CHARS, constants.MAX_FILES_PER_PR];
    constants.MAX_DIFF_CHARS = limits.maxChars ?? saved[0];
    constants.MAX_FILES_PER_PR = limits.maxFiles ?? saved[1];
    try {
      const bundle = await buildReviewBundle({
        owner: 'o',
        repo: 'r',
        pr,
        files,
        agent: 'bob',
        ...extra,
      });
      const read = (f) => fs.readFileSync(path.join(bundle.dir, f), 'utf8');
      return { bundle, read };
    } finally {
      [constants.MAX_DIFF_CHARS, constants.MAX_FILES_PER_PR] = saved;
    }
  };

  await test('the request file lists reviewed files, then Files Not Reviewed, then the diff', async () => {
    const files = [
      sized('src/a.js', 600),
      sized('src/b.js', 700),
      plain('src/c.js'),
      { filename: 'logo.png', status: 'modified', changes: 0 },
      plain('src/d.js'),
    ];
    const { bundle, read } = await bundleOf(files, {
      maxChars: 1000,
      maxFiles: 2,
    });
    const md = read('PR_REVIEW_REQUEST.md');
    const section = `## Files Not Reviewed

These files belong to PR #7 but are not in this review. Do not catalogue them, and do not report a missing test, story or changelog for a file that appears here.

- \`src/b.js\` — over the diff size budget
- \`logo.png\` — no diff from GitHub (binary, mode change or too large)
- \`src/d.js\` — over the 2-file cap
`;
    assert.ok(
      md.includes(
        '## Changed Files\n\n- `src/a.js` (+1/-0)\n- `src/c.js` (+1/-0)\n\n## Files Not Reviewed'
      ),
      md
    );
    assert.ok(md.includes(section + '\n## Diff'), md);
    const at = (s) => md.indexOf(s);
    assert.ok(at('## Changed Files') < at('## Files Not Reviewed'));
    assert.ok(at('## Files Not Reviewed') < at('## Diff'));
    const changed = md.slice(
      at('## Changed Files'),
      at('## Files Not Reviewed')
    );
    assert.ok(changed.includes('`src/a.js`'));
    assert.ok(!/src\/b\.js|logo\.png|src\/d\.js/.test(changed), changed);
    assert.ok(!md.includes('diff truncated'));

    const lines = md.split('\n');
    assert.strictEqual(bundle.mdDiffStartLine, lines.indexOf('```diff') + 1);
    assert.ok(
      lines[bundle.mdDiffStartLine].startsWith('diff --git a/src/a.js')
    );
    assert.strictEqual(read('diff.patch'), bundle.diff);
    assert.strictEqual(bundle.diff, fileDiff(files[0]) + fileDiff(files[2]));
    for (const f of JSON.parse(read('files.json'))) {
      assert.ok(!('patch' in f), `${f.filename} keeps its patch in files.json`);
    }
    assert.strictEqual(JSON.parse(read('files.json')).length, files.length);
    assert.strictEqual(bundle.coverage.files_omitted, 3);
    assert.deepStrictEqual(
      bundle.coverage.omitted.map((o) => o.reason),
      ['over-budget', 'no-patch', 'over-file-cap']
    );
    await bundle.cleanup();
  });

  await test('a backtick in a file name cannot end the code span in Files Not Reviewed', async () => {
    const { bundle, read } = await bundleOf(
      [plain('src/a.js'), plain('src/we`ird.js')],
      { maxFiles: 1 }
    );
    assert.ok(
      read('PR_REVIEW_REQUEST.md').includes(
        '- `src/weird.js` — over the 1-file cap'
      )
    );
    await bundle.cleanup();
  });

  await test('a PR that fits whole has no Files Not Reviewed section', async () => {
    const { bundle, read } = await bundleOf([plain('src/a.js'), plain('b.md')]);
    const md = read('PR_REVIEW_REQUEST.md');
    assert.ok(!md.includes('Files Not Reviewed'));
    assert.ok(md.includes('- `src/a.js` (+1/-0)\n- `b.md` (+1/-0)\n\n## Diff'));
    assert.strictEqual(bundle.coverage.partial, false);
    await bundle.cleanup();
  });

  await test('a file cut by the last resort says how many hunks, and the marker is in the diff', async () => {
    const big = multi('src/big.js');
    const { bundle, read } = await bundleOf([big], {
      maxChars: fileDiff(big).length - 100,
    });
    const md = read('PR_REVIEW_REQUEST.md');
    assert.ok(md.includes('- `src/big.js` (+1/-0) (first 4 of 5 hunks)'), md);
    assert.ok(
      md.includes('[... diff truncated: 4 of 5 hunks of src/big.js shown')
    );
    assert.ok(md.includes('https://github.com/o/r/pull/7/files'));
    assert.ok(!md.includes('Files Not Reviewed'), 'nothing else was left out');
    assert.strictEqual(bundle.coverage.partial, true);
    await bundle.cleanup();
  });

  await test('a file cut inside its hunk says how many lines, and a cap of 0 lists nothing as over the cap', async () => {
    const big = longHunk('src/new.js', 60);
    const { bundle, read } = await bundleOf([big], {
      maxChars: fileDiff(big).length - 500,
    });
    const md = read('PR_REVIEW_REQUEST.md');
    assert.ok(
      /- `src\/new\.js` \(\+1\/-0\) \(first \d+ of 61 lines\)/.test(md),
      md
    );
    assert.ok(md.includes('[... diff truncated:'));
    await bundle.cleanup();

    const free = await bundleOf(
      Array.from({ length: 5 }, (_, i) => plain(`src/f${i}.js`)),
      { maxFiles: 0 }
    );
    assert.ok(
      !free.read('PR_REVIEW_REQUEST.md').includes('Files Not Reviewed')
    );
    assert.strictEqual(free.bundle.coverage.partial, false);
    await free.bundle.cleanup();
  });

  await test('the files past the 3,000-file listing are one line, and long lists are cut', async () => {
    const files = Array.from({ length: 250 }, (_, i) => plain(`src/f${i}.js`));
    const { bundle, read } = await bundleOf(
      files,
      { maxFiles: 10 },
      {
        changedFilesTotal: 3000,
      }
    );
    const md = read('PR_REVIEW_REQUEST.md');
    assert.strictEqual(md.match(/over the 10-file cap/g).length, 200);
    assert.ok(md.includes('- 40 more files not reviewed (names not listed)'));
    assert.ok(!md.includes('beyond GitHub'));
    await bundle.cleanup();

    const full = Array.from({ length: 3000 }, (_, i) => plain(`s/f${i}.js`));
    const wide = await bundleOf(
      full,
      { maxFiles: 5000 },
      {
        changedFilesTotal: 3012,
      }
    );
    assert.ok(
      wide
        .read('PR_REVIEW_REQUEST.md')
        .includes(
          "- 12 files beyond GitHub's 3,000-file listing (names unavailable)"
        )
    );
    await wide.bundle.cleanup();
  });

  await test('a finding maps to the same position in the reordered, assembled diff', async () => {
    const files = [
      sized('src/a.js', 400),
      {
        ...plain('Button.stories.js'),
        patch: '@@ -40,2 +40,3 @@\n a\n+b\n c',
      },
    ];
    const { bundle } = await bundleOf(files);
    const at = (line) =>
      mapFindingToDiffPosition(
        { file: 'Button.stories.js', line },
        bundle.diff,
        files,
        bundle.mdDiffStartLine
      );
    assert.deepStrictEqual(at(42), { path: 'Button.stories.js', position: 3 });
    // The agent counting lines of PR_REVIEW_REQUEST.md lands on the same line.
    const hunkLine = bundle.diff.split('\n').indexOf('@@ -40,2 +40,3 @@') + 1;
    assert.deepStrictEqual(at(bundle.mdDiffStartLine + hunkLine + 42), {
      path: 'Button.stories.js',
      position: 3,
    });
    await bundle.cleanup();
  });

  // ── The note, the comments, the digest ─────────────────────────────────────
  const coverage = {
    files_total: 10,
    files_reviewed: 3,
    files_omitted: 7,
    diff_chars_total: 2100000,
    diff_chars_reviewed: 410400,
    partial: true,
    beyond_listing: 3,
    omitted: [
      { filename: 'a.js', reason: 'over-budget' },
      { filename: 'b.js', reason: 'over-budget' },
      { filename: 'logo.png', reason: 'no-patch' },
      { filename: 'c.js', reason: 'over-file-cap' },
    ],
  };
  const NOTE = `> ⚠️ **Partial review:** this pull request is larger than the review budget, so not every file could be reviewed.
> 3 of 10 changed files were reviewed (410 KB of 2.1 MB of diff). Findings cover the reviewed files only;
> the full set is in the [Files changed](${FILES_URL}) tab.

<details>
<summary>Files not reviewed (7)</summary>

**Over the diff size budget (2)**
- \`a.js\`
- \`b.js\`

**No diff from GitHub, binary, mode change or too large (1)**
- \`logo.png\`

**Over the 300-file cap (1)**
- \`c.js\`

**Beyond GitHub's 3,000-file listing (3)**, names unavailable

</details>`;

  await test('formatCoverageNote renders the counts, the link and the grouped list', () => {
    assert.strictEqual(formatCoverageNote(coverage, FILES_URL), NOTE);
  });

  await test('formatCoverageNote is empty unless the review was partial', () => {
    assert.strictEqual(formatCoverageNote(null, FILES_URL), '');
    assert.strictEqual(formatCoverageNote(undefined, FILES_URL), '');
    assert.strictEqual(
      formatCoverageNote({ ...coverage, partial: false }, FILES_URL),
      ''
    );
  });

  await test('formatCoverageNote keeps groups that are empty out, and caps a long list', () => {
    const long = {
      ...coverage,
      files_omitted: 250,
      beyond_listing: 0,
      omitted: Array.from({ length: 250 }, (_, i) => ({
        filename: `f${i}.js`,
        reason: 'over-budget',
      })),
    };
    const note = formatCoverageNote(long, FILES_URL);
    assert.ok(note.includes('<summary>Files not reviewed (250)</summary>'));
    assert.ok(note.includes('**Over the diff size budget (250)**'));
    assert.ok(note.includes('- `f199.js`\n- and 50 more\n'));
    assert.ok(!note.includes('f200.js'));
    assert.ok(!/No diff|file cap|Beyond/.test(note));
    assert.ok(note.length < 10000, 'far under the 65,536-character limit');

    const cut = formatCoverageNote(
      { ...coverage, omitted: [], beyond_listing: 0, files_omitted: 0 },
      FILES_URL
    );
    assert.ok(!cut.includes('<details>'), 'no list when no names are known');
  });

  await test('the full comment puts the note after Recommendation and before the reliability note', () => {
    const body = formatSummaryComment({
      agent: 'bob',
      summaryMarkdown: 'Two sentences.',
      prNumber: 7,
      commitSha: 'abcdef1234',
      recommendation: 'suggested-improvements',
      catalogueWarning: 'No catalogue.',
      coverage,
      filesUrl: FILES_URL,
    });
    const at = (s) => body.indexOf(s);
    assert.ok(body.includes(`${NOTE}\n\n`), body);
    assert.ok(at('## Recommendation') < at('**Partial review:**'));
    assert.ok(at('**Partial review:**') < at('**Review Reliability Note:**'));
    assert.ok(at('**Partial review:**') < at('## Summary'));
    const whole = formatSummaryComment({
      agent: 'bob',
      summaryMarkdown: 'Two sentences.',
      prNumber: 7,
      commitSha: 'abcdef1234',
      coverage: { ...coverage, partial: false },
      filesUrl: FILES_URL,
    });
    assert.ok(!whole.includes('Partial review'));
  });

  await test('the quiet comment puts the note after the summary and before the nits', () => {
    const body = formatLooksGoodComment({
      agent: 'bob',
      agentName: 'IBM Bob',
      summaryMarkdown: 'Clean.',
      commitSha: 'abcdef1234',
      nitFindings: [{ title: 'Nit', file: 'a.js', line: 3 }],
      coverage,
      filesUrl: FILES_URL,
    });
    assert.strictEqual(
      body,
      `[AI agent review — Carbon grounded] · **Looks Good** · Reviewed by: IBM Bob · Commit: abcdef1\n\nClean.\n\n${NOTE}\n\n<details>\n<summary>1 optional nit</summary>\n\n- Nit — \`a.js:3\`\n\n</details>\n`
    );
    const bare = formatLooksGoodComment({
      agent: 'bob',
      agentName: 'IBM Bob',
      summaryMarkdown: 'Clean.',
      commitSha: 'abcdef1234',
      coverage,
      filesUrl: FILES_URL,
    });
    assert.ok(bare.endsWith(`Clean.\n\n${NOTE}\n`), bare);
  });

  await test('the Not Reviewed comment is a verdict line and a note that says nothing could be reviewed', () => {
    const none = {
      ...coverage,
      files_reviewed: 0,
      files_omitted: 10,
      beyond_listing: 0,
      diff_chars_reviewed: 0,
      omitted: [
        { filename: 'a.js', reason: 'over-budget' },
        { filename: 'logo.png', reason: 'no-patch' },
      ],
    };
    assert.strictEqual(
      formatNotReviewedComment({
        commitSha: 'abcdef1234',
        coverage: none,
        filesUrl: FILES_URL,
      }),
      `[AI agent review — Carbon grounded] · **Not Reviewed** · Commit: abcdef1

> ⚠️ **Partial review:** this pull request is larger than the review budget, so none of its files could be reviewed (0 of 10 changed files).
> The full set is in the [Files changed](${FILES_URL}) tab.

<details>
<summary>Files not reviewed (10)</summary>

**Over the diff size budget (1)**
- \`a.js\`

**No diff from GitHub, binary, mode change or too large (1)**
- \`logo.png\`

</details>
`
    );
  });

  await test('the digest line says how much of a partial review was covered', () => {
    const base = {
      prNumber: 7,
      prUrl: 'https://github.com/o/r/pull/7',
      findingsCount: 3,
      summary: 'Fine.',
      recommendation: 'suggested-improvements',
    };
    const text = (result) =>
      _buildPayload({ startedAt: Date.now(), repo: 'o/r', results: [result] })
        .blocks.map((b) => b.text?.text || '')
        .join('\n');
    assert.ok(
      text({
        ...base,
        coverage: { partial: true, files_reviewed: 120, files_total: 450 },
      }).includes('\n3 issues found · partial review: 120 of 450 files\n'),
      text({ ...base, coverage: { partial: true } })
    );
    assert.ok(
      text({ ...base, coverage: { partial: false } }).includes(
        '\n3 issues found\n'
      )
    );
    assert.ok(text(base).includes('\n3 issues found\n'));
    assert.ok(
      text({ prNumber: 8, prUrl: 'u', skipped: true }).includes(
        'Skipped before the review started'
      )
    );
  });

  // ── A whole review of a full listing ───────────────────────────────────────
  const wide = Array.from({ length: 3000 }, (_, i) => plain(`src/f${i}.js`));
  const batch = await runBatch({
    prNumbers: [9],
    concurrency: 1,
    fixtures: { 9: {} },
    files: { 9: wide },
    changedFiles: { 9: 3012 },
  });
  const chars = (list) => list.reduce((n, f) => n + fileDiff(f).length, 0);
  const done = indexed.find(
    (d) => d.event_type === 'pr_review_completed' && d.pr_number === 9
  );

  await test('a 3,000-file listing is reviewed, 300 files in, and the author is told about the rest', () => {
    assert.strictEqual(batch.comments(9).length, 1);
    const body = batch.comments(9)[0].body.body;
    assert.ok(
      body.includes('300 of 3,012 changed files were reviewed'),
      body.slice(0, 600)
    );
    assert.ok(body.includes('<summary>Files not reviewed (2,712)</summary>'));
    assert.ok(body.includes('**Over the 300-file cap (2,700)**'));
    assert.ok(body.includes("**Beyond GitHub's 3,000-file listing (12)**"));
    assert.ok(body.length < 65536, `${body.length} characters`);
    assert.deepStrictEqual(done.payload.coverage, {
      files_total: 3012,
      files_reviewed: 300,
      files_omitted: 2712,
      diff_chars_total: chars(wide),
      diff_chars_reviewed: chars(wide.slice(0, 300)),
      partial: true,
    });
    const result = batch.digest.results.find((r) => r.prNumber === 9);
    assert.strictEqual(result.coverage.partial, true);
    assert.strictEqual(result.coverage.files_reviewed, 300);
    assert.ok(
      !('omitted' in result.coverage),
      'the digest carries counts only'
    );
    assert.ok(!('omitted' in done.payload.coverage));
    assert.strictEqual(batch.labels(9).length, 1);
    const md = fs.readFileSync(
      path.join(batch.bundles[9].dir, 'PR_REVIEW_REQUEST.md'),
      'utf8'
    );
    assert.ok(md.includes('## Files Not Reviewed'));
    assert.ok(md.includes("- 12 files beyond GitHub's 3,000-file listing"));
  });
  await batch.cleanup();

  // Nothing fits: 100 characters cannot hold a line of the only file.
  const savedBudget = constants.MAX_DIFF_CHARS;
  constants.MAX_DIFF_CHARS = 100;
  let none;
  try {
    none = await runBatch({
      prNumbers: [10],
      concurrency: 1,
      fixtures: { 10: {} },
      files: { 10: [sized('src/big.js', 500)] },
    });
  } finally {
    constants.MAX_DIFF_CHARS = savedBudget;
  }
  await test('when nothing fits no agent runs, but the author is told and the PR is labelled', () => {
    assert.strictEqual(none.bobRuns.length, 0, 'no agent run');
    assert.strictEqual(none.reviews(10).length, 0);
    assert.strictEqual(none.comments(10).length, 1);
    const body = none.comments(10)[0].body.body;
    assert.ok(body.includes('**Not Reviewed** · Commit: sha10'), body);
    assert.ok(
      body.includes(
        'so none of its files could be reviewed (0 of 1 changed files)'
      )
    );
    assert.ok(body.includes('- `src/big.js`'));
    assert.strictEqual(none.labels(10).length, 1);
    const event = indexed.find(
      (d) => d.event_type === 'pr_review_completed' && d.pr_number === 10
    );
    assert.deepStrictEqual(event.payload.coverage, {
      files_total: 1,
      files_reviewed: 0,
      files_omitted: 1,
      diff_chars_total: 500,
      diff_chars_reviewed: 0,
      partial: true,
    });
    assert.strictEqual(event.payload.runs, 0);
    const result = none.digest.results.find((r) => r.prNumber === 10);
    assert.strictEqual(result.skipped, true);
    assert.strictEqual(result.coverage.files_reviewed, 0);
  });
  await none.cleanup();

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
