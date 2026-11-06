#!/usr/bin/env bash
set -euo pipefail
APP_URL="http://127.0.0.1:4173/?setup=1"
MOCK_URL="http://127.0.0.1:4174/"
systemctl --user start gods-eye-view.service
systemctl --user start gods-eye-view-mock.service
wait_for() {
  local url="$1" label="$2"
  for _ in $(seq 1 30); do
    if curl --fail --silent --max-time 1 "$url" >/dev/null; then
      printf 'READY  %s  %s\n' "$label" "$url"
      return 0
    fi
    sleep 1
  done
  printf 'ERROR  %s did not respond: %s\n' "$label" "$url" >&2
  return 1
}
wait_for "$APP_URL" "Gods Eye View"
wait_for "http://127.0.0.1:4174/health" "Local simulated feeds"
if command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$APP_URL" >/dev/null 2>&1 &
  xdg-open "$MOCK_URL" >/dev/null 2>&1 &
else
  printf 'Open these URLs in your browser:\n%s\n%s\n' "$APP_URL" "$MOCK_URL"
fi
printf '\nGods Eye View and the synthetic feed lab are running.\n'
