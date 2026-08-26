#!/usr/bin/env zsh
# or: #!/usr/bin/env bash

# sed -i '' 's/\r$//' ./deploy_ce.sh
# chmod +x ./deploy_ce.sh

set -euo pipefail

# Deploys Carbon Monitor to IBM Cloud Code Engine.
#

export NODE_ENV=production

[ -f .env ] && set -o allexport && source .env && set +o allexport

# -------- Config (override via env or .env) --------
: "${REGION:=us-south}"
: "${RESOURCE_GROUP:=Carbon Experience Platform STAGING}"
: "${PROJECT:=mcp-ce}"
: "${NAMESPACE:=cxp-mcp}"

: "${APP:=carbon-monitor}"
: "${IMAGE_NAME:=carbon-monitor}"
: "${VERSION:=1.0.4}"     # override per release, or VERSION=$(date +%Y%m%d%H%M%S)

# Secret holding this app's credentials. 
: "${SECRET_NAME:=carbon-monitor-secrets}"

# ── Scaling ──────────────────────────────────────────────────────────────────
#
# MIN_SCALE=1 and MAX_SCALE=1 are CORRECTNESS constraints here, not tuning:
#
#   min-scale 1 — the whole point of this deployment is the background timer
#     that renews the Carbon MCP token before it expires. An app scaled to zero
#     runs no timer, so the token lapses and the next review fails. It must stay
#     resident.
#
#   max-scale 1 — Carbon MCP ROTATES refresh tokens: each refresh returns a new
#     one and invalidates its predecessor. Two instances refreshing independently
#     would invalidate each other's token and trip the server's refresh-token
#     family detection, forcing an operator back through the browser sign-in. A
#     single writer is the only safe configuration while refresh state lives in
#     the instance's own filesystem.
#
# Concurrency carries the load instead: this is a low-traffic operator console,
# and reviews run in a background child process rather than in a request.
: "${MIN_SCALE:=1}"
: "${MAX_SCALE:=1}"

# Console sign-in feature flag. This deployment REQUIRES a login — operators sign
# in with CONSOLE_USERNAME / CONSOLE_PASSWORD from the secret. .env sets
# AUTH_REQUIRED=true and is sourced above; the default here matches so a deploy is
# never accidentally left open. Override with AUTH_REQUIRED=false only for a
# deliberate open deployment — and note the app is on a public HTTPS URL, so with
# sign-in off anyone holding the URL can read status and trigger a review.
: "${AUTH_REQUIRED:=true}"

# CPU / memory. Sized for THIS workload, not padded: reviews are single-flight
# (one at a time) and top out at ~50 PRs/day, and the heavy lifting — the LLM
# inference — happens remotely on the Bob gateway, so the container is I/O- and
# latency-bound, not CPU-bound. 1 vCPU / 2 GB holds a bounded review bundle
# (GITHUB_AI_AGENT_MAX_INPUT_TOKENS ≈ 512 KB of prompt) plus Bob and Node with
# headroom. The app runs 24/7 (min-scale 1), so this is what is billed around the
# clock — halving it from 2 vCPU / 4 GB roughly halves that standing cost. If a
# very large PR ever OOM-kills a review, raise MEMORY to 4G (a valid 1 vCPU / 4 GB
# pairing) rather than reaching for more CPU.
: "${CPU:=1}"
: "${MEMORY:=2G}"
: "${CONCURRENCY:=100}"
: "${REQUEST_TIMEOUT:=300}"   # CE and Bob cap is 300s (5m)
: "${SCALE_DOWN_DELAY:=300}"

case "$REGION" in
  us-south) REG_HOST="us.icr.io" ;;
  eu-de)    REG_HOST="de.icr.io" ;;
  eu-gb)    REG_HOST="uk.icr.io" ;;
  jp-tok|jp-osa) REG_HOST="jp.icr.io" ;;
  au-syd)   REG_HOST="au.icr.io" ;;
  *)        REG_HOST="icr.io" ;;
esac

IMAGE="${REG_HOST}/${NAMESPACE}/${IMAGE_NAME}:${VERSION}"

