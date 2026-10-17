# GitHub access for the review agent

The agent acts through a reviewing GitHub account (i.e. machine user), and that
account's token is `GITHUB_AI_AGENT_TOKEN`. In the Carbon deployment the account
is `carbon-monitor-agent`, a member of the `carbon-design-system` org. It
needs to read code and pull requests, and to write review comments, issue
comments and labels. Adding the `AIReviewed` label needs the **Triage role or
higher** on the repository. That label is also the de-duplication key, so an
account that can comment but not label re-reviews the same PR on every run.

## GitHub token

The agent makes eight distinct API calls. Six are reads, and three write:
`pulls.createReviewComment` (inline comments), `issues.createComment` (the
summary) and `issues.addLabels` (the `AIReviewed` label).

### The label is the binding requirement

**Adding a label needs the Triage role or higher on the repository.** No token
scope grants this on its own — the *account* the token belongs to must hold that
role on `carbon-design-system/carbon`.

It is not optional:

- `addReviewedLabel` throws, and the per-PR handler treats that as a failure — so
  the run fails *after* it has already posted its comments.
- The label is the de-duplication key. `fetchReviewablePRs` skips any PR that
  already carries it, so a token that can comment but not label will **re-review
  the same PR on every run and post duplicate comments each time.**

Inline comment failures, by contrast, are non-fatal: they are logged and the loop
continues.

### Fine-grained token (recommended)

| Setting | Value |
|---------|-------|
| Resource owner | `carbon-design-system` |
| Repository access | `carbon` — plus any repo hosting linked parent issues |
| **Pull requests** | Read and write |
| **Issues** | Read and write |
| **Contents** | Read |
| **Metadata** | Read (mandatory, selected automatically) |

*Issues* write is needed for two reasons that are easy to miss: labels are an
issue-level concept, and the PR summary comment is posted through the issues
endpoint.

Grant access to more than one repository if PRs link to parent issues elsewhere —
`fetchLinkedIssueContext` follows `parent_issue_url` across repositories, and a
token scoped to a single repo silently returns no issue context rather than
failing.

### Classic token

`public_repo` is sufficient: the target repository is public, and that scope
grants write. Use full `repo` only when pointing at a private repository.

Classic tokens are coarser — `public_repo` grants write access to *every* public
repository the account can push to, which is why the fine-grained token is
preferred.

> **Not `write:discussion`.** Earlier revisions of this document listed that
> scope. It governs *team discussions*, which this agent never touches; it grants
> nothing the agent needs and can be dropped from existing tokens.

### Two things that will bite you

- **SAML SSO authorization.** `carbon-design-system` is IBM-managed, so after
  creating the token you must use **Configure SSO → Authorize** on it. Without
  that, every call returns 403 with an otherwise valid-looking token, and the
  console's GitHub tile reports `Token rejected`.
- **Fine-grained tokens expire** (one year maximum, often capped shorter by org
  policy). An expired token is indistinguishable from a revoked one in the status
  tile — both read `Token rejected`.

### Running without write access

Comment posting can be disabled:

```bash
GITHUB_AI_AGENT_POST_INLINE_COMMENTS=false
GITHUB_AI_AGENT_POST_SUMMARY_COMMENT=false
```

The label call is **not** behind a flag, so it still runs and still needs Triage.
There is currently no fully read-only mode.
