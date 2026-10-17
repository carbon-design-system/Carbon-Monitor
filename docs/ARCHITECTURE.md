# Carbon Monitor — Architecture

How Carbon Monitor is packaged, deployed to IBM Cloud Code Engine, and how it
keeps its Carbon MCP connection alive without a human.

---

## 1. The problem this design solves

Carbon Monitor drives the **Bob Shell CLI** to review pull requests, and Bob
reaches Carbon design-system knowledge through the **Carbon MCP** server. Both
dependencies assume a developer's laptop:

| Dependency       | On a laptop                                      | In a container                        |
| ---------------- | ------------------------------------------------ | ------------------------------------- |
| Bob Shell CLI    | Installed globally, authenticated by browser SSO | No browser — SSO cannot complete      |
| Carbon MCP token | A w3id JWT Bob renews via browser                | Expires in ~2 hours and stays expired |
| Review workspace | `/private/tmp`, pre-trusted by Bob               | Path does not exist                   |

The container therefore has to solve three things: **get Bob installed**,
**authenticate Bob without a browser**, and **keep the Carbon MCP token fresh
indefinitely**.

---

## 2. System overview

```
                            ┌──────────────────────────────┐
                            │   Operator (browser)         │
                            └───────────────┬──────────────┘
                                            │ HTTPS
                                            ▼
┌───────────────────────────────────────────────────────────────────────────┐
│  IBM Cloud Code Engine · project $PROJECT · region $REGION                │
│                                                                           │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │  App: carbon-monitor          min-scale 1 · max-scale 1 · 1vCPU 2GB │  │
│  │  ┌───────────────────────────────────────────────────────────────┐  │  │
│  │  │  node src/api/server.js            (port 8080)                │  │  │
│  │  │                                                               │  │  │
│  │  │   ┌──────────────┐   ┌──────────────┐   ┌─────────────────┐   │  │  │
│  │  │   │ Carbon React │   │  REST API    │   │ Refresh timer   │   │  │  │
│  │  │   │ console      │◄─►│  /api/*      │   │ every 60s       │   │  │  │
│  │  │   │ (dist/client)│   │              │   │                 │   │  │  │
│  │  │   └──────────────┘   └──────┬───────┘   └────────┬────────┘   │  │  │
│  │  │                             │                    │            │  │  │
│  │  │                             ▼                    ▼            │  │  │
│  │  │                      ┌─────────────────────────────────┐      │  │  │
│  │  │                      │ ~/.bob/settings/mcp.json        │      │  │  │
│  │  │                      │   Authorization: Bearer <jwt>   │      │  │  │
│  │  │                      │   X-MCP-Session: <session id>   │      │  │  │
│  │  │                      └────────────────┬────────────────┘      │  │  │
│  │  │                                       │ read by               │  │  │
│  │  │                                       ▼                       │  │  │
│  │  │                      ┌─────────────────────────────────┐      │  │  │
│  │  │                      │ bob run  (spawned per review)   │      │  │  │
│  │  │                      │   cwd = /workspace/<bundle>     │      │  │  │
│  │  │                      └────────────────┬────────────────┘      │  │  │
│  │  └───────────────────────────────────────┼───────────────────────┘  │  │
│  └──────────────────────────────────────────┼──────────────────────────┘  │
│                                             │                             │
│  Secret: carbon-monitor-secrets ────────────┘                             │
│    GITHUB_AI_AGENT_TOKEN · BOB_API_KEY · CONSOLE_USERNAME/PASSWORD        │
│    ES_URL · ES_USERNAME · ES_PASSWORD · SLACK_WEBHOOK_URL                 │
│    SESSION_SIGNING_KEY · API_SECRET · …                                   │
└───────────────────────────────────────────┬───────────────────────────────┘
                                            │
              ┌─────────────────────────────┼─────────────────────────────┐
              ▼                             ▼                             ▼
   ┌────────────────────┐      ┌────────────────────┐      ┌────────────────────┐
   │ Carbon MCP         │      │ GitHub API         │      │ Elasticsearch      │
   │ mcp.carbondesign   │      │ PRs, diffs,        │      │ (optional)         │
   │ system.com/mcp     │      │ comments, labels   │      │ review metrics     │
   └────────────────────┘      └────────────────────┘      └────────────────────┘
```