# -------- Utils --------
RED=$'%{\e[31m%}'; GRN=$'%{\e[32m%}'; YLW=$'%{\e[33m%}'; BLU=$'%{\e[34m%}'; CLR=$'%{\e[0m%}'
log() { print -P "${BLU}==>${CLR} $*"; }
ok()  { print -P "${GRN}✔${CLR} $*"; }
warn(){ print -P "${YLW}⚠${CLR} $*"; }
die() { print -P "${RED}✘${CLR} $*" >&2; exit 1; }
need(){ command -v "$1" >/dev/null 2>&1 || die "Missing command '$1'"; }

need ibmcloud
need podman
need kubectl
need npm

# -------- Preflight: Bob Shell must be reachable from the build --------
#
# The image installs Bob Shell from IBM Cloud Object Storage. That host is not
# on the public npm registry and is not mirrored, so if it is unreachable the
# build fails several minutes in, after the client build and the base-image pull.
# Checking first costs a fraction of a second.
verify_bob_source() {
  local base="https://s3.us-south.cloud-object-storage.appdomain.cloud/bob-shell"
  local version
  version=$(curl -fsS --max-time 20 "${base}/bobshell2-version.txt" 2>/dev/null | tr -d '\r\n' || true)
  if [ -z "${version:-}" ]; then
    warn "Could not reach the Bob Shell download host:"
    warn "  ${base}"
    warn "The image build installs Bob from there and will fail without it."
    die "Check your network/VPN and retry."
  fi
  ok "Bob Shell download host reachable (latest published: ${version})"

  # The Dockerfile pins a version and its checksum on purpose. A newer upstream
  # release is fine and is NOT an error — but it is worth surfacing, because the
  # pin is what keeps the image reproducible and only a human should move it.
  local pinned
  pinned=$(awk -F= '/^ARG BOB_VERSION=/{print $2; exit}' Dockerfile | tr -d ' \r')
  if [ -n "${pinned:-}" ] && [ "${pinned}" != "${version}" ]; then
    warn "Dockerfile pins Bob Shell ${pinned}; ${version} is now published."
    warn "To move: update BOB_VERSION and BOB_SHA256 (from ${base}/bobshell-${version}.tgz.sha256)."
  fi
}
verify_bob_source

# -------- Helpers --------
verify_timeout() {
  log "Verifying request-timeout == ${REQUEST_TIMEOUT}s on active revision…"
  local out t
  if out=$(ibmcloud ce app get --name "$APP" --output json 2>/dev/null); then
    t=$(printf "%s" "$out" | awk -F'"' '/"timeout"/{print $4; exit}')
  else
    out=$(ibmcloud ce app get --name "$APP")
    t=$(printf "%s" "$out" | awk -F': ' '/Request timeout|Timeout/{print $2; exit}')
  fi

  if [ -z "${t:-}" ]; then
    warn "Could not parse timeout from CE output. Showing raw:"
    echo "$out" >&2
    warn "Proceeding, but please confirm in the CE UI."
    return 0
  fi

  t="${t//[^0-9]/}"
  if [ "${t}" != "${REQUEST_TIMEOUT}" ]; then
    die "Request timeout is '${t}', expected '${REQUEST_TIMEOUT}'. Check CE quotas/flags."
  fi
  ok "Timeout is ${t}s ✔"
}

# Code Engine gives every app in a project the SAME domain suffix, so the URL of
# a not-yet-created app can be derived from any sibling app — carbon-mcp is
# already deployed in this project, which makes the derivation reliable here.
#
# Why it matters: BASE_URL is the OAuth redirect_uri this app registers with
# Carbon MCP. A first revision without it would send operators to a callback on
# the wrong host, so "Sign in with IBMid" would fail until a second write landed.
#
# Prints nothing and returns 0 when no suffix can be derived; the caller then
# falls back to the post-create correction. MUST stay silent otherwise — its
# stdout IS its return value.
predict_app_url() {
  local sibling suffix
  sibling=$(ibmcloud ce app list 2>/dev/null | awk 'NR>1 && $1 != "" {print $1; exit}' || true)
  [ -n "${sibling:-}" ] || return 0
  suffix=$(ibmcloud ce app get -n "$sibling" 2>/dev/null \
    | awk '/^URL:/ {print $2; exit}' \
    | sed -E 's#^https?://[^.]+\.##' || true)
  [ -n "${suffix:-}" ] || return 0
  printf 'https://%s.%s' "$APP" "$suffix"
}

