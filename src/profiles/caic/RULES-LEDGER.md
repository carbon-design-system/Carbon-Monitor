# Rule Ledger — `caic-pr-review` skill

Rules distilled for the `caic-pr-review` skill and the caic prompt (`prompt.js`).
Every rule carries its upstream source document. The skill and the prompt carry
the same rules; this ledger says where each came from and what was left out.

**Upstream repo:** `carbon-design-system/carbon-ai-chat`
**Upstream commit pinned:** `75dada3856a718fe8022ef36bd195f17212e563a`
**Previous pin:** `88dddbd425c9fdd5eb1520c521d914a36809dbb5`
**Docs read:** `.claude/skills/caic-review/SKILL.md`,
`.claude/skills/caic-review/references/{evaluating-changes,large-diffs,repo-checks,review-passes,reviewing-a-pr,writing-findings}.md`,
`.claude/skills/caic-copy-writer/references/review-comments.md`,
`references/{accessibility,code-patterns,conventions,definition-of-done,measuring,pr-reviewability}.md`,
`AGENTS.md`, `packages/ai-chat/AGENTS.md`, `packages/ai-chat-components/AGENTS.md`

Upstream moved its skills from `.agents/` to `.claude/` between the two pins.
Paths below are relative to the upstream repo root.

---

## Re-distilling

1. Download the files in **Docs read** at the new commit and at the pin; diff them.
2. Record every new, changed or removed rule under **Drift**, with file and section, and say whether it was adopted.
3. Update the rules in `SKILL.md` and `prompt.js` together, then this ledger, then the pin in all three places: this file, the two comments at the top of `SKILL.md`, and `upstreamCommit` in `evals/caic/manifest.json`.
4. Run `node tests/caicSummary.test.js`, `node tests/caicBundle.test.js`, `node tests/caicParser.test.js`, `node tests/profile.test.js` and `npm run test:all`.
5. Add an eval to `evals/caic/manifest.json` for each new rule a PR can show. Do not run the evals without the maintainer's go-ahead.

---

## Drift since the previous pin

Files with a copy at both pins: `caic-review/SKILL.md`, `accessibility.md`,
`code-patterns.md`, `definition-of-done.md`, `measuring.md`,
`pr-reviewability.md` and the two package `AGENTS.md` files. The other files were
read at the new pin only, so "new" below means new to this ledger, not
necessarily new upstream. `references/authoring-agents-md.md` and
`packages/ai-chat/src/types/AGENTS.md` were listed in the previous ledger but
no rule cited them; they are not read here. `tone.md`, `caic-copy-writer/SKILL.md`,
`revision-pass.md` and `commit-bodies.md` are linked upstream but were not read,
so copy findings stay as conservative as before (D1–D3 evals).

### Changed

