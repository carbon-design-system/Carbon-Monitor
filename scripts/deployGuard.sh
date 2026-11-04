#!/usr/bin/env zsh
# Guard function: compare live app target values against the env-file values.
# Sourced by deploy_ce.sh and by tests/deployGuard.test.js (via a stub ibmcloud).
#
# Exports nothing. Calls die() which must be defined by the caller.
# Returns 0 (proceed) or calls die() (abort).

check_deploy_target() {
  local app="$1"          # CE app name
  local env_repo="$2"     # GITHUB_AI_AGENT_REPO from env file
  local env_profile="$3"  # REVIEW_PROFILE from env file (may be empty → core)
  local env_prefix="$4"   # ES_INDEX_PREFIX from env file (may be empty)
  local allow_change="${DEPLOY_ALLOW_TARGET_CHANGE:-0}"

  # Normalize: empty REVIEW_PROFILE means core
  local norm_profile="${env_profile:-core}"
  local norm_prefix="${env_prefix:-}"

  local app_json
  app_json=$(ibmcloud ce app get --name "$app" --output json 2>/dev/null) || return 0
  # App does not exist yet — no guard needed.
  [ -n "${app_json:-}" ] || return 0

  # Extract env vars from the live revision's env array.
  # CE JSON: .spec.template.spec.containers[0].env is [{name,value}, ...]
  # Use awk to pull the value for a given NAME without depending on jq.
  # The JSON may be compact (all on one line), so scan field-by-field.
  _ce_env_val() {
    local key="$1"
    printf '%s' "$app_json" \
      | awk -F'"' -v k="$key" '
          {
            for (i=1; i<=NF; i++) {
              if ($i == "name"  && $(i+2) == k) { want=1 }
              if ($i == "value" && want) { print $(i+2); want=0; exit }
            }
          }
        '
  }

  local live_repo live_profile live_prefix
  live_repo=$(_ce_env_val GITHUB_AI_AGENT_REPO)
  live_profile=$(_ce_env_val REVIEW_PROFILE)
  live_prefix=$(_ce_env_val ES_INDEX_PREFIX)

  # Normalize live values the same way.
  local live_norm_profile="${live_profile:-core}"
  local live_norm_prefix="${live_prefix:-}"

  local mismatch=0
  local msgs=()

  if [ -n "${live_repo:-}" ] && [ "${live_repo}" != "${env_repo}" ]; then
    msgs+=("GITHUB_AI_AGENT_REPO: live='${live_repo}' env='${env_repo}'")
    mismatch=1
  fi
  if [ "${live_norm_profile}" != "${norm_profile}" ]; then
    msgs+=("REVIEW_PROFILE: live='${live_norm_profile}' env='${norm_profile}'")
    mismatch=1
  fi
  if [ "${live_norm_prefix}" != "${norm_prefix}" ]; then
    msgs+=("ES_INDEX_PREFIX: live='${live_norm_prefix}' env='${norm_prefix}'")
    mismatch=1
  fi

  if [ "$mismatch" = "1" ]; then
    if [ "${allow_change}" = "1" ]; then
      for m in "${msgs[@]}"; do
        warn "Target mismatch (proceeding — DEPLOY_ALLOW_TARGET_CHANGE=1): ${m}"
      done
    else
      for m in "${msgs[@]}"; do
        die "Target mismatch — ${m}. Set DEPLOY_ALLOW_TARGET_CHANGE=1 to override."
      done
    fi
  fi
}