---

## 3. Container image

Built by [`Dockerfile`](../Dockerfile). Two decisions drive everything else.

### 3.1 Debian, not Alpine

Bob Shell depends on `@lydell/node-pty`, whose Linux prebuild is a dynamically
linked ELF requiring **GLIBC_2.28+**:

```
$ strings pty.node | grep GLIBC
GLIBC_2.28   GLIBC_2.14   GLIBC_2.8   GLIBC_2.4   GLIBC_2.2.5
```

`@lydell/node-pty` publishes **no musl variant** — its `optionalDependencies`
cover `darwin-x64`, `darwin-arm64`, `linux-x64`, `linux-arm64`, `win32-x64` and
`win32-arm64` only. On Alpine the binary cannot load and `bob` fails at startup.
Bob's own `dist/vscode-policy-watcher.node` is likewise a glibc x86-64 ELF.

`node:22-bookworm-slim` provides glibc 2.36. Node 22 is also a hard floor —
Bob Shell requires `>= 22.15.0` and refuses to install below it.

> The previous `node:18-alpine` base failed on **both** counts.

### 3.2 Bob Shell is installed by pinned tarball, not by the install script

The official install path is `curl -fsSL https://bob.ibm.com/download/bobshell.sh | bash`.
That script is unsuitable for a reproducible image build: it needs bash, can
prompt for a package manager and read from `/dev/tty`, and resolves "latest" at
build time. The Dockerfile performs the same steps it does, with the version and
its checksum pinned:

```
ARG BOB_VERSION=2.0.5
ARG BOB_SHA256=eff232eb1b69f34f984ddd295e6960470058ca922b1c751879c5a8d06199f566

curl -fsSL "${BASE}/bobshell-${BOB_VERSION}.tgz" -o /tmp/bobshell.tgz
echo "${BOB_SHA256}  /tmp/bobshell.tgz" | sha256sum -c -
npm install -g --registry=https://registry.npmjs.org/ /tmp/bobshell.tgz
```

`bobshell` is on **neither** the public npm registry nor IBM Artifactory — it is
distributed only as a tarball from IBM Cloud Object Storage, which is why it
cannot simply be a `package.json` dependency.

`deploy_ce.sh` checks that host is reachable before building, and warns
(without failing) when a newer version has been published.

### 3.3 Image layout

```
/usr/local/lib/node_modules/bobshell/   Bob Shell 2.0.5 + node-pty-linux-x64
/app/src/                               agent + API server
/app/dist/client/                       pre-built Carbon React console
/app/node_modules/                      production dependencies only
/app/.bob/skills/carbon-builder/        Carbon Builder skill, copied into each review bundle
/home/app/.bob/settings.json            licenseConsent seeded
/home/app/.bob/trustedFolders.json      /workspace pre-trusted
/home/app/.bob/settings/mcp.json        rewritten on every token refresh
/workspace/                             review bundles + OAuth refresh state
```

The console is built on the **host** (`npm run build:client`) and copied in, so
the runtime image carries no Vite, Sass or React — the same split the
`carbon-mcp` exemplar uses. Final image: **~401 MB**.

---

## 4. Keeping the Carbon MCP connection alive

This is the part that makes unattended operation possible.

### 4.1 What Carbon MCP actually accepts