- **Severity is rated by cost** (`caic-review/SKILL.md` §How to review). Blocker was "must fix: bug, regression, security issue, broken build/tests, violated repo convention, accidental edit to generated output". It is now "something ships broken or a commitment breaks", and "violated repo convention" is gone. Important was "should fix: unclear naming, missing test, unhandled edge case, scope creep". It is now "nothing ships broken, but someone pays later". Adopted: Section 11 (V1–V6).
- **"A convention break costs what its consequence costs. It is not a Blocker by default"** (same section). New. Adopted as V6. N1, N2 and G1 state a consequence (broken `es-custom` output, edited generated files). L2 does not; see Q8.
- **Weakened proofs are graded** (`caic-review/references/evaluating-changes.md` §Test coverage). Blocker when the weakened proof covers behavior the diff changes, Important otherwise. T1–T3 were a flat Blocker. Adopted; this moves the A9 eval from `blocking` to `major`.
- **PR size is Important, not Blocker** (`caic-review/references/large-diffs.md` §Size is a finding: "say so as **Important**"). `references/pr-reviewability.md` names no severity for its bands ("Split by default, or explain why the change stays together"); the previous ledger's Z3 "Blocker" was its own. Z3 is now `major`. This moves the C3 eval from `blocking` to `major`.
- **Size counting** (`references/measuring.md` §Measuring PR size). The table counts additions plus deletions, excludes generated, snapshot, fixture, test-case, `examples/`, `demo/` and docs files, and counts shared test infrastructure. No textual change between the pins in `pr-reviewability.md` or the table; the previous Z4 exclusion list was shorter than the table. Aligned (Z1–Z4).
- **Generated-output list** (`AGENTS.md` §Always-on rules, `references/measuring.md` §generated). The list is `dist/`, `es/`, `es-custom/`, `storybook-static/`, `storybook-react-static/`, `custom-elements.json`, `telemetry.yml`, and the release-owned `packages/ai-chat/docs/api/markdown/` and `symbol-index.json`. The hand-written `docs/api/README.md` is docs. The previous G1 named all of `docs/api/`, which over-reached; G1 follows the list (correction, not upstream drift).
- **`caic-review/SKILL.md` §Output expectations.** The summary has a fixed layout (`### AI Review`, verdict line, **Blocking**, **Across the diff**, **Not verified**, **Complete patch**, **Checked**), Important is capped at ten, and the "Test / verification gaps" section became **Not verified**. Not adopted: Carbon Monitor's comment layout is fixed by `docs/REVIEW_OUTPUT.md`. Only **Not verified** is taken, as one summary sentence (W9). The finding cap stays Carbon Monitor's own (Important plus Nit at most ten, Nits at most three).
- **Finding shape** (`caic-review/SKILL.md` §How to write a finding). Same order; the severity line now reads `**<Severity>** in path:42: ...`. Carbon Monitor carries file and line in the JSON, so the line format does not apply. Adopted: W1.
- **`references/definition-of-done.md`, `measuring.md`, `pr-reviewability.md`, `packages/ai-chat/AGENTS.md`.** Wording only: "paste" became "report", PR content follows `caic-pr`, a diagram-rules pointer, a `manifests.md` pointer, and `npm run build` now runs the element manifest. No review rule changed.
- **`accessibility.md`, `code-patterns.md`, `packages/ai-chat-components/AGENTS.md`.** No change. F, N, S, L and C rules are unchanged.

### Removed upstream

- **The Nit severity** (`caic-review/SKILL.md` §How to review: "If nobody pays, it isn't a finding"). Not adopted for nits. Carbon Monitor keeps them, collapsed and never inline; the cost test applies at `minor` and above (V4, V5).
- **The Nit cap** ("Cap Important and Nit at ten between them, no more than three of those Nits"). Replaced upstream by a cap on Important. Carbon Monitor's cap is unchanged.

### New

- **Orientation labels** (`caic-copy-writer/references/review-comments.md` type 14). Four labels, and "orientation describes the code, not the review". Adopted: W1.
- **What isn't a finding** (`caic-review/references/writing-findings.md`). Seven items. Adopted: X6–X10, X12; X4 gains the issue-suggested-route case.
- **Three habits that weaken a finding** (same file): hedging, throat-clearing, praise inside a finding. Adopted: W2, W6, W7.
- **Never post the objection without the fix; name the gap when you cannot** (same file). Adopted: W1 step 4.
- **Rank before you read** (`caic-review/references/large-diffs.md`). Adopted: Section 9 (R1–R3).
- **Checklists** (`caic-review/references/evaluating-changes.md`). Adopted: Section 9 (E-code, E-tests, E-docs). Left out: `npm run measure`, `npm run lint:dead`, browser automation and sub-agents. The reviewer runs no commands.
- **Cite the rule behind a convention finding** (`caic-review/references/repo-checks.md`). The source column below is that citation. Dependencies: new or upgraded packages need a reason; adopted in P1 for duplicates.
- **Done when, Constraints, proofs, API proposal and ADR check** (`caic-review/references/review-passes.md` §The check that runs every time). A miss is a Blocker. Not adopted: the review sees the diff and PR description, and the linked issue is context only (X3). See Q9.
- **Passes, fresh-eyes self-review, refute-then-synthesize** (`review-passes.md`). Not adopted: one reviewer, one shot. The refute step is kept as W5.
- **Posting rules** (`reviewing-a-pr.md`): base resolution, `suggestion` blocks, complete patch, one review payload. Not adopted: the JSON contract and `docs/REVIEW_OUTPUT.md` own posting.
- **Commit and PR-title conventions** (`references/conventions.md`). Not adopted: the review has no commit messages.

---

## Section 1 — Carbon flavor (path-to-flavor table)

These rules are **Cat 1** (Carbon-specific; verify via MCP with the correct `component_type`).

