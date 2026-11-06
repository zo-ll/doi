#!/usr/bin/env bash
# Starts a compiled doi binary (#63) without Bun on PATH and checks the UI, the bridge, the API
# and the MCP server: scripts/smoke-binary.sh dist/doi-<version>-<os>-<arch>
set -euo pipefail

bin=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
dir=$(mktemp -d)
port=${PORT:-4499}
url=http://127.0.0.1:$port
pid=""
trap 'kill "${pid:-}" 2>/dev/null || true; rm -rf "$dir"' EXIT

cd "$dir"
env -i HOME="$dir" PATH=/usr/bin:/bin "$bin" --version
env -i HOME="$dir" PATH=/usr/bin:/bin "$bin" --workspace "$dir/ws" --port "$port" > "$dir/log" 2>&1 &
pid=$!
for _ in $(seq 1 100); do
  curl -sf -o /dev/null "$url/" && break
  kill -0 "$pid" 2>/dev/null || { cat "$dir/log"; exit 1; }
  sleep 0.1
done
cat "$dir/log"

fail() { echo "FAIL: $*" >&2; exit 1; }
page=$(curl -sf "$url/") || fail "no UI page"
for asset in $(printf '%s' "$page" | grep -oE '(src|href)="/chunk-[^"]+"' | cut -d'"' -f2); do
  curl -sf -o /dev/null "$url$asset" || fail "UI asset $asset"
done
# Read the whole answer first. In a pipe, `grep -q` exits at its first match, the writer then fails
# on the closed pipe (curl: 23), and pipefail reports a failure for a correct answer.
has() { grep -q -- "$2" <<<"$1"; }
body=$(curl -sf "$url/__doi/bridge.js") && has "$body" 'doi:ready' || fail "bridge script"
body=$(curl -sf "$url/api/projects") && has "$body" '"sample"' || fail "projects API"
body=$(curl -sf "$url/design/sample/home/") && has "$body" '/__doi/bridge.js' || fail "design page"
tools=$(curl -sf -X POST "$url/mcp" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}') || fail "MCP request"
for t in list_designs get_design get_design_system get_comments export_png; do
  has "$tools" "\"$t\"" || fail "MCP tool $t"
done
# UML export: the fonts are file imports that only the compiled binary must carry.
uml=$(curl -sf -X POST "$url/api/projects/sample/architecture/export" -H 'content-type: application/json' \
  -d '{"format":"svg","theme":"dark","background":true,"diagram":{"id":"d1","name":"Smoke","nodes":[{"id":"n1","name":"Box","position":{"x":0,"y":0}}]}}') || fail "UML SVG export"
[ "$(printf '%s' "$uml" | grep -o '@font-face' | wc -l)" -eq 3 ] || fail "UML export fonts"
echo "smoke test passed: $bin"
