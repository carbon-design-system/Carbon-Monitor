---
name: caic-pr-review
description: 'PR review conventions for carbon-design-system/carbon-ai-chat. Covers: Carbon flavor by path (Web Components vs React), no hardcoded cds-- in SCSS/TS, BEM + logical CSS, logic in plain modules not Lit elements, new UI in components/ not components-legacy/, no hand-edit of generated files, test-proof integrity, PR size calibration, and finding-wording rules. Use on every caic diff alongside the main review prompt.'
version: '1.0.0'
author: Carbon Monitor
---

<!-- upstream commit pinned: 88dddbd425c9fdd5eb1520c521d914a36809dbb5 -->
<!-- rules-ledger: specs/caic-pr-review/rules-ledger.md -->

# caic-pr-review

This skill is for **PR review only**. It uses only the diff, PR description,
and changed-files list. It does not write code, call external tools, or check
anything that is not visible in the diff.

It does **not** include output-format rules — those come from the main prompt.

---

## What is NOT a finding (X rules)

Before writing any finding, check this list:

- **X1** `telemetry.yml` changed _and_ a source file in the same PR regenerates
  it → not a finding.
- **X2** The PR description explains an unusual change as intentional → that is
  valid context; do not flag it as "author says intentional".
- **X3** A linked issue has unmet "Done when" items → completeness is out of
  scope; do not flag it.
- **X4** A different-but-valid approach → do not flag it as wrong. Example: a
  PR uses `ResizeObserver` where `getBoundingClientRect()` would also work.
  Both are valid; do not flag the chosen approach as wrong.
- **X5** A `cds-*` attribute name → Cat 1; must verify via Carbon MCP before
  filing. Never flag from model knowledge alone.
- **X6** `telemetry.yml` changed _and_ a source file in the same PR regenerates
  it → not a finding. Example: a commit modifies `Foo.ts` and also updates
  `telemetry.yml`; only flag `telemetry.yml` when no source change regenerates it.

---

## Section F — Carbon flavor by path (Cat 1)

Findings in this section require a Carbon MCP call with the correct
`filters.component_type` before reporting.

| Path pattern                                                           | Carbon package at runtime                            | MCP component_type |
| ---------------------------------------------------------------------- | ---------------------------------------------------- | ------------------ |
| `packages/ai-chat/src/**`                                              | `@carbon/web-components` (via `@lit/react` wrappers) | `"Web Components"` |
| `packages/ai-chat-components/src/**` (Lit elements)                    | `@carbon/web-components`                             | `"Web Components"` |
| `packages/ai-chat-components/**/__stories__/*-react.{stories.jsx,mdx}` | `@carbon/react`                                      | `"React"`          |

**F4 (Blocker):** A `+` line adding a `@carbon/react` import into
`packages/ai-chat/src/` or into a Lit element under
`packages/ai-chat-components/src/` is a Blocker. Verify via MCP first.

**F5:** The `carbon-builder` skill defaults to React. A React snippet from that
skill is a translation _hint_ for the primary Web Components paths — not a
copy-paste answer.

---

## Section N — Naming and prefix discipline (Cat 2, Blocker)

**N1:** A `+` line in SCSS containing the literal string `cds--` is a Blocker.
The build re-prefixes tokens at build time; a hardcoded `cds--` breaks the
`es-custom` output. Use `#{$prefix}--` instead.

**N2:** A `+` line in TS/TSX containing a literal `cds--` class string is a
Blocker. Use the shared prefix helpers.

**N3:** In Lit, tag strings must come from the shared prefix constant, not
inline literals.

---

## Section S — SCSS authoring (Cat 2, Important)

**S1:** SCSS uses BEM with `#{$prefix}--` prefix.

**S2 (Important):** A `+` line adding a descendant selector (`.a .b {}`) is
Important. `&:hover`, `&--modifier`, and `@media` queries are fine.

**S3 (Important):** A `+` line adding a physical directional CSS property
(`padding-left`, `right`, `padding-top` where `padding-block-start` is
correct, etc.) is Important. Use CSS logical properties
(`padding-block-start`, `inset-inline-end`, …) for RTL support.

---

## Section L — Framework-agnostic logic (Cat 2, Important/Blocker)

**L1 (Important):** A `+` line adding parsing, formatting, validation, state
transitions, or geometry math _directly inside_ a component method where a
plain module would do is Important. Logic belongs in modules without
React/Lit imports.

**L2 (Blocker):** A `+` line adding a new component file under
`packages/ai-chat/src/chat/components-legacy/` is a Blocker. New UI goes in
`components/`.

---

## Section C — Comments (Cat 2, Nit)

**C1 (Nit):** A `+` line adding a comment that restates the code, or that
references the current PR/task/issue number, is a Nit.

---

## Section G — Generated output (Cat 2, Blocker)

**G1 (Blocker):** A `+` line directly editing `dist/es/`, `dist/es-custom/`,
`custom-elements.json`, `telemetry.yml` (without an accompanying source
change), or API docs under `packages/ai-chat/docs/api/` is a Blocker.

**G2:** `telemetry.yml` accompanied by a source change that regenerates it is
fine — see X1.

---

## Section T — Test integrity (Cat 2, Blocker)

**T1 (Blocker):** A `+` line replacing a specific assertion with a weaker one
(e.g. `.toBeDefined()` replacing `.toBe(5)`) is a Blocker.

**T2 (Blocker):** `test.skip`, `xit`, `xdescribe`, `.skip` with no replacement
test is a Blocker.

**T3 (Blocker):** A regenerated snapshot that masks a behaviour change (updated
to match current broken output, not a real improvement) is a Blocker.

---

## Section A — New dependencies (Cat 2, Important)

**Z1 (Important):** A `+` line adding a new dependency in `package.json` with no
explanation in the PR description or in a comment is Important. Flag the
dependency name and the lack of rationale. If the PR description explains why the
new package is needed, discard.

---

## Section Z — PR size (Cat 2, Nit/Important/Blocker)

Count only non-generated, non-test, non-snapshot, non-fixture, non-doc lines.
Exclude: lockfiles, `dist/`, `es-custom/`, `custom-elements.json`,
`telemetry.yml`, `*.snap`, `*.test.*`, `*_spec.*`, `*.spec.*`, examples,
`.md`/`.mdx` docs.

| Counted lines | Severity                                                               |
| ------------- | ---------------------------------------------------------------------- |
| ≤ 200         | No finding                                                             |
| 201–400       | Important — suggest a useful split                                     |
| > 400         | Blocker — unless the PR description explains why it must stay together |

---

## Section W — Finding wording

Every finding must follow this pattern:

1. **Orient:** what the code does and when it runs.
2. **Diagnose:** what is wrong, the cost to the codebase or runtime.
3. **Imperative fix:** a clear action the author can take.

Rules:

- No hedging ("might", "could potentially"). State the finding directly.
- Name the file path and the line from the diff.
- Run a **refute step** before shipping a Blocker or Important: read enough of
  the diff and PR description to be certain. A false Blocker costs the author
  as much as a missed one.

---

## Severity mapping

| caic label | Output contract value |
| ---------- | --------------------- |
| Blocker    | `blocking`            |
| Important  | `major`               |
| Nit        | `nit`                 |

`minor` is not used in v1.