| Rule ID | Rule                                                                                                                                                                                              | Source                                                                    |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| F1      | Files under `packages/ai-chat/src/` use `@carbon/web-components` via `@lit/react` wrappers. Every Carbon MCP call for these paths must pass `filters.component_type: "Web Components"`.           | `references/code-patterns.md` §Carbon flavor by area                      |
| F2      | Files under `packages/ai-chat-components/src/` Lit elements use `@carbon/web-components`. Every Carbon MCP call must pass `filters.component_type: "Web Components"`.                             | `references/code-patterns.md` §Carbon flavor by area                      |
| F3      | Files under `packages/ai-chat-components/**/__stories__/*-react.{stories.jsx,mdx}` use `@carbon/react`. MCP calls pass `filters.component_type: "React"`.                                         | `references/code-patterns.md` §Carbon flavor by area                      |
| F4      | `@carbon/react` is **never** imported at runtime into `packages/ai-chat/src/` or into a Lit element in `packages/ai-chat-components/src/`. A `+` line adding such an import is a Blocker.         | `references/code-patterns.md` §Carbon flavor by area                      |
| F5      | The `carbon-builder` skill defaults to React. That default is wrong for the primary packages. A React snippet from the skill is a translation hint for non-React paths — not a copy-paste answer. | `references/code-patterns.md` §The carbon-builder skill defaults to React |

---

## Section 2 — Naming and prefix discipline (build-breaking)

These rules are **Cat 2** (diff-visible, no MCP needed).

| Rule ID | Rule                                                                                                                                                                                                             | Source                                                    |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| N1      | Never hardcode `cds--` in SCSS class strings. Use `#{$prefix}--` instead. A `+` line containing a literal `cds--` string in SCSS is a Blocker (breaks the `es-custom` build which re-prefixes to `cds--custom`). | `references/code-patterns.md` §Naming & prefix discipline |
| N2      | Never hardcode `cds--` in TS/TSX class strings. Use the shared prefix helpers. A `+` line with a literal `cds--` class string is a Blocker.                                                                      | `references/code-patterns.md` §Naming & prefix discipline |
| N3      | In Lit, tag strings come from the shared prefix constant, not inline literals.                                                                                                                                   | `references/code-patterns.md` §Naming & prefix discipline |

---

## Section 3 — SCSS authoring

These rules are **Cat 2** (diff-visible).

| Rule ID | Rule                                                                                                                                                                                                       | Source                                        |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| S1      | SCSS uses BEM with `#{$prefix}--` prefix.                                                                                                                                                                  | `references/code-patterns.md` §SCSS authoring |
| S2      | No descendant nesting in SCSS. `&:hover`, `&--modifier`, and media queries are fine; `.a .b {}` is not. A `+` line adding a descendant selector is Important.                                              | `references/code-patterns.md` §SCSS authoring |
| S3      | CSS logical properties for RTL. Use `padding-block-start`, `inset-inline-end` etc. Never physical properties (`padding-left`, `right`, …). A `+` line adding a physical directional property is Important. | `references/code-patterns.md` §SCSS authoring |

---

## Section 4 — Framework-agnostic logic

These rules are **Cat 2** (diff-visible).

| Rule ID | Rule                                                                                                                                                                                                                                                                                                                                  | Source                                                                                               |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| L1      | Logic belongs in plain modules (no React/Lit import), not in components. Components stay a thin render+wire layer. A `+` line adding parsing, formatting, validation, state transitions, or geometry math directly inside a component method where a plain module would do is Important. Flag logic you could only test by rendering. | `references/code-patterns.md` §Framework-agnostic logic; `caic-review/references/repo-checks.md`     |
| L2      | New UI goes in `components/`, never `packages/ai-chat/src/chat/components-legacy/`. A `+` line adding a new component file under `components-legacy/` is a Blocker.                                                                                                                                                                   | `references/code-patterns.md` §Component placement; `caic-review/references/repo-checks.md` (see Q8) |

---

## Section 5 — Comments

These rules are **Cat 2** (diff-visible).

| Rule ID | Rule                                                                                                                                                                 | Source                                                                                        |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| C1      | Repo default is **no comments**. Keep only the non-obvious _why_. A `+` line adding a comment that restates the code or references a current task/PR/issue is a Nit. | `references/code-patterns.md` §Comments; `caic-review/references/evaluating-changes.md` §Code |

---

## Section 6 — Generated output

These rules are **Cat 2** (diff-visible).