ensure_kubectl_ctx() {
  log "Ensuring kubectl is pointed at the Code Engine project '${PROJECT}'…"
  local line
  line=$(ibmcloud ce project select --name "$PROJECT" --kubecfg 2>/dev/null | grep -E '^export KUBECONFIG=' || true)
  if [ -n "$line" ]; then
    eval "$line"
  fi
  kubectl version --client >/dev/null
  kubectl get ns >/dev/null
  ok "kubectl context ready ✔"
}

annotate_kservice() {
  log "Annotating Knative Service '${APP}' (autoscaling annotations on spec.template.metadata.annotations)…"

  local NS
  NS=$(kubectl config view --minify -o jsonpath='{..namespace}' 2>/dev/null || true)
  if [ -z "$NS" ]; then
    local cejson
    cejson=$(ibmcloud ce app get --name "$APP" --output json 2>/dev/null || true)
    NS=$(printf "%s" "$cejson" | awk -F'"' '/"kubeNamespace"|"namespace":/ {print $4; exit}')
  fi
  [ -n "$NS" ] || die "Could not determine namespace; re-run: ibmcloud ce project select --name ${PROJECT} --kubecfg"

  kubectl -n "$NS" get kservice "$APP" >/dev/null 2>&1 \
    || die "kservice/${APP} not found in namespace '${NS}'"

  # target-burst-capacity ONLY. minScale is deliberately NOT set here: it is
  # already set by --min-scale on the CE app update above, and setting it in two
  # places lets them drift silently (CE owns the flag, so a CE write wins and the
  # annotation becomes a lie). TBC has no CE flag at all, which is the entire
  # reason this patch exists — it keeps the Knative activator out of the request
  # path.
  cat > /tmp/ksvc_patch_${APP}.json <<EOF
{
  "spec": {
    "template": {
      "metadata": {
        "annotations": {
          "autoscaling.knative.dev/target-burst-capacity": "0"
        }
      }
    }
  }
}
EOF

  kubectl -n "$NS" patch kservice "$APP" --type merge --patch-file /tmp/ksvc_patch_${APP}.json 1>/dev/null

  log "Current spec.template.metadata.annotations on kservice/${APP} in ${NS}:"
  kubectl -n "$NS" get kservice "$APP" \
    -o jsonpath='{.spec.template.metadata.annotations}' \
    | sed 's/\\n/\n/g' | sed 's/[{}]//g' || true
  echo

  # READ-BACK. Ordering this function last is what protects TBC=0; this proves it
  # actually stuck. If it reports otherwise, a CE `app update` ran after the patch
  # and stripped it — move that write above verify_timeout.
  local tbc
  tbc=$(kubectl -n "$NS" get kservice "$APP" \
    -o jsonpath='{.spec.template.metadata.annotations.autoscaling\.knative\.dev/target-burst-capacity}' 2>/dev/null || true)
  if [ "${tbc:-}" = "0" ]; then
    ok "target-burst-capacity=0 confirmed on the revision template ✔"
  else
    warn "target-burst-capacity is '${tbc:-<absent>}', expected '0'."
    warn "Re-apply: kubectl -n ${NS} patch kservice ${APP} --type merge --patch-file /tmp/ksvc_patch_${APP}.json"
  fi
  ok "KSVC template annotations applied ✔"
}

# -------- Start podman if not running --------
log "Checking Podman machine status..."
if ! podman info >/dev/null 2>&1; then
  if ! podman machine list | grep -q '^podman'; then
    log "No Podman machine found. Initializing..."
    podman machine init
  fi
  log "Starting Podman machine..."
  podman machine start
  ok "Podman machine is running ✔"
else
  ok "Podman is already running ✔"
fi

# -------- Target CE project --------
ibmcloud config --check-version=false >/dev/null
ibmcloud config --http-timeout 600
ibmcloud login --apikey "${IBMCLOUD_API_KEY:?Set IBMCLOUD_API_KEY}" -r "$REGION" -g "$RESOURCE_GROUP"
ibmcloud ce project select --name "$PROJECT" 1>/dev/null || die "CE project '$PROJECT' not found; run setup first."

