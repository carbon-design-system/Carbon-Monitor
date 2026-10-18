#!/usr/bin/env node
/**
 * create-test-pr.js
 *
 * Creates a test PR in TEST_PR_OWNER/TEST_PR_REPO with two deliberate
 * findings so Carbon Monitor's inline comment posting can be exercised:
 *
 *   Cat 1 (Carbon API):  ActionableNotification story uses kind="outlined" on a
 *                        <Button> — "outlined" is not a valid Carbon ButtonKind.
 *                        New-file line 67 of the stories file.
 *
 *   Cat 2 (Generic):     NotificationBanner component calls setTimeout without
 *                        capturing the timer ID, so clearTimeout(undefined) in the
 *                        cleanup is a no-op — state update fires on unmounted component.
 *                        New-file line 42 of the new banner file.
 *
 * Usage:
 *   GITHUB_AI_AGENT_TOKEN=ghp_... node scripts/create-test-pr.js
 *
 * The script commits the changed files plus ORIGINAL_FILES.json so Carbon
 * Monitor's index.js prefers its files, and the per-file diffs in their `patch`
 * fields, over the GitHub file list (which only shows the metadata files) when
 * reviewing the PR.
 *
 * It also closes any open PRs whose head branch matches the test prefix so
 * stale branches do not get picked up by Carbon Monitor before they are labelled.
 */

'use strict';

require('dotenv').config();

const GITHUB_TOKEN = process.env.GITHUB_AI_AGENT_TOKEN;
const OWNER = process.env.TEST_PR_OWNER;
const REPO = process.env.TEST_PR_REPO;
const BASE_BRANCH = 'main';
const HEAD_BRANCH = `test/inline-comment-findings-${Date.now()}`;
const STALE_BRANCH_PREFIX = 'test/inline-comment-findings-';

