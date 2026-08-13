#!/usr/bin/env bash
#
# End-to-end smoke test against a deployed Carbon Monitor.
#
#   chmod +x scripts/smoke-remote.sh
#   ./scripts/smoke-remote.sh                    # read-only checks
#   ./scripts/smoke-remote.sh --review 22971     # ALSO runs a real review
#
# Without --review nothing is written anywhere: every request is a GET, or a
# POST that is expected to be rejected. --review posts real inline comments, a
# real summary comment and the AIReviewed label to the named PR, so it is opt-in
# and confirmed rather than something you can trigger by running the script.
#
# Override the target with BASE=... to test a different deployment or localhost.

set -uo pipefail

BASE="${BASE:-https://carbon-monitor.1zvnn29on9q1.us-south.codeengine.appdomain.cloud}"
PR=""
[ "${1:-}" = "--review" ] && PR="${2:-}"

# Sent only when API_SECRET is set. The default deployment has AUTH_REQUIRED off,
# so an unauthenticated call succeeds; supplying the header anyway is harmless
# and makes the script work against a locked-down deployment unchanged.
AUTH=()
[ -n "${API_SECRET:-}" ] && AUTH=(-H "Authorization: Bearer ${API_SECRET}")

pass=0; fail=0
GRN=$'\033[32m'; RED=$'\033[31m'; YLW=$'\033[33m'; DIM=$'\033[2m'; CLR=$'\033[0m'

# Runs one request and asserts the HTTP status. Body is printed indented so a
# failure shows what the server actually said, not merely that it disagreed.
check() {
  local label="$1" expect="$2" method="$3" path="$4" body="${5:-}"
  local args=(-sS --max-time 90 -X "$method" ${AUTH[@]+"${AUTH[@]}"})
  [ -n "$body" ] && args+=(-H 'Content-Type: application/json' -d "$body")

  local out code
  out=$(curl "${args[@]}" -w $'\n%{http_code}' "${BASE}${path}" 2>&1)
  code=$(printf '%s' "$out" | tail -n1)
  out=$(printf '%s' "$out" | sed '$d')

  if [ "$code" = "$expect" ]; then
    printf '  %s✔%s %-46s %s\n' "$GRN" "$CLR" "$label" "$code"
    pass=$((pass+1))
  else
    printf '  %s✘%s %-46s %s (expected %s)\n' "$RED" "$CLR" "$label" "$code" "$expect"
    printf '%s\n' "$out" | sed 's/^/      /' | head -6
    fail=$((fail+1))
  fi
}

echo ""
echo "Carbon Monitor smoke test"
echo "  target: ${BASE}"
[ -n "${API_SECRET:-}" ] && echo "  auth:   bearer token supplied" || echo "  auth:   none (default deployment is open)"
echo ""

# ── 1. Liveness and dependencies ───────────────────────────────────────────
echo "1. Health and status"
check "health"                 200 GET /api/health
check "auth status"            200 GET /api/auth/status
check "dependency status"      200 GET /api/status
check "configuration"          200 GET /api/config
check "Carbon MCP status"      200 GET /api/mcp/status
check "Bobcoins balance"       200 GET /api/credits
check "Bobcoins history"       200 GET /api/credits/history?limit=5
check "review status"          200 GET /api/review/status
check "review logs"            200 GET /api/review/logs
echo ""