| Rule ID | Rule                                                                                                                                                                                                                                                                                                                                                                                                                         | Source                                                                                                               |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| G1      | Never hand-edit generated output: `dist/`, `es/`, `es-custom/`, `storybook-static/`, `storybook-react-static/`, `custom-elements.json` (CEM), `telemetry.yml`, and the release-owned `packages/ai-chat/docs/api/markdown/` and `packages/ai-chat/docs/api/symbol-index.json`. A `+` line editing these directly without an accompanying source change that would regenerate them is a Blocker. `docs/api/README.md` is docs. | `AGENTS.md` §Always-on rules; `references/measuring.md` §generated category; `caic-review/references/large-diffs.md` |
| G2      | `telemetry.yml` change that accompanies a source change is fine — do not flag it. (`telemetry.yml` is committed and regenerated; see Q7.)                                                                                                                                                                                                                                                                                    | `references/measuring.md` §generated category; `caic-review/references/large-diffs.md` §Costs a glance               |

---

## Section 7 — Test integrity

These rules are **Cat 2** (diff-visible). Severity: Blocker when the weakened proof covers behavior the diff changes, Important (`major`) otherwise.

| Rule ID | Rule                                                                                                                                              | Source                                                                                                           |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| T1      | A loosened assertion (e.g. `expect(x).toBeDefined()` replacing `expect(x).toBe(5)`).                                                              | `references/definition-of-done.md` §Report a gate; `caic-review/references/evaluating-changes.md` §Test coverage |
| T2      | A deleted or skipped test case (`test.skip`, `xit`, `xdescribe`, `.skip`) with no replacement.                                                    | same                                                                                                             |
| T3      | A regenerated snapshot that masks a behavior change. Regenerating is allowed; the review asks for the reason, not for the absence of the command. | same                                                                                                             |

---

## Section 8 — New dependencies

This rule is **Cat 2** (diff-visible). It was labelled `Z1` in the skill and the prompt, which clashed with the size rule Z1 below; renamed `P1`.

| Rule ID | Rule                                                                                                                                                                                            | Source                                                                  |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| P1      | A `+` line adding a new dependency in `package.json` with no explanation in the PR description or in a comment is Important. A package that duplicates one already listed needs the reason too. | `caic-review/references/repo-checks.md` §Flag the rules no gate catches |

---

## Section 9 — PR size, large diffs and checklists

### Size

| Rule ID | Rule                                                                                                                                                                                                                                                                                                                 | Source                                                                                                 |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Z1      | Up to 200 counted lines: preferred target. No finding.                                                                                                                                                                                                                                                               | `references/pr-reviewability.md`                                                                       |
| Z2      | 201–400 counted lines: warn (Important) and suggest a useful split.                                                                                                                                                                                                                                                  | `references/pr-reviewability.md`                                                                       |
| Z3      | Over 400 counted lines: Important (`major`), split by default unless the author explains why the change must stay together. Was Blocker; see Drift.                                                                                                                                                                  | `references/pr-reviewability.md`; `caic-review/references/large-diffs.md` §Size is a finding           |
| Z4      | Counted lines are additions plus deletions. Excluded: lockfiles, generated files (G1/G2 list plus `versions.js`, `.claude/skills/`, `.agents/skills/`, vendored `.bob/skills/carbon-builder/`), snapshots, fixtures, test-case files, `examples/` and `demo/`, `.md`/`.mdx` docs. Shared test infrastructure counts. | `references/measuring.md` §Measuring PR size                                                           |
| Z5      | Size is a finding at any size when the change should have been several PRs, including unrelated work bundled in: `major`, and name the seams. Mechanical bulk is one job. Do not ask for arbitrary chunks, incomplete work, or deferred tests.                                                                       | `caic-review/references/large-diffs.md` §Size is a finding; `references/pr-reviewability.md` §Use size |

### Large diffs

| Rule ID | Rule                                                                                                                                                                                              | Source                                                        |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| R1      | When reading every file at one depth would mean reading all of it shallowly, rank files by risk per line before cataloguing. No line count triggers it. Every file still gets its catalogue line. | `caic-review/references/large-diffs.md` §Rank before you read |
| R2      | Glance: pure renames and moves, `package-lock.json`, generated output (an edit is a Blocker on sight; `telemetry.yml` is the exception).                                                          | same                                                          |
| R3      | Read in full: `packages/ai-chat/src/types/**`, `packages/ai-chat/src/chat/store/**`, new files. Read the hunks for everything else. A partial read is said in `Not verified` (W9).                | same §Read in full, §Say what you read                        |