# -------- Sync the runtime secret from .env --------
#
# .env is the single source of truth; this mirrors the runtime credentials from
# it into a Code Engine secret on every deploy.
#
# Why a secret rather than plain --env flags, given the values are right here:
# Code Engine stores --env values in the APP SPEC, in plaintext. They show up in
# `ibmcloud ce app get`, the CE console, `kubectl get ksvc -o yaml`, and in every
# retained revision — so a token set that way is readable by anyone with read
# access to this shared project, and stays readable in revision history after
# rotation. A secret is stored separately, redacted in app output, referenced by
# name, and rotates by updating the secret rather than minting a revision.
#
# IBMCLOUD_API_KEY is deliberately NOT included: it authenticates this deploy,
# and the running app has no use for it. Shipping it would hand every reviewer
# process a credential that can redeploy the app.
typeset -a SECRET_KEYS
SECRET_KEYS=(
  GITHUB_AI_AGENT_TOKEN
  BOB_API_KEY
  BOB_TEAM_ID
  BOB_INSTANCE_ID
  ES_URL
  ES_USERNAME
  ES_PASSWORD
  ES_CA_CERT_PATH
  CONSOLE_USERNAME
  CONSOLE_PASSWORD
  SESSION_SIGNING_KEY
  API_SECRET
)

log "Syncing secret '${SECRET_NAME}' from .env…"

# Credentials without which the app starts, looks healthy, and fails every review.
[ -n "${GITHUB_AI_AGENT_TOKEN:-}" ] || die "GITHUB_AI_AGENT_TOKEN is not set (.env or environment)."
[ -n "${BOB_API_KEY:-}" ] || die "BOB_API_KEY is not set (.env or environment). Bob cannot authenticate headlessly without it — SSO is interactive-only."

if [ "${AUTH_REQUIRED}" = "true" ]; then
  { [ -n "${CONSOLE_USERNAME:-}" ] && [ -n "${CONSOLE_PASSWORD:-}" ]; } \
    || die "AUTH_REQUIRED=true needs CONSOLE_USERNAME and CONSOLE_PASSWORD — nobody could sign in otherwise."
  [ -n "${SESSION_SIGNING_KEY:-}" ] \
    || warn "SESSION_SIGNING_KEY is empty; sessions will not survive a restart. Generate one with: openssl rand -hex 32"
fi

# Written to a file rather than passed as --from-literal arguments so the values
# never appear in this machine's process list. 0600 and removed on any exit.
SECRET_ENV_FILE="$(mktemp -t carbon-monitor-secret)"
chmod 600 "$SECRET_ENV_FILE"
trap 'rm -f "$SECRET_ENV_FILE"' EXIT INT TERM

typeset -a SYNCED
SYNCED=()
for key in "${SECRET_KEYS[@]}"; do
  value="${(P)key:-}"
  [ -n "$value" ] || continue
  print -r -- "${key}=${value}" >> "$SECRET_ENV_FILE"
  SYNCED+=("$key")
done

if ibmcloud ce secret get --name "$SECRET_NAME" >/dev/null 2>&1; then
  ibmcloud ce secret update --name "$SECRET_NAME" --from-env-file "$SECRET_ENV_FILE" >/dev/null
  ok "Updated secret '${SECRET_NAME}' — keys: ${SYNCED[*]}"
else
  ibmcloud ce secret create --name "$SECRET_NAME" --from-env-file "$SECRET_ENV_FILE" >/dev/null
  ok "Created secret '${SECRET_NAME}' — keys: ${SYNCED[*]}"
fi

rm -f "$SECRET_ENV_FILE"
trap - EXIT INT TERM

# `secret update` MERGES: a key removed from .env keeps its old value in the
# secret rather than disappearing. Said out loud because the alternative — a
# stale credential silently outliving its removal — is not something to discover
# during an incident.
warn "Note: keys removed from .env are not deleted from the secret."
warn "      Remove one explicitly with: ibmcloud ce secret update --name ${SECRET_NAME} --rm KEY"