# ── 2. Validation — every one of these must be refused ─────────────────────
# The interesting case is "abc": src/index.js resolves --pr and
# GITHUB_AI_AGENT_PR_NUMBER at module load and calls process.exit(1) on a bad
# value. If a request could ever reach that path, this line would kill the
# single-instance deployment. It must answer 400 and stay up — which the
# liveness re-check at the end of this section proves.
echo "2. Input validation (all must be rejected)"
check "non-numeric PR"         400 POST /api/review/trigger '{"prNumbers":"abc"}'
check "zero"                   400 POST /api/review/trigger '{"prNumbers":[0]}'
check "negative"               400 POST /api/review/trigger '{"prNumbers":[-5]}'
check "decimal"                400 POST /api/review/trigger '{"prNumbers":"22971.0"}'
check "hex-looking"            400 POST /api/review/trigger '{"prNumbers":"0x10"}'
check "exponent-looking"       400 POST /api/review/trigger '{"prNumbers":"1e3"}'
check "null entry"             400 POST /api/review/trigger '{"prNumbers":[22971,null]}'
check "boolean"                400 POST /api/review/trigger '{"prNumbers":true}'
check "object"                 400 POST /api/review/trigger '{"prNumbers":{}}'
check "bare number"            400 POST /api/review/trigger '{"prNumbers":22971}'
check "stray comma"            400 POST /api/review/trigger '{"prNumbers":", ,"}'
check "body is null"           400 POST /api/review/trigger 'null'
check "body is an array"       400 POST /api/review/trigger '[22971]'
check "over the PR limit"      400 POST /api/review/trigger '{"prNumbers":[1,2,3,4,5,6,7,8,9,10,11,12]}'
check "still alive afterwards" 200 GET  /api/health
echo ""

# ── 3. A representative error body ─────────────────────────────────────────
echo "3. Error message names the offending value"
curl -sS --max-time 30 ${AUTH[@]+"${AUTH[@]}"} -X POST -H 'Content-Type: application/json' \
  -d '{"prNumbers":"not-a-number"}' "${BASE}/api/review/trigger" | sed 's/^/  /'
echo ""

# ── 4. Optional: a real review ─────────────────────────────────────────────
if [ -z "$PR" ]; then
  echo "${DIM}4. Review trigger skipped. Re-run with:  $0 --review 22971${CLR}"
  echo ""
else
  echo "${YLW}4. REAL REVIEW of PR #${PR}${CLR}"
  echo "   This posts inline comments, a summary comment and the AIReviewed"
  echo "   label to the pull request, publicly, as the account behind"
  echo "   GITHUB_AI_AGENT_TOKEN."
  printf "   Type the PR number again to confirm: "
  read -r confirm
  if [ "$confirm" != "$PR" ]; then
    echo "   Not confirmed — skipping."
  else
    echo ""
    echo "   Triggering…"
    curl -sS --max-time 60 ${AUTH[@]+"${AUTH[@]}"} -X POST -H 'Content-Type: application/json' \
      -d "{\"prNumbers\":[${PR}]}" "${BASE}/api/review/trigger" | sed 's/^/     /'

    # 202 means accepted, not finished — a review outlives Code Engine's 300s
    # request cap, so the outcome is polled rather than awaited.
    echo ""
    echo "   Following the run (Ctrl-C to stop watching; the review keeps going)…"
    since=0
    for _ in $(seq 1 120); do
      logs=$(curl -sS --max-time 30 ${AUTH[@]+"${AUTH[@]}"} "${BASE}/api/review/logs?since=${since}" 2>/dev/null)
      [ -z "$logs" ] && { sleep 5; continue; }

      printf '%s' "$logs" \
        | python3 -c "import sys,json;[print('     '+l['text'][:150]) for l in json.load(sys.stdin).get('lines',[])]" 2>/dev/null

      since=$(printf '%s' "$logs" | python3 -c "import sys,json;print(json.load(sys.stdin).get('nextSince',0))" 2>/dev/null || echo "$since")
      running=$(printf '%s' "$logs" | python3 -c "import sys,json;print(json.load(sys.stdin).get('running'))" 2>/dev/null)
      [ "$running" = "False" ] && break
      sleep 5
    done

    echo ""
    echo "   Final state:"
    curl -sS --max-time 30 ${AUTH[@]+"${AUTH[@]}"} "${BASE}/api/review/status" | sed 's/^/     /'
    echo ""
    echo "   Bobcoins spent:"
    curl -sS --max-time 30 ${AUTH[@]+"${AUTH[@]}"} "${BASE}/api/credits/history?limit=1" | sed 's/^/     /'
  fi
  echo ""
fi

echo "────────────────────────────────────────────────"
printf '  %s%d passed%s, %s%d failed%s\n' "$GRN" "$pass" "$CLR" \
  "$([ "$fail" -gt 0 ] && printf '%s' "$RED" || printf '%s' "$GRN")" "$fail" "$CLR"
echo ""
exit $([ "$fail" -gt 0 ] && echo 1 || echo 0)
