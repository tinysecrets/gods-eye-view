#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="/data/apps/gods-eye-view"
NODE_BIN="/data/toolchains/node-v24.22.2-linux-x64/bin/node"
NPM_BIN="/data/toolchains/node-v24.22.2-linux-x64/bin/npm"
SERVICE="gods-eye-view.service"
BASE_URL="http://100.105.171.108:4173"

fail() { printf '\n[ERROR] %s\n' "$*" >&2; exit 1; }
say() { printf '\n[GEV] %s\n' "$*"; }

[[ -d "$ROOT/.git" ]] || fail "Project checkout not found at $ROOT"
[[ -x "$NODE_BIN" && -x "$NPM_BIN" ]] || fail "The pinned Node 24 toolchain is missing"
[[ "$("$NODE_BIN" --version)" == v24.* ]] || fail "Node 24 is required"
command -v curl >/dev/null || fail "curl is missing"
command -v systemctl >/dev/null || fail "systemd user session is unavailable"

export PATH="/data/toolchains/node-v24.22.2-linux-x64/bin:/home/justin/.local/bin:/usr/local/bin:/usr/bin:/bin"
cd "$ROOT"

if [[ ! -d node_modules ]]; then
  say "Installing locked project dependencies..."
  "$NPM_BIN" ci
fi

if [[ ! -f .env ]]; then
  (umask 077; : > .env)
fi
chmod 600 .env

say "No paid provider keys are requested or added by this setup."
say "Existing .env values are preserved. OpenAI is explicitly unset by the user service."
say "Camera audio remains controlled by the separate video-only recorder."

say "Building the local panel..."
"$NPM_BIN" run build:panel

say "Building the production bundle..."
"$NPM_BIN" run build

say "Reloading the user service definition and restarting God’s Eye View..."
systemctl --user daemon-reload
systemctl --user restart "$SERVICE"

ready=0
for attempt in $(seq 1 30); do
  if curl --fail --silent "$BASE_URL/wah-lah-security.html" -o /dev/null &&
     curl --fail --silent "$BASE_URL/api/wah-lah/security/health" -o /dev/null &&
     systemctl --user is-active --quiet "$SERVICE"; then
    ready=1
    break
  fi
  sleep 1
done
[[ "$ready" == 1 ]] || fail "Dashboard or health API did not recover on $BASE_URL"

printf '\n==============================================\n'
printf ' READY — GOD’S EYE VIEW / WAH-LAH SECURITY\n'
printf '==============================================\n'
printf 'Dashboard: %s/wah-lah-security.html\n' "$BASE_URL"
printf 'Health:    %s/api/wah-lah/security/health\n' "$BASE_URL"
printf 'Service:   %s\n' "$(systemctl --user is-active "$SERVICE")"
printf 'Env mode:  %s\n' "$(stat -c '%a' .env)"