# -------- Build the console bundle locally (Vite) --------
#
# Built on the host, not in the image, so the runtime carries no build toolchain.
log "Building console (Vite) bundle locally..."
NODE_ENV=production npm run build:client
[ -f dist/client/index.html ] || die "Client build produced no dist/client/index.html"
ok "Console build complete ✔"

# -------- Build & push --------
log "Building image for linux/amd64: ${IMAGE}"
podman build --platform linux/amd64 --format docker -t "${IMAGE}" .
ok "Build complete"

log "Ensuring ICR login for ${REG_HOST} ..."
if ! ibmcloud cr login --client podman; then
  log "ibmcloud cr login failed; attempting direct podman login"
  podman logout "${REG_HOST}" || true
  podman login "${REG_HOST}" -u iamapikey -p "${IBMCLOUD_API_KEY}"
fi
ok "ICR login confirmed"

log "Pushing image to ${REG_HOST} ..."
DIGEST_FILE="$(mktemp)"
if podman push --digestfile "$DIGEST_FILE" "${IMAGE}" 2>&1 | tee "/tmp/push-${APP}.log"; then
  DIGEST="$(tr -d '\r\n' < "$DIGEST_FILE")"
fi

# Fallback 1: local manifest digest (usually matches remote)
if [ -z "${DIGEST:-}" ]; then
  DIGEST="$(podman image inspect "${IMAGE}" --format '{{.Digest}}' 2>/dev/null || true)"
fi

# Fallback 2: remote inspect via skopeo (if installed)
if [ -z "${DIGEST:-}" ] && command -v skopeo >/dev/null 2>&1; then
  DIGEST="$(skopeo inspect --retry-times 3 "docker://${REG_HOST}/${NAMESPACE}/${IMAGE_NAME}:${VERSION}" \
           | awk -F'"' '/"Digest"/{print $4; exit}')"
fi

[ -n "${DIGEST:-}" ] || die "Could not obtain digest; see /tmp/push-${APP}.log"
DEPLOY_IMAGE="${REG_HOST}/${NAMESPACE}/${IMAGE_NAME}@${DIGEST}"
ok "Push complete (digest ${DIGEST})"
log "Deploying immutable image: ${DEPLOY_IMAGE}"

# -------- Deploy (create or update) --------
#
# ORDERING CONTRACT — do not reorder these three stages:
#   1. every `ibmcloud ce app create/update` write
#   2. verify_timeout      (reads the FINAL CE-managed revision)
#   3. annotate_kservice   (MUST be the last control-plane write)
#
# Code Engine exposes no flag for target-burst-capacity, so ANY `app update`
# after the kubectl patch mints a fresh revision and silently strips TBC=0.
log "Ensuring app '${APP}' exists..."
APP_EXISTS=0
if ibmcloud ce app list | awk 'NR>1 {print $1}' | grep -qx "$APP"; then
  APP_EXISTS=1
fi

# An app's URL is stable for its lifetime, so it is resolved BEFORE the write and
# folded into the same revision.
URL=""
if [ "$APP_EXISTS" = "1" ]; then
  URL=$(ibmcloud ce app get -n "$APP" | awk '/^URL:/ {print $2; exit}' || true)
  [ -n "${URL:-}" ] || warn "Could not read the app URL; BASE_URL will not be refreshed this run."
else
  URL=$(predict_app_url)
  if [ -n "${URL:-}" ]; then
    log "App does not exist yet; derived its URL from a sibling app: ${URL}"
  else
    warn "No sibling app to derive the Code Engine domain from."
    warn "BASE_URL will be applied by a corrective write after create instead."
  fi
fi

typeset -a EXTRA_ENV
EXTRA_ENV=()
if [ -n "${URL:-}" ]; then
  log "Folding BASE_URL=${URL} into this revision"
  EXTRA_ENV+=(--env "BASE_URL=${URL}")
fi