### Checklists

Short, per file type; the Step 1 catalogue walks the one that matches. Source: `caic-review/references/evaluating-changes.md`, with `repo-checks.md` for accessibility and `review-passes.md` §Pick the passes for the specification bullet.

| Rule ID | Checklist | Left out                                                                  |
| ------- | --------- | ------------------------------------------------------------------------- |
| E-code  | Code      | `npm run measure` and `npm run lint:dead` (the reviewer runs no commands) |
| E-tests | Tests     | test-runner commands, browser automation                                  |
| E-docs  | Docs/text | `tone.md` and the copy-writer rules (not read; see Drift)                 |

---

## Section 10 — Not verified

| Rule ID | Rule                                                                                                                                                                                                                                                            | Source                                                                                                         |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| W9      | Say what you did not read. A skipped or skimmed path or behavior goes in the finding body (W5) and in one last summary sentence `Not verified: <path or behavior>`. Omit it otherwise; never write "Not verified: nothing". The summary layout does not change. | `caic-review/SKILL.md` §Output expectations (**Not verified**); `references/large-diffs.md` §Say what you read |

---

## Section 11 — Severity mapping (written once)

`SKILL.md` §Severity and `prompt.js` §Severity carry these lines word for word. `tests/caicBundle.test.js` fails if they differ.

| Rule ID | Rule                                                                                                                                                                                                                                                | Source                                                                      |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| V1      | **Blocker** → `blocking`. Something ships broken or a commitment breaks: wrong behavior on a path you can name, a regression, a security hole, a broken build or tests, an accessibility requirement violated, or an edit to generated output.      | `caic-review/SKILL.md` §How to review; `repo-checks.md` (accessibility)     |
| V2      | **Important** → `major`. Nothing ships broken, but someone pays later: a missing test for changed behavior, a defect you could not confirm past the happy path, needless work, a misleading name or doc, scope creep, or unrelated work bundled in. | `caic-review/SKILL.md` §How to review                                       |
| V3      | (no upstream label) → `minor`. A maintainability risk with evidence of functional impact. Carbon Monitor's own definition; upstream has no equivalent, so no rule here maps to it.                                                                  | Carbon Monitor (`docs/REVIEW_OUTPUT.md` §Finding severities)                |
| V4      | **Nit** → `nit`. Convention or hygiene with no functional consequence. Kept, collapsed in the summary, never posted inline.                                                                                                                         | Carbon Monitor (`docs/REVIEW_OUTPUT.md`); upstream removed the Nit severity |
| V5      | If nobody pays, it is not a finding at `minor` or above. A nit is reported because it costs nothing to read and the report collapses it.                                                                                                            | `caic-review/SKILL.md` §How to review                                       |
| V6      | A convention break costs what its consequence costs. It is not a Blocker by default.                                                                                                                                                                | `caic-review/SKILL.md` §How to review                                       |

---

## Section 12 — Finding wording

These apply to all findings in the caic prompt. A `minor`-or-above body reads: orientation (one of four labels), what is wrong, what it costs, the fix.

| Rule ID | Rule                                                                                                                                                                                                                  | Source                                                               |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| W1      | Orient, diagnose, cost, fix, in that order. Orientation opens with `**What this block does:**`, `**Context:**`, `**What this test is for:**` or `**Why this line matters:**`, and describes the code, not the review. | `caic-review/SKILL.md` §How to write a finding; `review-comments.md` |
| W2      | No hedging language ("might", "could potentially", "I think"). Say what you checked instead.                                                                                                                          | `caic-review/references/writing-findings.md` §Hold your own words    |
| W3      | Name the trigger: the file path, the line, and the input or path that reaches the defect.                                                                                                                             | `writing-findings.md` §Cite the defect                               |
| W4      | End with an imperative fix. Never post the objection without the fix. With no fix to name, end with the check that would settle it.                                                                                   | `writing-findings.md` §Cite the defect, and ship a fix with it       |
| W5      | Before a Blocker, read enough to be sure; a false Blocker costs the author as much as a missed one. If only the happy path was read, file it as Important (`major`) and say what was not read.                        | `caic-review/SKILL.md` §How to review                                |
| W6      | No throat-clearing ("just", "simply", "one small thing").                                                                                                                                                             | `writing-findings.md` §Hold your own words                           |
| W7      | No praise inside a finding.                                                                                                                                                                                           | `writing-findings.md` §Hold your own words                           |
| W8      | Cap the diagnosis and cost at three sentences.                                                                                                                                                                        | `writing-findings.md` §Worked findings                               |
| W9      | See Section 10.                                                                                                                                                                                                       |                                                                      |