Reading [`carbon-mcp/src/middleware/auth.js`](https://github.com/carbon-design-system/carbon-mcp)
(`authGateWithRefresh`) establishes two facts the design depends on:

1. **The session id is the durable credential, not the bearer token.** Given a
   valid `X-MCP-Session`, the server refreshes server-side — branch (B) mints a
   fresh `id_token` when there is _no bearer at all_, and branch (D) refreshes
   after a failed verify. The session→refresh-token mapping is Redis-backed with
   a 350-day TTL.
2. **`X-MCP-Force-Refresh: true` forces that refresh**, which makes the console's
   "Test connection" button a repair action rather than a passive check.

Carbon MCP also advertises full OAuth discovery — RFC 9728 protected-resource
metadata, RFC 8414 authorization-server metadata, dynamic client registration,
and PKCE S256 as a public client — but **no `device_authorization` grant**. A
headless container therefore cannot bootstrap a session by itself.

### 4.2 The two-phase solution

Because the Code Engine app has a public HTTPS URL and serves a browser UI, it
can run the authorization-code flow _itself_. A human is needed exactly once.

```
PHASE 1 — BOOTSTRAP (human, once)

  Operator            Carbon Monitor                Carbon MCP
     │                      │                            │
     │  "Sign in w/ IBMid"  │                            │
     ├─────────────────────►│                            │
     │                      │  GET /.well-known/         │
     │                      │      oauth-protected-      │
     │                      │      resource      (RFC 9728)
     │                      ├───────────────────────────►│
     │                      │  GET /.well-known/         │
     │                      │      oauth-authorization-  │
     │                      │      server        (RFC 8414)
     │                      ├───────────────────────────►│
     │                      │  POST /register    (RFC 7591)
     │                      ├───────────────────────────►│
     │                      │                            │
     │   authorization URL  │  (PKCE S256 challenge)     │
     │◄─────────────────────┤                            │
     │                                                   │
     │   browser → /authorize → IBMid → sign in          │
     ├──────────────────────────────────────────────────►│
     │                                                   │
     │   302 → /api/mcp/callback?code=…&state=…          │
     │◄──────────────────────────────────────────────────┤
     │                      │                            │
     ├─────────────────────►│  POST /token               │
     │                      │  grant_type=authorization_code
     │                      ├───────────────────────────►│
     │                      │  { id_token, refresh_token }
     │                      │◄───────────────────────────┤
     │                      │                            │
     │                      ├─► persist refresh_token (Elasticsearch, or /workspace/.mcp-state.json)
     │                      └─► ~/.bob/settings/mcp.json    (Authorization header)
     │   "Connected"        │
     │◄─────────────────────┤

PHASE 2 — STEADY STATE (unattended, forever)

  every 60s
     │
     ▼
  ┌────────────────────────────────────────────────┐
  │ decode exp from the cached id_token            │
  │                                                │
  │ more than 15 min left? ──── yes ──► do nothing │
  │            │                                   │
  │            no                                  │
  │            ▼                                   │
  │ POST /token  grant_type=refresh_token          │
  │            │                                   │
  │            ▼                                   │
  │ { id_token, refresh_token* }   *ROTATED        │
  │            │                                   │
  │            ├─► persist the NEW refresh token   │
  │            └─► rewrite mcp.json Authorization  │
  └────────────────────────────────────────────────┘
```

> **Refresh tokens rotate.** Every refresh may return a new one and invalidate
> its predecessor. Failing to persist the rotated value breaks the chain and
> forces a human back through Phase 1 — which is why `refreshWithStoredToken()`
> writes state before it writes the config, and why a rejected refresh sets
> `needsReauth` instead of retrying hourly against a dead grant.

### 4.3 Why `max-scale 1` is a correctness constraint

Refresh tokens rotate, and the current one must have a single owner.
Two instances refreshing independently would invalidate each other's token and
trip Carbon MCP's refresh-token _family invalidation_, dropping the connection
entirely. `min-scale 1` is equally load-bearing: an app scaled to zero runs no
timer, so the token lapses.

```
   min-scale 1  ──►  the refresh timer always has somewhere to run
   max-scale 1  ──►  exactly one writer of the rotating refresh token
```

### 4.4 The manual fallback

The console also accepts a pasted bearer token and `X-MCP-Session`, kept behind
an accordion because it is the path that leads to expiry. A pasted **session id**
still survives, since Carbon MCP refreshes it server-side; a bare bearer token
does not, and the status tile says so explicitly:

> _Connected — no refresh path. This bearer token cannot be renewed and will
> expire._

This behaviour was confirmed against the live server: a cached bearer **24 hours
past expiry** still authorized, because the session id was present.

---

## 5. Authentication model

**Sign-in is a feature flag. It is OFF in code; `.env.example` and the `deploy_ce.sh`
default turn it ON.** With the flag off the console loads straight to Operations with
no login page, and every `/api/*` route answers without a credential.

```
   AUTH_REQUIRED unset / false  ── the default ─────────────────────────────┐
                                                                           │
      any caller ─────────────────────────────────────────────────────────►│
      no login page · no session · no bearer check                         │
                                                                           ▼
                                                                  ┌─────────────────┐
   AUTH_REQUIRED=true ── opt in ──────────────────────────────┐   │  isAuthorized() │
                                                              │   └─────────────────┘
   ┌──────────────┐  session cookie (HttpOnly, SameSite=Strict, HMAC-signed)
   │  Operator    ├──────────────────────────────────────────────┐
   │  (browser)   │  CONSOLE_USERNAME / CONSOLE_PASSWORD         │
   └──────────────┘                                              ▼
                                                        ┌─────────────────┐
   ┌──────────────┐  Authorization: Bearer <API_SECRET>  │  either passes  │
   │  CI / curl   ├─────────────────────────────────────►│                 │
   └──────────────┘                                      └─────────────────┘

   Always open, regardless of the flag:
                 GET /api/health          liveness probe
                 GET /api/mcp/callback    OAuth redirect — no header possible;
                                          guarded by an unexpired one-shot
                                          `state` this process issued, and PKCE
                                          binds the exchange to a verifier only
                                          this process holds
```

The flag is **deliberately not keyed to `NODE_ENV`**. Inferring a security
posture from an unrelated variable is how a deployment ends up in a state nobody
chose; the posture is selected explicitly or not at all.

Because the default is off, the mistake that matters is now a typo while turning
it **on** — `AUTH_REQUIRED=1` silently leaving the console open while the operator
believes it is protected. So `true/1/yes/on/enabled` are all accepted,
`false/0/no/off/disabled` all decline, and anything else is **reported at startup**
rather than quietly treated as false. Every start logs the resulting posture:

```
🔓 Sign-in:        open — no authentication (set AUTH_REQUIRED=true to enable)
```

> **What "open" costs.** The Code Engine app has a public HTTPS URL. With the flag
> off, anyone holding that URL can read status and trigger a review. No secret is
> exposed — `/api/config`, `/api/mcp/status` and `/api/credits` never return
> tokens, keys or passwords — but the _actions_ are unauthenticated. Turn the flag
> on for a deployment where that matters.

### When the flag is on

The sign-in page and its cookie session are **ported from Carbon Migrate's
agent-dispatcher** and accept `CONSOLE_USERNAME` / `CONSOLE_PASSWORD`. The console
hides its "Sign out" control when the flag is off, since there is no session to
end.

> **One deliberate divergence.** Carbon Migrate's `verifyToken` checks only the
> HMAC and never reads back the timestamp it signed, so its 8-hour limit is
> enforced solely by the browser's cookie `Max-Age` — a copied token stays valid
> indefinitely. This port validates the age server-side too. The token format is
> unchanged. See `tests/sessionAuth.test.js`.

---

## 6. Review execution path

```
  POST /api/review/trigger
        │  202 Accepted immediately — a review takes minutes, far longer than
        │  Code Engine's 300s request ceiling
        ▼
  reviewPRs()                                    src/index.js
        │
        ├─► GitHub: select open PRs, fetch diff + linked issue
        │
        ├─► buildReviewBundle()                  src/reviewBundle.js
        │      creates  $BOB_WORKSPACE_ROOT/<owner>__<repo>__pull-N-XXXX/
        │      writes   pr.json · files.json · diff.patch · PR_REVIEW_REQUEST.md · .bob/
        │
        ├─► runAgent()                           src/agentRunner.js
        │      bob run --trust --accept-license [--team-id …] "<prompt>"
        │      cwd = the bundle · stdin ignored · 10-minute cap
        │           │
        │           └─► Carbon MCP tools: code_search · docs_search ·
        │               get_charts · labs_search
        │
        ├─► parseReviewOutput()                  src/reviewParser.js
        └─► post inline + summary comments, apply the AIReviewed label
        └─► Slack digest (scheduled runs only, when SLACK_WEBHOOK_URL is set)
```

**Container portability fixes** that make this work off a Mac:

| Concern      | Laptop                                    | Container                                               |
| ------------ | ----------------------------------------- | ------------------------------------------------------- |
| Bundle root  | `/private/tmp` (in Bob's trusted folders) | `$BOB_WORKSPACE_ROOT=/workspace`                        |
| Folder trust | pre-existing `trustedFolders.json`        | seeded in the image **and** `--trust`                   |
| License gate | accepted interactively                    | seeded **and** `--accept-license`                       |
| Bob auth     | browser SSO                               | `BOB_API_KEY` (+ `BOB_TEAM_ID` for `general`-type keys) |

`--trust` and `--accept-license` are idempotent no-ops on a laptop that has
already trusted the folder, so one code path serves both environments.

---

## 7. The console

Carbon React v11, built with Vite to `dist/client` and served by the same Node
process on one port — Code Engine exposes a single port per app.

```
  ┌────────────────────────────────────────────────────────────────┐
  │  Carbon Monitor                                     Sign out   │  UI Shell
  ├────────────────────────────────────────────────────────────────┤
  │  Operations                                                    │
  │  Reviewing pull requests in carbon-design-system/carbon …      │
  │                                                                │
  │  ┌───────────┐ ┌───────────┐ ┌───────────┐ ┌───────────┐       │  Grid narrow
  │  │ ✔ Bob     │ │ ✔ Carbon  │ │ ✔ GitHub  │ │ ○ Elastic │       │  4 cols @ lg
  │  │   Shell   │ │   MCP     │ │           │ │  search   │       │
  │  │ v2.0.5    │ │ auto-     │ │ 4998/5000 │ │ Not       │       │  IconIndicator
  │  │ API key   │ │ refresh   │ │ calls     │ │ configured│       │  kind=…
  │  └───────────┘ └───────────┘ └───────────┘ └───────────┘       │
  │                                                                │
  │  ┌──────────────────────────────────┐ ┌──────────────────────┐ │
  │  │ Carbon MCP connection            │ │ Reviews              │ │
  │  │  Status    Connected             │ │  State    Idle       │ │
  │  │  Renewal   Automatic             │ │  Target   3 open PRs │ │
  │  │  Cached    1:47:12               │ │                      │ │
  │  │  Signed in you@example.com       │ │  [Run review now]    │ │
  │  │                                  │ │                      │ │
  │  │  [Sign in with IBMid]            │ └──────────────────────┘ │
  │  │  [Test connection] [Refresh now] │                          │
  │  │  ▸ Enter credentials manually    │                          │
  │  └──────────────────────────────────┘                          │
  └────────────────────────────────────────────────────────────────┘
```

Built against Carbon MCP ground truth via the `carbon-builder` skill:

- Status uses **`preview__IconIndicator`** (`kind`: `succeeded` /
  `caution-major` / `failed` / `unknown`) rather than coloured Tags — it pairs
  shape with colour, so state survives colour-vision differences.
- Each logical group gets its **own `Grid`**; every `Column` sets `sm`/`md`/`lg`.
  Tile grids use `Grid narrow` with `row-gap: $spacing-05` so wrapped rows sit
  the same distance apart as the 16px gutter.
- Secrets use `PasswordInput`; every input has `labelText`.
- No `@carbon/icons-react` imports: the icon index was not returning usable
  results, and the MCP-first rule forbids guessing export names. `IconIndicator`
  supplies its own glyphs, and text-labelled buttons suit an admin console.

### IBM Plex fonts

Carbon's SCSS emits `@font-face` rules pointing at `~@ibm/plex/…`. The tilde is
webpack's `node_modules` escape hatch and means nothing to Vite, so those URLs
would ship unresolved and every glyph would fall back to a system font.
`styles.scss` overrides `$font-path` to `/plex`, and `scripts/copy-plex-fonts.js`
stages the referenced files there — 272 files, ~4 MB, self-hosted so the console
makes no third-party request.

---

## 8. Deployment

`./deploy_ce.sh` reads its target from `.env` (see `.env.example`):

| Variable             | Example                           |
| -------------------- | --------------------------------- |
| `REGION`             | `us-south` (registry `us.icr.io`) |
| `RESOURCE_GROUP`     | `my-resource-group`               |
| `PROJECT`            | `my-code-engine-project`          |
| `NAMESPACE`          | `my-registry-namespace`           |
| `APP` / `IMAGE_NAME` | `carbon-monitor`                  |
| `SECRET_NAME`        | `carbon-monitor-secrets`          |
| `REGISTRY_SECRET`    | `icr-secret`                      |

```
  verify Bob download host reachable      ← fails in ms, not minutes
        ▼
  ibmcloud login · ce project select
        ▼
  ensure the registry secret exists
        ▼
  sync carbon-monitor-secrets from .env   ← refuses to deploy without credentials
        ▼
  npm run build:client                    ← console built on the host
        ▼
  podman build --platform linux/amd64
        ▼
  podman push → digest                    ← deployed by digest, never by tag
        ▼
  ce app create/update  (BASE_URL folded into the SAME revision)
        ▼
  verify_timeout                          ← reads the FINAL revision
        ▼
  annotate_kservice  (TBC=0)              ← MUST be the last control-plane write
```

**Two ordering contracts, inherited from the carbon-mcp exemplar:**

1. `BASE_URL` is resolved _before_ the write and folded into the same revision.
   It is the OAuth `redirect_uri`, so a revision without it sends operators to a
   callback on the wrong host and "Sign in with IBMid" fails.
2. `annotate_kservice` must be **last**. Code Engine exposes no flag for
   `target-burst-capacity`, so any `ce app update` after the `kubectl patch`
   mints a fresh revision and silently strips `TBC=0`, putting the Knative
   activator back in the request path.

### First run

```bash
cp .env.example .env   # fill in credentials and the deployment target
./deploy_ce.sh         # syncs the secret from .env, builds, pushes, deploys
```

Open the console, sign in, and press **Sign in with
IBMid** once. After that the container renews its own token.

> `SESSION_SIGNING_KEY` should be set explicitly. Without it the server falls
> back to a per-process random key, and every restart signs all operators out.

---

## 9. Local development

Nothing above requires a container to work on.

```bash
npm install
npm run build:client       # stages IBM Plex, builds to dist/client
npm run api                # http://localhost:3000 — console + API

# Optional: live-reloading console against the running API
npm run dev:client         # http://localhost:5173, proxies /api → :3000
```

Sign-in is off in code (on in `.env.example`). To exercise the real login flow:

```bash
AUTH_REQUIRED=true CONSOLE_USERNAME=operator CONSOLE_PASSWORD=secret \
  SESSION_SIGNING_KEY=dev-key npm run api
```

```bash
npm run test:all
```

---

## 10. Configuration reference

| Variable                                | Purpose                                                          | Default                                     |
| --------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------- |
| `PORT`                                  | HTTP port (Code Engine injects this)                             | `API_PORT`, then `3000`                     |
| `BASE_URL`                              | Public URL; the OAuth `redirect_uri` derives from it             | request headers                             |
| `ES_USERNAME` / `ES_PASSWORD`           | Elasticsearch                                                    | —                                           |
| `CONSOLE_USERNAME` / `CONSOLE_PASSWORD` | Console sign-in when `AUTH_REQUIRED` is on                       | —                                           |
| `AUTH_REQUIRED`                         | **Feature flag** — require a console sign-in                     | `false` (open)                              |
| `SESSION_SIGNING_KEY`                   | HMAC key for session cookies                                     | `API_SECRET`, else per-process random       |
| `API_SECRET`                            | Bearer token for machine callers                                 | —                                           |
| `BOB_API_KEY`                           | Bob Shell headless auth                                          | —                                           |
| `BOB_TEAM_ID`                           | Adds `--team-id`; only for `general`-type keys                   | unset                                       |
| `BOB_WORKSPACE_ROOT`                    | Review bundle root                                               | `/private/tmp` on macOS, else `os.tmpdir()` |
| `BOB_CHECK_TIMEOUT_MS`                  | Health-check budget for `bob --version`                          | `20000`                                     |
| `MCP_STATE_PATH`                        | Where the rotating refresh token is persisted                    | `~/.config/carbon-monitor/mcp-state.json`   |
| `MCP_REFRESH_MARGIN_SEC`                | Renew this far before expiry                                     | `900`                                       |
| `MCP_REFRESH_CHECK_MS`                  | Timer interval                                                   | `60000`                                     |
| `SCHEDULE_TIMEZONE`                     | Zone of the scheduled run time; the console converts for display | `America/Chicago`                           |
| `CARBON_MCP_URL`                        | Carbon MCP endpoint                                              | `https://mcp.carbondesignsystem.com/mcp`    |
| `GITHUB_AI_AGENT_TOKEN`                 | GitHub API access                                                | —                                           |

See [`.env.example`](../.env.example) for the full set.

---

## 11. API surface

| Method         | Path                     | Auth         | Purpose                                             |
| -------------- | ------------------------ | ------------ | --------------------------------------------------- |
| `GET`          | `/api/health`            | none         | Liveness probe                                      |
| `GET`          | `/api/auth/status`       | none         | Whether sign-in is required / satisfied             |
| `POST`         | `/api/auth/login`        | none         | Exchange credentials for a session cookie           |
| `POST`         | `/api/auth/logout`       | none         | Clear the session                                   |
| `GET`          | `/api/mcp/callback`      | state + PKCE | OAuth redirect target                               |
| `GET`          | `/api/status`            | yes          | All dependency checks                               |
| `GET`          | `/api/config`            | yes          | Sanitized configuration                             |
| `GET`          | `/api/mcp/status`        | yes          | Connection detail, no secrets                       |
| `POST`         | `/api/mcp/connect`       | yes          | Begin the OAuth bootstrap                           |
| `POST`         | `/api/mcp/refresh`       | yes          | Force refresh, or store pasted credentials          |
| `POST`         | `/api/mcp/test`          | yes          | Live probe (also repairs a session connection)      |
| `POST`         | `/api/review/trigger`    | yes          | Start a review (202, background)                    |
| `GET`          | `/api/review/status`     | yes          | Current or last run                                 |
| `POST`         | `/api/mcp/disconnect`    | yes          | Forget the stored grant and strip Bob's MCP headers |
| `GET`          | `/api/credits`           | yes          | Bobcoins balance                                    |
| `GET`          | `/api/credits/history`   | yes          | Per-review spend                                    |
| `GET`          | `/api/review/logs`       | yes          | Log tail of the current or last run                 |
| `POST`         | `/api/review/logs/clear` | yes          | Clear that log                                      |
| `GET` / `POST` | `/api/schedule`          | yes          | Read or set the review schedule                     |

`POST /api/mcp/refresh` keeps its original contract: a body carrying `token`
and/or `sessionId` stores those credentials, exactly as the existing runbooks in
[`MCP_TOKEN_REFRESH.md`](MCP_TOKEN_REFRESH.md) describe. An empty body is the new
behaviour — force a refresh using the stored OAuth grant.

---

## 12. Module map

```
src/
├── index.js                  review orchestration (also the CLI entrypoint)
├── constants.js              env-driven defaults: owner, repo, label, limits
├── loadEnv.js                dotenv bootstrap (.env wins over the shell)
├── agentRunner.js            spawns bob (claude/codex paths exist, unsupported)
├── reviewBundle.js           builds the agent workspace  [getWorkspaceRoot]
├── reviewPrompt.js           review prompt; summary and inline comment text
├── githubClient.js           PRs, diffs, comments, labels
├── reviewParser.js           parses agent output into findings
├── diffMapper.js             maps findings to diff line numbers
├── slackNotifier.js          end-of-run digest to a Slack webhook
├── textUtils.js              shared text helpers
├── config/env.js             trimmed env reads for Elasticsearch
├── observability/
│   ├── esClient.js           Elasticsearch client with circuit breaker
│   └── eventService.js       review events written to Elasticsearch
└── api/
    ├── server.js             HTTP server, routing, static console
    ├── mcpConnection.js      OAuth, refresh timer, mcp.json, probe, ES state   ★
    ├── healthChecks.js       dependency probes for the status panel
    ├── sessionAuth.js        cookie sessions (ported from Carbon Migrate)
    ├── bobCredits.js         Bobcoins balance from the Bob gateway
    ├── creditLedger.js       per-review spend ledger
    ├── reviewLog.js          log tail for the console
    ├── scheduleManager.js    scheduled review runs
    └── tokenManager.js       compatibility shim → mcpConnection

client/src/
├── App.jsx                   login vs console
├── api.js                    fetch wrapper
├── pages/Login.jsx           ported from Carbon Migrate
├── pages/Console.jsx         status panel + controls
├── pages/HelpGuide.jsx       in-app help guide
├── utils/prPhrasing.js       PR phrasing helpers
└── components/
    ├── StatusTile.jsx        IconIndicator tile
    ├── ExpiryCountdown.jsx   live token countdown
    ├── McpConnectionPanel.jsx  connect · test · refresh · disconnect · manual entry
    ├── BobcoinsPanel.jsx     balance and spend history
    ├── SchedulePanel.jsx     scheduled reviews settings
    ├── ReviewLog.jsx         live log tail
    ├── AboutAi.jsx           about the AI review
    └── ErrorBoundary.jsx     root error boundary
```

★ `mcpConnection.js` is the single writer of `~/.bob/settings/mcp.json`.
`tokenManager.js` delegates to it rather than reimplementing the write — two
independent writers would silently clobber each other.

---

## 13. Known constraints

- **Bob Shell cannot be a `package.json` dependency.** It is distributed only as
  a tarball from IBM Cloud Object Storage. Moving versions means updating both
  `BOB_VERSION` and `BOB_SHA256` in the Dockerfile.
- **One instance only.** See §4.3. Horizontal scaling requires moving refresh
  state to shared storage and electing a single refresher.
- **OAuth needs one human, once.** Carbon MCP advertises no
  `device_authorization` grant, so a fully unattended cold start is not possible
  today. If that grant is added, the bootstrap could be automated entirely.
- **`/workspace` is container-local.** The cloud deploy sets
  `MCP_STATE_BACKEND=elasticsearch`, so the refresh token survives an instance
  replacement. Without Elasticsearch a rescheduled instance loses it and an
  operator signs in again.