typeset -a COMMON_FLAGS
COMMON_FLAGS=(
  --image "${DEPLOY_IMAGE}"
  --registry-secret icr-secret
  --env-from-secret "${SECRET_NAME}"
  --port 8080
  --cpu "${CPU}"
  --memory "${MEMORY}"
  --concurrency "${CONCURRENCY}"
  --concurrency-target "${CONCURRENCY}"
  --min-scale "${MIN_SCALE}"
  --max-scale "${MAX_SCALE}"
  --request-timeout "${REQUEST_TIMEOUT}"
  --scale-down-delay "${SCALE_DOWN_DELAY}"
  --env NODE_ENV=production
  --env LOG_LEVEL=info
  # Console sign-in feature flag. OFF by default: the standard deployment is
  # open. Set AUTH_REQUIRED=true in .env (or the environment) to require a login,
  # which also needs CONSOLE_USERNAME / CONSOLE_PASSWORD in the secret.
  --env "AUTH_REQUIRED=${AUTH_REQUIRED}"
  --env GITHUB_AI_AGENT_CLI=bob
  --env GITHUB_AI_AGENT_OWNER="${GITHUB_AI_AGENT_OWNER:-carbon-design-system}"
  --env GITHUB_AI_AGENT_REPO="${GITHUB_AI_AGENT_REPO:-carbon}"
  --env GITHUB_AI_AGENT_MAX_PRS="${GITHUB_AI_AGENT_MAX_PRS:-5}"
  --env GITHUB_AI_AGENT_DAYS_BACK="${GITHUB_AI_AGENT_DAYS_BACK:-21}"
  --env GITHUB_AI_AGENT_REVIEW_LABEL="${GITHUB_AI_AGENT_REVIEW_LABEL:-AIReviewed}"
  --env BOB_WORKSPACE_ROOT=/workspace
  --env MCP_STATE_PATH=/workspace/.mcp-state.json
  # Durable Carbon MCP state lives in Elasticsearch
  # (readState/writeState) and the 'carbon-monitor-mcp-state' index.
  --env MCP_STATE_BACKEND=elasticsearch
)

if [ "$APP_EXISTS" = "1" ]; then
  log "App exists. Updating image and resources..."
  ibmcloud ce app update --name "$APP" "${COMMON_FLAGS[@]}" "${EXTRA_ENV[@]}"
  ok "Updated app: $APP"
else
  log "Creating app: $APP"
  ibmcloud ce app create --name "$APP" "${COMMON_FLAGS[@]}" "${EXTRA_ENV[@]}"
  ok "Created app: $APP"

  # Confirm the derived URL against the one CE actually assigned. When it matches
  # — the normal case — BASE_URL is ALREADY on the created revision and nothing
  # more is written. Only a miss costs a corrective revision, and it still lands
  # HERE, before verify_timeout and annotate_kservice, so TBC=0 is applied last.
  ACTUAL_URL=$(ibmcloud ce app get -n "$APP" | awk '/^URL:/ {print $2; exit}' || true)
  if [ -z "${ACTUAL_URL:-}" ]; then
    warn "Could not read the app URL after create; BASE_URL may be UNSET."
    warn "The OAuth redirect_uri is derived from it — 'Sign in with IBMid' will"
    warn "fail until it is set."
  elif [ "${ACTUAL_URL}" = "${URL:-}" ]; then
    ok "BASE_URL was already correct on the created revision — no extra write ✔"
  else
    log "CE assigned ${ACTUAL_URL}; correcting BASE_URL"
    ibmcloud ce app update --name "$APP" --env "BASE_URL=${ACTUAL_URL}" >/dev/null
    URL="$ACTUAL_URL"
  fi
fi

# -------- Show status & URL --------
log "Fetching app status..."
ibmcloud ce app get --name "$APP"

log "Recent events:"
ibmcloud ce app events --name "$APP" | tail -n +1 || true

# -------- Verify A: request-timeout on the FINAL revision --------
verify_timeout

# -------- Verify B & D: annotate KSVC — LAST control-plane write --------
ensure_kubectl_ctx
annotate_kservice

ok "Deploy + annotations complete."

# -------- Wait for the revision to serve, then report what is left to do -------
#
# The Carbon MCP bootstrap is the one step that CANNOT be automated: Carbon MCP
# advertises no device_authorization grant, so the authorization-code flow needs
# a human at a browser. A deploy that ends without saying so leaves an app whose
# reviews fail with an opaque MCP error — so the URL and the exact click are the
# last thing printed, and the app is asked whether it still needs them.
log "Waiting for ${APP} to answer /api/health…"
HEALTHY=0
for _ in {1..30}; do
  if curl -fsS --max-time 5 "${URL}/api/health" >/dev/null 2>&1; then HEALTHY=1; break; fi
  sleep 2