---

## Section 13 — What is NOT a finding

| Rule ID | Rule                                                                                                                                       | Source                                                                |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| X1      | Do not flag `telemetry.yml` when it accompanies a source change that regenerates it. (Merges the old X1 and X6, which were the same rule.) | `references/measuring.md` §generated; see G2                          |
| X2      | Do not flag a PR description explaining an unusual change as "author says intentional" — that is valid context.                            | Carbon Monitor (eval B4)                                              |
| X3      | Do not flag missing "Done when" items from a linked issue. The linked issue is context only.                                               | Carbon Monitor (`src/reviewPrompt.js` linked-issue context); see Q9   |
| X4      | Do not flag a different-but-valid approach as wrong, including a route other than the one a linked issue suggests.                         | Carbon Monitor (eval B6); `writing-findings.md` §What isn't a finding |
| X5      | A `cds-*` attribute name or validity is Cat 1 — must verify via MCP before filing. Do not flag based on model knowledge alone.             | `references/code-patterns.md` §Carbon flavor                          |
| X6      | A tool already decided it: formatting, quote style, import order, line length.                                                             | `writing-findings.md` §What isn't a finding                           |
| X7      | A naming swap with no clarity gain, or an equivalent style alternative.                                                                    | same                                                                  |
| X8      | "Add a comment here." Ask for one only when the diff encodes a why the code cannot show, and say what it has to record.                    | same; `references/code-patterns.md` §Comments                         |
| X9      | Speculative extraction.                                                                                                                    | same                                                                  |
| X10     | Code the diff did not touch. A caller or consumer visible elsewhere in the diff that the change breaks is a regression: Blocker.           | same                                                                  |
| X11     | A defect you cannot trigger is a guess: drop it, or file it one level down and say what you did not read.                                  | `writing-findings.md` §Cite the defect                                |
| X12     | A review that surfaces nothing is finished, not failed. Never manufacture a finding.                                                       | `writing-findings.md` §What isn't a finding (last paragraph)          |

---

## Evals

`evals/caic/manifest.json` holds one entry per rule a PR can show. Never run them without the maintainer's go-ahead.

| Rule                         | Eval                                                           |
| ---------------------------- | -------------------------------------------------------------- |
| X6                           | E1 (reformat only, no finding)                                 |
| X7                           | E2 (naming swap and equivalent style, no finding)              |
| X10                          | E3 (renamed option, caller in the diff left on the old name)   |
| T1–T3 graded                 | A9 (now `major`), E4 (weakened proof beside a behavior change) |
| Z5                           | E5 (unrelated work bundled under 200 lines)                    |
| E-code                       | E6 (single-caller abstraction)                                 |
| E-docs, V2                   | E7 (JSDoc with the wrong unit)                                 |
| Z3                           | C3 (now `major`)                                               |
| X8, X9, X12                  | B1 (clean refactor, no finding)                                |
| R1–R3, V1–V6, W1–W9, E-tests | none: reading order and wording leave no finding a PR can show |

---

## Open questions recorded here

- **Q7:** `telemetry.yml` conflict between `AGENTS.md` ("never hand-edit") and `measuring.md` (generated, excluded from size) and `large-diffs.md` ("committed and regenerated, so they belong in the diff"). This ledger sides with the latter two (G2/X1): a `telemetry.yml` change accompanying a source change is not a finding. Confirm with caic maintainers before the schedule is enabled.
- **Q8:** L2 stays a Blocker as before. Upstream says only that `components-legacy/` "is closed to new components", with no consequence named, and V6 says a convention break is not a Blocker by default. Important may fit better. The maintainer decides.
- **Q9:** Upstream scores a diff against the issue's Done when, its Constraints, the proofs and any cited ADR, and a miss is a Blocker. X3 keeps this out: the review has a diff and a PR description, and the linked issue is background. Revisit if the harness starts passing the issue's Constraints as required context.