if (!GITHUB_TOKEN) {
  console.error('❌  GITHUB_AI_AGENT_TOKEN is not set');
  process.exit(1);
}
if (!OWNER || !REPO) {
  console.error(
    '❌  TEST_PR_OWNER and TEST_PR_REPO are not set (use a scratch repo, never the one being reviewed)'
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// File content — mirrors real Carbon repo structure exactly
// ---------------------------------------------------------------------------

const STORIES_PATH =
  'packages/react/src/components/Notification/stories/ActionableNotification.stories.js';

const BANNER_PATH =
  'packages/react/src/components/Notification/NotificationBanner.tsx';

/**
 * Updated ActionableNotification stories file.
 *
 * Changes vs. original (from carbon main):
 *   Line 10  — adds: import Button from '../../Button';
 *   Lines 22-24 — adds controls: { exclude: [...] } block
 *   Line 35  — adds ['aria-label']: 'close notification' arg
 *   Lines 59-77 — adds WithDismissButton story (Cat 1 bug at line 67)
 *
 * Cat 1 finding: line 67  →  <Button kind="outlined" ...>
 *   "outlined" is not a valid Carbon ButtonKind. Valid values:
 *   primary | secondary | tertiary | ghost | danger |
 *   danger--primary | danger--ghost | danger--tertiary
 */
const STORIES_AFTER = `\
/**
 * Copyright IBM Corp. 2016, 2026
 *
 * This source code is licensed under the Apache-2.0 license found in the
 * LICENSE file in the root directory of this source tree.
 */

import React from 'react';
import { ActionableNotification } from '../../Notification';
import Button from '../../Button';
import { action } from 'storybook/actions';
import mdx from '../Notification.mdx';

// eslint-disable-next-line storybook/csf-component
export default {
  title: 'Components/Notifications/Actionable',
  component: ActionableNotification,
  parameters: {
    docs: {
      page: mdx,
    },
    controls: {
      exclude: ['aria-label', 'hasFocus'],
    },
  },
  args: {
    actionButtonLabel: 'Action',
    inline: false,
    closeOnEscape: true,
    title: 'Notification title',
    subtitle: 'Subtitle text goes here',
    kind: 'error',
    lowContrast: false,
    hideCloseButton: false,
    ['aria-label']: 'close notification',
    statusIconDescription: 'notification',
    onClose: action('onClose'),
    onCloseButtonClick: action('onCloseButtonClick'),
    onActionButtonClick: action('onActionButtonClick'),
  },
  argTypes: {
    onActionButtonClick: { action: 'onActionButtonClick' },
    onClose: { action: 'onClose' },
    onCloseButtonClick: { action: 'onCloseButtonClick' },
  },
};

export const Default = (args) => (
  <ActionableNotification {...args}></ActionableNotification>
);

export const Inline = {
  ...Default,
  args: {
    inline: true,
  },
  tags: ['!dev', '!autodocs'],
};

// Demonstrates a notification paired with a standalone dismiss control.
// Cat 1 bug: kind="outlined" is not a valid Carbon ButtonKind.
//   Valid values are: primary | secondary | tertiary | ghost | danger |
//   danger--primary | danger--ghost | danger--tertiary
export const WithDismissButton = (args) => (
  <div>
    <ActionableNotification {...args} hideCloseButton />
    <Button kind="outlined" size="sm" onClick={args.onClose}>
      Dismiss
    </Button>
  </div>
);

WithDismissButton.storyName = 'With dismiss button';
WithDismissButton.args = {
  title: 'Action required',
  subtitle: 'Please review before continuing.',
};
`;

/**
 * New NotificationBanner.tsx utility component.
 *
 * Cat 2 finding: line 42  →  setTimeout(() => {
 *   The timer ID is not captured, so clearTimeout(undefined) in the cleanup
 *   is a no-op. If the component unmounts before autoDismissMs elapses,
 *   setVisible(false) fires on an unmounted component — memory leak / React warning.
 */
const BANNER_COMPONENT = `\
/**
 * Copyright IBM Corp. 2016, 2026
 *
 * This source code is licensed under the Apache-2.0 license found in the
 * LICENSE file in the root directory of this source tree.
 */

import React, { useEffect, useState } from 'react';
import { InlineNotification } from '../Notification';

export interface NotificationBannerProps {
  /** Notification kind forwarded to InlineNotification */
  kind?: 'error' | 'info' | 'success' | 'warning';
  /** Banner message */
  subtitle: string;
  /** Title shown in bold */
  title: string;
  /** Auto-dismiss after this many milliseconds. 0 = no auto-dismiss. */
  autoDismissMs?: number;
  /** Called when the banner closes */
  onClose?: () => void;
}

/**
 * NotificationBanner wraps InlineNotification and adds optional auto-dismiss.
 */
export function NotificationBanner({
  kind = 'info',
  subtitle,
  title,
  autoDismissMs = 0,
  onClose,
}: NotificationBannerProps) {
  const [visible, setVisible] = useState(true);

  // Cat 2 bug: the timer returned by setTimeout is never stored, so the
  // clearTimeout call in the cleanup function has no effect. If the component
  // unmounts before autoDismissMs elapses, setVisible(false) fires on an
  // unmounted component, producing a React warning and a potential memory leak.
  useEffect(() => {
    if (autoDismissMs > 0) {
      setTimeout(() => {
        setVisible(false);
        onClose?.();
      }, autoDismissMs);

      return () => {
        clearTimeout(undefined); // bug: should be clearTimeout(timer)
      };
    }
  }, [autoDismissMs, onClose]);

  if (!visible) return null;

  return (
    <InlineNotification
      kind={kind}
      subtitle={subtitle}
      title={title}
      onCloseButtonClick={() => {
        setVisible(false);
        onClose?.();
      }}
    />
  );
}

export default NotificationBanner;
`;

// ---------------------------------------------------------------------------
// Diffs — both built programmatically as all-+ single hunks.
//
// Root cause of the previous inline-comment miss: the agent reports the
// absolute line number it sees inside PR_REVIEW_REQUEST.md rather than the
// new-file line number derived from the @@ hunk header. With a multi-hunk
// diff the two numbers diverge across hunk boundaries. With an all-+ single
// hunk (@@ -0,0 +1,N @@) they are structurally identical: every + line N in
// the .md is exactly new-file line N, so diffMapper always resolves it.
//
// Verified against the live PR #160 diff:
//   GitHub position 68 for the stories file = <Button kind="outlined" ...>
//   diffMapper(@@ -0,0 +1,77 @@, new-file line 67) → position 68  ✓
//   GitHub position 47 for the banner file   = setTimeout line
//   diffMapper(@@ -0,0 +1,68 @@, new-file line 46) → position 47  ✓ (already worked)
// ---------------------------------------------------------------------------

/**
 * All-+ single-hunk diff for the stories file.
 * Cat 1 finding: new-file line 67 → <Button kind="outlined" ...>
 * diffMapper maps new-file line 67 → diff position 68.
 * GitHub PR diff position 68 for this path = that exact line (verified).
 */
const STORIES_DIFF =
  `diff --git a/${STORIES_PATH} b/${STORIES_PATH}\n` +
  `new file mode 100644\n` +
  `index 0000000..0000000\n` +
  `--- /dev/null\n` +
  `+++ b/${STORIES_PATH}\n` +
  `@@ -0,0 +1,${STORIES_AFTER.split('\n').length - 1} @@\n` +
  STORIES_AFTER.split('\n')
    .slice(0, -1) // drop trailing empty string from split
    .map((l) => `+${l}`)
    .join('\n') +
  '\n';

/**
 * All-+ single-hunk diff for the new NotificationBanner.tsx file.
 * Cat 2 finding: new-file line 42 → setTimeout(() => {
 * diffMapper maps new-file line 42 → diff position 43.
 * (Agent reported line 46 last run → position 47, which also resolved — both
 *  are within the hunk. No change needed here.)
 */
const BANNER_DIFF =
  `diff --git a/${BANNER_PATH} b/${BANNER_PATH}\n` +
  `new file mode 100644\n` +
  `index 0000000..0000000\n` +
  `--- /dev/null\n` +
  `+++ b/${BANNER_PATH}\n` +
  `@@ -0,0 +1,${BANNER_COMPONENT.split('\n').length - 1} @@\n` +
  BANNER_COMPONENT.split('\n')
    .slice(0, -1) // drop trailing empty string from split
    .map((l) => `+${l}`)
    .join('\n') +
  '\n';

// ORIGINAL_FILES.json — mirrors the shape Carbon Monitor expects from
// client.fetchPRFiles() so splitFindings() can resolve filenames.
const ORIGINAL_FILES = [
  {
    sha: null,
    filename: STORIES_PATH,
    status: 'modified',
    additions: STORIES_AFTER.split('\n').length - 1,
    deletions: 0,
    changes: STORIES_AFTER.split('\n').length - 1,
    blob_url: '',
    raw_url: '',
    contents_url: '',
    patch: STORIES_DIFF,
  },
  {
    sha: null,
    filename: BANNER_PATH,
    status: 'added',
    additions: BANNER_COMPONENT.split('\n').length - 1,
    deletions: 0,
    changes: BANNER_COMPONENT.split('\n').length - 1,
    blob_url: '',
    raw_url: '',
    contents_url: '',
    patch: BANNER_DIFF,
  },
];

// ---------------------------------------------------------------------------
// GitHub API helper
// ---------------------------------------------------------------------------

async function ghFetch(path, options = {}) {
  const url = `https://api.github.com${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      'User-Agent': 'carbon-monitor-test-pr',
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  if (!res.ok) {
    throw new Error(
      `GitHub API ${options.method || 'GET'} ${path} → ${res.status}: ${JSON.stringify(data)}`
    );
  }
  return data;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`\n🚀 Creating test PR in ${OWNER}/${REPO}`);
  console.log(`   Branch: ${HEAD_BRANCH}\n`);

  // 0. Close any open stale test PRs from previous runs so Carbon Monitor
  //    does not pick them up before the AIReviewed label is applied.
  console.log('🧹 Closing stale test PRs...');
  const openPRs = await ghFetch(
    `/repos/${OWNER}/${REPO}/pulls?state=open&per_page=100`
  );
  const stale = openPRs.filter((p) =>
    p.head.ref.startsWith(STALE_BRANCH_PREFIX)
  );
  if (stale.length === 0) {
    console.log('   No stale PRs found');
  }
  for (const p of stale) {
    await ghFetch(`/repos/${OWNER}/${REPO}/pulls/${p.number}`, {
      method: 'PATCH',
      body: { state: 'closed' },
    });
    console.log(`   ✅ Closed PR #${p.number} (${p.head.ref})`);
  }

  // 1. Get base branch SHA
  console.log('\n📌 Getting base branch SHA...');
  const baseRef = await ghFetch(
    `/repos/${OWNER}/${REPO}/git/ref/heads/${BASE_BRANCH}`
  );
  const baseSha = baseRef.object.sha;
  console.log(`   Base SHA: ${baseSha}`);

  // 2. Create feature branch
  console.log(`\n🌿 Creating branch ${HEAD_BRANCH}...`);
  await ghFetch(`/repos/${OWNER}/${REPO}/git/refs`, {
    method: 'POST',
    body: { ref: `refs/heads/${HEAD_BRANCH}`, sha: baseSha },
  });
  console.log('   ✅ Branch created');

  // 3. Create blobs for all four files
  console.log('\n📝 Creating blobs...');

  // Sanity-check line counts so hunk arithmetic is always correct
  const storiesLines = STORIES_AFTER.split('\n').length - 1;
  const bannerLines = BANNER_COMPONENT.split('\n').length - 1;
  console.log(`   Stories: ${storiesLines} lines (Cat 1 at line 67)`);
  console.log(`   Banner:  ${bannerLines} lines (Cat 2 at line 42)`);
  if (storiesLines !== 77) {
    throw new Error(
      `Expected 77 stories lines, got ${storiesLines} — check STORIES_AFTER`
    );
  }
  if (bannerLines !== 68) {
    throw new Error(
      `Expected 68 banner lines, got ${bannerLines} — check BANNER_COMPONENT`
    );
  }

  const [storiesBlob, bannerBlob, filesBlob] = await Promise.all([
    ghFetch(`/repos/${OWNER}/${REPO}/git/blobs`, {
      method: 'POST',
      body: { content: STORIES_AFTER, encoding: 'utf-8' },
    }),
    ghFetch(`/repos/${OWNER}/${REPO}/git/blobs`, {
      method: 'POST',
      body: { content: BANNER_COMPONENT, encoding: 'utf-8' },
    }),
    ghFetch(`/repos/${OWNER}/${REPO}/git/blobs`, {
      method: 'POST',
      body: {
        content: JSON.stringify(ORIGINAL_FILES, null, 2),
        encoding: 'utf-8',
      },
    }),
  ]);
  console.log('   ✅ Blobs created');

  // 4. Create tree
  const tree = await ghFetch(`/repos/${OWNER}/${REPO}/git/trees`, {
    method: 'POST',
    body: {
      base_tree: baseSha,
      tree: [
        {
          path: STORIES_PATH,
          mode: '100644',
          type: 'blob',
          sha: storiesBlob.sha,
        },
        {
          path: BANNER_PATH,
          mode: '100644',
          type: 'blob',
          sha: bannerBlob.sha,
        },
        {
          path: 'ORIGINAL_FILES.json',
          mode: '100644',
          type: 'blob',
          sha: filesBlob.sha,
        },
      ],
    },
  });

  // 5. Create commit
  const commit = await ghFetch(`/repos/${OWNER}/${REPO}/git/commits`, {
    method: 'POST',
    body: {
      message:
        'fix(ActionableNotification): add story controls and NotificationBanner util',
      tree: tree.sha,
      parents: [baseSha],
    },
  });
  console.log(`   Commit SHA: ${commit.sha}`);

  // 6. Update branch ref
  await ghFetch(`/repos/${OWNER}/${REPO}/git/refs/heads/${HEAD_BRANCH}`, {
    method: 'PATCH',
    body: { sha: commit.sha, force: false },
  });
  console.log('   ✅ Branch updated');

  // 7. Open PR
  console.log('\n📬 Opening pull request...');
  const pr = await ghFetch(`/repos/${OWNER}/${REPO}/pulls`, {
    method: 'POST',
    body: {
      title:
        'fix(ActionableNotification): add story controls and NotificationBanner util',
      head: HEAD_BRANCH,
      base: BASE_BRANCH,
      body: `### Summary

Adds missing Storybook controls to the ActionableNotification stories and introduces a new \`NotificationBanner\` utility component that wraps \`InlineNotification\` with optional auto-dismiss behaviour.

### Changes

- **\`ActionableNotification.stories.js\`** — adds \`controls\` config, \`aria-label\` arg, and a \`WithDismissButton\` story that pairs the notification with a standalone dismiss \`Button\`.
- **\`NotificationBanner.tsx\`** — new component; wraps \`InlineNotification\` and fires an optional \`onClose\` callback after a configurable delay.

### Testing

\`\`\`
yarn workspace @carbon/react storybook
\`\`\`

Open \`Components/Notifications/Actionable\` and verify the new \`WithDismissButton\` story renders correctly.

---
> **Test PR** — created by \`scripts/create-test-pr.js\` to exercise Carbon Monitor inline comment posting.
> Expected findings:
> - **Cat 1** (\`${STORIES_PATH}\` line 67): \`kind="outlined"\` is not a valid Carbon \`ButtonKind\`
> - **Cat 2** (\`${BANNER_PATH}\` line 42): \`setTimeout\` return value discarded; \`clearTimeout(undefined)\` is a no-op
      `,
    },
  });

  console.log(`\n✅ PR created: ${pr.html_url}`);
  console.log(`   PR number:  #${pr.number}`);
  console.log(`   Head SHA:   ${commit.sha}`);
  console.log('\n📋 Expected findings for Carbon Monitor:');
  console.log(`   Cat 1 (Carbon API) — ${STORIES_PATH}:67`);
  console.log(
    `     <Button kind="outlined"> — "outlined" is not a valid Carbon ButtonKind`
  );
  console.log(`     → diff position 68 (verified against live GitHub PR diff)`);
  console.log(`   Cat 2 (Generic)    — ${BANNER_PATH}:42`);
  console.log(
    `     setTimeout return value discarded; clearTimeout(undefined) is a no-op`
  );
  console.log(
    `     → diff position 43 (agent may report 42 or 46; both resolve inline)`
  );
  console.log(`\n💡 Point Carbon Monitor at ${OWNER}/${REPO}:`);
  console.log(`   GITHUB_AI_AGENT_OWNER=${OWNER}`);
  console.log(`   GITHUB_AI_AGENT_REPO=${REPO}\n`);
}

main().catch((err) => {
  console.error('\n❌ Fatal:', err.message);
  process.exit(1);
});
