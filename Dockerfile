# ─────────────────────────────────────────────────────────────────────────────
# Carbon Monitor — IBM Cloud Code Engine image
#
# BASE IMAGE: Debian (glibc)
#
#   Bob Shell depends on @lydell/node-pty, whose Linux prebuild is a dynamically
#   linked ELF requiring GLIBC_2.28+ (verified with `strings pty.node`). It
#   publishes no musl variant, so on Alpine the binary cannot load and `bob`
#   fails at startup. Bob's own dist/vscode-policy-watcher.node is likewise a
#   glibc x86-64 ELF. bookworm-slim provides glibc 2.36.
#
# NODE VERSION: 24, because Bob Shell's install page requires Node.js 24 or later
#   (https://bob.ibm.com/docs/shell/getting-started/install-and-setup). The build
#   verifies that bob 2.0.5 installs and starts on it.
# ─────────────────────────────────────────────────────────────────────────────

# ---- Dependencies (production only) ----
FROM node:24-bookworm-slim AS deps
WORKDIR /app

COPY package.json package-lock.json ./

# `npm ci` installs exactly what the committed lockfile records.
#
# --registry is pinned explicitly because a developer's ~/.npmrc may default to
# IBM Artifactory. That registry needs credentials the image does not carry, and
# the failure surfaces minutes into the build as an opaque E401.
RUN npm ci --omit=dev --registry=https://registry.npmjs.org/ --no-audit --no-fund

# ---- Runtime ----
FROM node:24-bookworm-slim

ENV NODE_ENV=production

# Bob Shell version, pinned so an upstream release cannot silently change what
# ships. Verified against the SHA-256 published alongside the tarball; override
# both together at build time to move versions:
#   podman build --build-arg BOB_VERSION=x.y.z --build-arg BOB_SHA256=... .
ARG BOB_VERSION=2.0.5
ARG BOB_SHA256=eff232eb1b69f34f984ddd295e6960470058ca922b1c751879c5a8d06199f566
ARG BOB_DOWNLOAD_BASE=https://s3.us-south.cloud-object-storage.appdomain.cloud/bob-shell

