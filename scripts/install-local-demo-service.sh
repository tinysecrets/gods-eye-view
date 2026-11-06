#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
NODE_VERSION=""
if [[ -n "$NODE_BIN" ]]; then NODE_VERSION="$("$NODE_BIN" --version 2>/dev/null || true)"; fi
if [[ ! "$NODE_VERSION" =~ ^v(24|26)\. ]]; then
  NODE_BIN="/data/toolchains/node-v24.22.2-linux-x64/bin/node"
  NODE_VERSION="$("$NODE_BIN" --version 2>/dev/null || true)"
fi
if [[ ! "$NODE_VERSION" =~ ^v(24|26)\. ]]; then
  printf 'Node.js 24.x or 26.x is required. Set NODE_BIN to its executable path. Found: %s\n' "${NODE_VERSION:-none}" >&2
  exit 1
fi
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$UNIT_DIR"
printf '[Unit]\nDescription=Gods Eye View local synthetic demo feeds\nAfter=network.target\n\n[Service]\nType=simple\nWorkingDirectory=%s\nEnvironment=GEV_MOCK_PORT=4174\nExecStart=%s %s/tools/mock-local-server.mjs\nRestart=on-failure\nRestartSec=3\nNoNewPrivileges=true\nPrivateTmp=true\nProtectSystem=strict\nProtectHome=read-only\n\n[Install]\nWantedBy=default.target\n' "$ROOT" "$NODE_BIN" "$ROOT" > "$UNIT_DIR/gods-eye-view-mock.service"
systemctl --user daemon-reload
systemctl --user enable --now gods-eye-view-mock.service
printf 'Installed and started gods-eye-view-mock.service using %s (%s)\n' "$NODE_BIN" "$NODE_VERSION"
printf 'Demo feed URL: http://127.0.0.1:4174/\n'
