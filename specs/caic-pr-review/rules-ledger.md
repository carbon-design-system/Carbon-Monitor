# Rule Ledger — `caic-pr-review` skill

Rules distilled for the `caic-pr-review` skill and the caic prompt.
Every rule is tagged with its upstream source document and the commit at which it was read.

**Upstream repo:** `carbon-design-system/carbon-ai-chat`
**Upstream commit pinned:** `88dddbd425c9fdd5eb1520c521d914a36809dbb5`
**Docs read:** `packages/ai-chat/AGENTS.md`, `packages/ai-chat-components/AGENTS.md`,
`references/accessibility.md`, `references/measuring.md`, `references/code-patterns.md`,
`references/definition-of-done.md`, `references/pr-reviewability.md`,
`references/authoring-agents-md.md`, `.agents/skills/caic-review/SKILL.md`,
`packages/ai-chat/src/types/AGENTS.md`

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

| Rule ID | Rule                                                                                                                                                                                                                                                                                     | Source                                                  |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| L1      | Logic belongs in plain modules (no React/Lit import), not in components. Components stay a thin render+wire layer. A `+` line adding parsing, formatting, validation, state transitions, or geometry math directly inside a component method where a plain module would do is Important. | `references/code-patterns.md` §Framework-agnostic logic |
| L2      | New UI goes in `components/`, never `packages/ai-chat/src/chat/components-legacy/`. A `+` line adding a new component file under `components-legacy/` is a Blocker.                                                                                                                      | `references/code-patterns.md` §Component placement      |

---

## Section 5 — Comments

These rules are **Cat 2** (diff-visible).

| Rule ID | Rule                                                                                                                                                                 | Source                                  |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| C1      | Repo default is **no comments**. Keep only the non-obvious _why_. A `+` line adding a comment that restates the code or references a current task/PR/issue is a Nit. | `references/code-patterns.md` §Comments |

---

## Section 6 — Generated output

These rules are **Cat 2** (diff-visible).

| Rule ID | Rule                                                                                                                                                                                                                                                                                | Source                                                                       |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| G1      | Never hand-edit generated output: `dist/es/`, `dist/es-custom/`, `custom-elements.json` (CEM), `telemetry.yml`, API docs under `packages/ai-chat/docs/api/`. A `+` line editing these files directly without an accompanying source change that would regenerate them is a Blocker. | `references/code-patterns.md`, `references/measuring.md` §generated category |
| G2      | `telemetry.yml` change that accompanies a source change is fine — do not flag it. (Conflict with some docs noted; ruled in favour of `measuring.md` generated exclusion at this commit.)                                                                                            | `references/measuring.md` §generated category; `packages/ai-chat/AGENTS.md`  |

---

## Section 7 — Test integrity

These rules are **Cat 2** (diff-visible). Severity: any weakening of a proof is a Blocker.

| Rule ID | Rule                                                                                                                                                          | Source                                            |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| T1      | A loosened assertion (e.g. `expect(x).toBeDefined()` replacing `expect(x).toBe(5)`) is a Blocker.                                                             | `references/definition-of-done.md` §Report a gate |
| T2      | A deleted or skipped test case (`test.skip`, `xit`, `xdescribe`, `.skip`) with no replacement is a Blocker.                                                   | `references/definition-of-done.md` §Report a gate |
| T3      | A regenerated snapshot that masks a behavior change (i.e. snapshot was regenerated to match current output without fixing the underlying issue) is a Blocker. | `references/definition-of-done.md` §Report a gate |

---

## Section 8 — PR size and scope

These rules produce Nit/Important findings. Checked from the diff's addition/deletion count visible in the changed-files listing.

| Rule ID | Rule                                                                                                                                                                                  | Source                                                                                                  |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Z1      | Up to 200 counted lines: preferred target. No finding.                                                                                                                                | `references/pr-reviewability.md`                                                                        |
| Z2      | 201–400 counted lines: warn (Important) and suggest a useful split.                                                                                                                   | `references/pr-reviewability.md`                                                                        |
| Z3      | Over 400 counted lines: Blocker unless the author explains why the change must stay together.                                                                                         | `references/pr-reviewability.md`                                                                        |
| Z4      | Counted lines exclude: lockfiles, generated files (see G1/G2), snapshots, fixtures, test-case files (`*_spec.*`, `*.test.*`, `*.spec.*`), examples/demo files, and `.md`/`.mdx` docs. | `references/pr-reviewability.md` §Measure against the intended PR base, `references/measuring.md` §size |

---

## Section 9 — Severity calibration (caic mapping)

Maps caic-review severity to the output contract severities.

| caic-review | Output contract | Notes                       |
| ----------- | --------------- | --------------------------- |
| Blocker     | `blocking`      | Must fix before merge.      |
| Important   | `major`         | Should fix.                 |
| Nit         | `nit`           | Optional.                   |
| (none)      | `minor`         | Not used in caic prompt v1. |

Source: `specs/caic-pr-review/SPEC.md` §5, `caic-review` skill.

---

## Section 10 — Finding wording

These apply to all findings in the caic prompt. Not a finding rule — a writing rule.

| Rule ID | Rule                                                                                                                                        | Source                                                        |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| W1      | Orient then diagnose: start with what the code does and when it runs, then state what is wrong, the cost, and the fix.                      | `.agents/skills/caic-review/SKILL.md` §How to write a finding |
| W2      | No hedging language ("might", "could potentially"). State the finding directly.                                                             | `.agents/skills/caic-review/SKILL.md` §Output expectations    |
| W3      | Name the trigger: include the file path and line.                                                                                           | `.agents/skills/caic-review/SKILL.md` §How to write a finding |
| W4      | End with an imperative fix. Never post the objection without the fix.                                                                       | `.agents/skills/caic-review/SKILL.md` §How to write a finding |
| W5      | Run a refute step before shipping a Blocker or Important: read enough to be sure; a false Blocker costs the author as much as a missed one. | `.agents/skills/caic-review/SKILL.md` §How to review          |

---

## Section 11 — What is NOT a finding

| Rule ID | Rule                                                                                                                           | Source                                       |
| ------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| X1      | Do not flag `telemetry.yml` when it accompanies a source change that regenerates it.                                           | `references/measuring.md` §generated; see G2 |
| X2      | Do not flag a PR description explaining an unusual change as "author says intentional" — that is valid context.                | `specs/caic-pr-review/SPEC.md` §11 eval B4   |
| X3      | Do not flag missing "Done when" items from a linked issue — completeness checks are out of scope per the prompt.               | `specs/caic-pr-review/SPEC.md` §5            |
| X4      | Do not flag a different-but-valid approach as wrong.                                                                           | `specs/caic-pr-review/SPEC.md` §11 eval B6   |
| X5      | A `cds-*` attribute name or validity is Cat 1 — must verify via MCP before filing. Do not flag based on model knowledge alone. | `references/code-patterns.md` §Carbon flavor |

---

## Open questions recorded here

- **Q7 (SPEC §13):** `telemetry.yml` conflict between `AGENTS.md` ("never hand-edit") and `measuring.md` (generated, excluded from size). This ledger sides with `measuring.md` (G2/X1): a `telemetry.yml` change accompanying a source change is not a finding. Confirm with caic maintainers before the schedule is enabled.