# curl for the download and the healthcheck; ca-certificates so TLS to the Carbon
# MCP host and GitHub verifies; git because review bundles are git workspaces.
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates git \
  && rm -rf /var/lib/apt/lists/*

# ---- Bob Shell ----
#
# Installed by replicating what https://bob.ibm.com/download/bobshell.sh does,
# rather than piping that script into a shell. The script is interactive (it can
# prompt for a package manager and reads from /dev/tty), requires bash, and
# resolves "latest" at build time — none of which belong in a reproducible image
# build. The steps below are the same ones it performs, with the version pinned
# and the checksum enforced.
RUN set -eux; \
  curl -fsSL "${BOB_DOWNLOAD_BASE}/bobshell-${BOB_VERSION}.tgz" -o /tmp/bobshell.tgz; \
  echo "${BOB_SHA256}  /tmp/bobshell.tgz" | sha256sum -c -; \
  npm install -g --registry=https://registry.npmjs.org/ --no-audit --no-fund /tmp/bobshell.tgz; \
  rm -f /tmp/bobshell.tgz; \
  bob --version

WORKDIR /app

# Non-root, with a real home directory: Bob writes its settings, MCP
# configuration and OAuth state under $HOME, and the app rewrites
# ~/.bob/settings/mcp.json on every token refresh.
RUN groupadd -r app && useradd -r -g app -m -d /home/app app

COPY --from=deps --chown=app:app /app/node_modules ./node_modules
COPY --chown=app:app package.json ./
COPY --chown=app:app src ./src
COPY --chown=app:app docs ./docs

# The Carbon Builder skill. reviewBundle.js copies .bob/skills/carbon-builder
# into each review bundle, because Bob resolves skills from the workspace's own
# .bob/skills directory rather than from $HOME.
#
# Not optional: without it the copy fails with ENOENT, the skill never loads, and
# every Carbon-specific claim silently falls back to MCP. The review still
# completes and still posts comments — it just loses its primary authority, which
# is the failure mode worth guarding because nothing about the output announces
# it. The verification below turns that into a build failure instead.
#
# The repo copy is the FALLBACK; the authoritative version is fetched next.
COPY --chown=app:app .bob ./.bob

# ---- Refresh the skill from its source of truth ----
#
# carbon-mcp publishes the canonical carbon-builder skill, and the copy vendored
# in this repo drifts behind it — at the time of writing it was missing three
# reference files and its SKILL.md was 23 lines stale. A stale skill does not
# fail loudly; it just answers Carbon questions from an older rulebook, which is
# precisely the kind of silent degradation worth engineering against.
#
# CARBON_SKILL_REF may be a branch, a tag or a 40-hex commit SHA. A SHA is fetched
# as that commit; anything else is tried as a tag, then as a branch. Branches are
# the default so a rebuild picks up skill improvements without a code change; set
# a tag or SHA when a byte-identical rebuild matters more than freshness.
ARG CARBON_SKILL_REPO=carbon-design-system/carbon-mcp
ARG CARBON_SKILL_REF=main
ARG CARBON_SKILL_PATH=public/skills/carbon-builder
# Optional SHA-256 of the downloaded tarball, checked with sha256sum -c. GitHub
# does not promise byte-stable tarballs for branches and tags, so pair it with a SHA ref.
ARG CARBON_SKILL_SHA256=
# true makes a failed fetch or a checksum mismatch fail the build instead of
# falling back to the vendored copy.
ARG CARBON_SKILL_STRICT=false

# Failure here is NOT fatal by default: the vendored copy above is already in
# place, so a GitHub outage or a moved path degrades to "slightly stale" rather
# than blocking a deploy. It is loud, and it records which source won in
# skill-source.txt so the choice is auditable after the fact instead of being
# guessed from a build log nobody kept.
RUN set -eux; \
  SKILL_DIR=/app/.bob/skills/carbon-builder; \
  TMP=$(mktemp -d); \
  mkdir "${TMP}/skill"; \
  STRIP=$(( $(printf '%s' "${CARBON_SKILL_PATH}" | tr -cd '/' | wc -c) + 2 )); \
  if printf '%s' "${CARBON_SKILL_REF}" | grep -Eq '^[0-9a-f]{40}$'; then \
    URLS="https://codeload.github.com/${CARBON_SKILL_REPO}/tar.gz/${CARBON_SKILL_REF}"; \
  else \
    URLS="https://codeload.github.com/${CARBON_SKILL_REPO}/tar.gz/refs/tags/${CARBON_SKILL_REF} https://codeload.github.com/${CARBON_SKILL_REPO}/tar.gz/refs/heads/${CARBON_SKILL_REF}"; \
  fi; \
  FAIL="no tarball found for ${CARBON_SKILL_REF}"; \
  for URL in ${URLS}; do \
    if curl -fsSL --max-time 120 "${URL}" -o "${TMP}/repo.tgz" 2>/dev/null; then FAIL=; break; fi; \
  done; \
  if [ -z "${FAIL}" ] && [ -n "${CARBON_SKILL_SHA256}" ] \
     && ! echo "${CARBON_SKILL_SHA256}  ${TMP}/repo.tgz" | sha256sum -c -; then \
    FAIL="checksum mismatch for the downloaded tarball"; \
  fi; \
  TOP=; \
  if [ -z "${FAIL}" ]; then TOP=$(tar -tzf "${TMP}/repo.tgz" 2>/dev/null | head -n 1 | cut -d/ -f1); fi; \
  if [ -z "${FAIL}" ] && [ -n "${TOP}" ] \
     && tar -xzf "${TMP}/repo.tgz" -C "${TMP}/skill" --strip-components="${STRIP}" \
          "${TOP}/${CARBON_SKILL_PATH}" 2>/dev/null \
     && [ -f "${TMP}/skill/SKILL.md" ]; then \
    rm -rf "${SKILL_DIR}"; \
    mkdir -p "${SKILL_DIR}"; \
    cp -R "${TMP}/skill/." "${SKILL_DIR}/"; \
    echo "${CARBON_SKILL_REPO}@${CARBON_SKILL_REF} (downloaded $(date -u +%Y-%m-%dT%H:%M:%SZ))" \
      > "${SKILL_DIR}/skill-source.txt"; \
    echo "carbon-builder: refreshed from ${CARBON_SKILL_REPO}@${CARBON_SKILL_REF}"; \
  else \
    echo "WARNING: could not fetch carbon-builder from ${CARBON_SKILL_REPO}@${CARBON_SKILL_REF}: ${FAIL:-${CARBON_SKILL_PATH} not found in the tarball}."; \
    if [ "${CARBON_SKILL_STRICT}" = "true" ]; then \
      echo "FATAL: CARBON_SKILL_STRICT=true, refusing to fall back to the vendored copy."; \
      exit 1; \
    fi; \
    echo "WARNING: falling back to the copy vendored in this repo, which may be stale."; \
    echo "vendored in carbon-monitor (upstream fetch failed at build time)" \
      > "${SKILL_DIR}/skill-source.txt"; \
  fi; \
  rm -rf "${TMP}"; \
  chown -R app:app "${SKILL_DIR}"; \
  echo "carbon-builder files: $(find ${SKILL_DIR} -type f | wc -l)"

# Whichever source won, the skill must exist. This is the check that would have
# caught the .dockerignore exclusion that shipped an image without it.
RUN test -f /app/.bob/skills/carbon-builder/SKILL.md \
  || (echo "FATAL: carbon-builder skill missing from the image. Check .dockerignore." && exit 1)

# Pre-built console bundle. Built on the host by `npm run build:client` so the
# runtime image needs no Vite, Sass or React — matching the carbon-mcp exemplar.
COPY --chown=app:app dist ./dist

# Seed Bob's state so a cold container never blocks on an interactive prompt.
# licenseConsent short-circuits the license gate, and the review workspace is
# pre-trusted so Bob does not disable MCP tools on an unrecognised folder.
# `bob run` also passes --trust and --accept-license as a second line of defence.
# tasks.retentionDays: 1 because task history must not accumulate on ephemeral storage.
RUN mkdir -p /home/app/.bob/settings /home/app/.bob/skills /workspace \
  && printf '%s\n' '{"ibm":{"licenseConsent":true,"isNotFirstTime":true}}' \
     > /home/app/.bob/settings.json \
  && printf '%s\n' '{"/workspace":true}' > /home/app/.bob/trustedFolders.json \
  && printf '%s\n' '{"mcpServers":{}}' > /home/app/.bob/settings/mcp.json \
  && printf '%s\n' '{"tasks":{"retentionDays":1}}' \
     > /home/app/.bob/settings/settings.json \
  && cp -R /app/.bob/skills/carbon-builder /home/app/.bob/skills/carbon-builder \
  && chown -R app:app /home/app /workspace

USER app
ENV HOME=/home/app

# Review bundles are written here. /workspace rather than /tmp so the path is
# stable, owned by the app user, and can be backed by a Code Engine mount.
ENV BOB_WORKSPACE_ROOT=/workspace

# Local-dev fallback location for the connection state. NOTE: /workspace is
# EPHEMERAL in Code Engine, so a state file here does NOT survive an instance
# replacement. In the cloud, deploy_ce.sh sets MCP_STATE_BACKEND=elasticsearch so
# the refresh token is persisted to Elasticsearch (durable) instead of this file.
ENV MCP_STATE_PATH=/workspace/.mcp-state.json

# Code Engine injects PORT; 8080 documents the default for local runs.
ENV PORT=8080
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl --fail "http://127.0.0.1:${PORT:-8080}/api/health" || exit 1

# The API server, not src/index.js: this deployment is the long-running console
# that owns MCP refresh and triggers reviews, rather than a one-shot review run.
CMD ["node", "src/api/server.js"]