done

if [ "$HEALTHY" = "1" ]; then
  ok "App is serving ✔"
else
  warn "App did not answer /api/health within 60s — it may still be starting."
  warn "Check: ibmcloud ce app logs --name ${APP} --tail 100"
fi

# Ask the app itself whether Carbon MCP is already connected. With state persisted
# in Elasticsearch the refresh token survives the redeploy, so the container
# reconnects on its own and there is nothing for a human to do; saying otherwise
# would just be noise.
MCP_CONNECTED="unknown"
if [ "$HEALTHY" = "1" ]; then
  MCP_JSON=$(curl -fsS --max-time 10 "${URL}/api/mcp/status" 2>/dev/null || true)
  if [ -n "${MCP_JSON:-}" ]; then
    case "$MCP_JSON" in
      *'"hasToken":true'*|*'"hasSession":true'*) MCP_CONNECTED="yes" ;;
      *) MCP_CONNECTED="no" ;;
    esac
  fi
fi

print -P ""
print -P "${GRN}════════════════════════════════════════════════════════════════${CLR}"
print -P "${GRN}  Carbon Monitor is deployed${CLR}"
print -P "${GRN}════════════════════════════════════════════════════════════════${CLR}"
print -P ""
print -P "  ${BLU}Console:${CLR}  ${URL}"
print -P "  ${BLU}Health:${CLR}   ${URL}/api/health"
print -P ""

if [ "${AUTH_REQUIRED}" = "true" ]; then
  print -P "  ${YLW}Sign-in:${CLR}  required — CONSOLE_USERNAME / CONSOLE_PASSWORD from ${SECRET_NAME}"
else
  print -P "  ${YLW}Sign-in:${CLR}  OPEN — no authentication. Anyone with the URL can view"
  print -P "            status and trigger a review. Set AUTH_REQUIRED=true to change."
fi
print -P ""

if [ "$MCP_CONNECTED" = "yes" ]; then
  ok "Carbon MCP is already connected — no further action needed."
else
  print -P "${YLW}────────────────────────────────────────────────────────────────${CLR}"
  print -P "${YLW}  ACTION REQUIRED — connect Carbon MCP (one time, ~30 seconds)${CLR}"
  print -P "${YLW}────────────────────────────────────────────────────────────────${CLR}"
  print -P ""
  print -P "  Reviews will FAIL until this is done. Carbon MCP has no device-code"
  print -P "  grant, so the container cannot authenticate itself — it needs one"
  print -P "  browser sign-in. After that it renews its own token indefinitely."
  print -P ""
  print -P "    1. Open:  ${BLU}${URL}${CLR}"
  print -P "    2. In the ${BLU}Carbon MCP connection${CLR} panel, press ${BLU}Sign in with IBMid${CLR}"
  print -P "    3. Complete IBMid in the tab that opens; it closes itself"
  print -P "    4. Back on the console, the ${BLU}Carbon MCP${CLR} tile turns green"
  print -P ""
  print -P "  Verify from here:"
  print -P "    ${BLU}curl -sS ${URL}/api/mcp/status${CLR}"
  print -P ""
fi

print -P "${BLU}Useful:${CLR}"
print -P "  Status all deps   curl -sS ${URL}/api/status"
print -P "  Bobcoins balance  curl -sS ${URL}/api/credits"
print -P "  Trigger a review  curl -sS -X POST ${URL}/api/review/trigger   ${YLW}(202, runs in background)${CLR}"
print -P "  Review state      curl -sS ${URL}/api/review/status"
print -P "  Live logs         ibmcloud ce app logs --name ${APP} --tail 200 --follow"
print -P ""

# ------- App status logging (manual helpers) ------------
# ibmcloud ce app logs --name "$APP"
# ibmcloud ce app logs --name "$APP" --tail 200 --follow
# ibmcloud ce app events --name "$APP"
