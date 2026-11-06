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

# Per-user paths (#146): no --config and no --workspace, from two unrelated folders. A config.toml
# in the shell folder is not doi's. The home folder has a space, as a real one can.
kill "$pid" 2>/dev/null || true
wait "$pid" 2>/dev/null || true
home="$dir/home with space"
one="$dir/one"
two="$dir/two"
mkdir -p "$home" "$one" "$two"
printf 'workspace = "%s/wrong"\n' "$two" > "$two/config.toml"
start() { # folder
  (cd "$1" && exec env -i HOME="$home" PATH=/usr/bin:/bin "$bin" --port "$port") >> "$dir/log" 2>&1 &
  pid=$!
  for _ in $(seq 1 100); do
    curl -sf -o /dev/null "$url/" && return 0
    kill -0 "$pid" 2>/dev/null || { cat "$dir/log"; fail "no start in $1"; }
    sleep 0.1
  done
  fail "no answer after a start in $1"
}
stop_it() { kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; }
start "$one"
workspace="$home/.local/share/doi/workspace"
config="$home/.config/doi/config.toml"
[ -f "$config" ] || fail "no per-user config"
[ -d "$workspace/projects/sample" ] || fail "no per-user workspace"
[ ! -e "$one/workspace" ] && [ ! -e "$one/config.toml" ] || fail "a file in the shell folder"
[ "$(stat -c %a "$config" 2>/dev/null || stat -f %Lp "$config")" = 600 ] || fail "config mode"
curl -sf -X POST "$url/api/projects" -H 'content-type: application/json' -d '{"name":"Kept"}' > /dev/null || fail "new project"
stop_it
printf '# my own line\n' >> "$config"
before=$(cat "$config")
start "$two"
body=$(curl -sf "$url/api/projects") || fail "projects after the second start"
has "$body" '"kept"' || fail "the second start found another workspace"
[ "$(cat "$config")" = "$before" ] || fail "the second start changed the config"
[ ! -e "$two/wrong" ] || fail "the second start used ./config.toml"
stop_it
# All keys are optional: a config with no workspace line keeps the same workspace.
printf 'port = %s\n' "$port" > "$config"
start "$one"
body=$(curl -sf "$url/api/projects") || fail "projects with no workspace line"
has "$body" '"kept"' || fail "a config with no workspace line found another workspace"
[ ! -e "$home/.config/doi/workspace" ] || fail "a workspace in the config folder"
stop_it
# The launch contract (#146): the background start, a reuse, status and stop.
jq_field() { printf '%s' "$1" | sed -n "s/.*\"$2\":\([^,}]*\).*/\1/p"; }
run_bin() { env -i HOME="$home" PATH=/usr/bin:/bin "$bin" "$@"; }
info=$(cd "$one" && run_bin start --json --port "$port") || fail "doi start: $info"
[ "$(printf '%s\n' "$info" | wc -l)" = 1 ] || fail "doi start printed more than one line"
has "$info" '"ok":true' || fail "doi start: $info"
has "$info" "\"url\":\"$url/\"" || fail "doi start url: $info"
has "$info" "\"mcp\":\"$url/mcp\"" || fail "doi start mcp: $info"
has "$info" '"renderer":{"ready":' || fail "doi start renderer: $info"
curl -sf -o /dev/null "$url/" || fail "no UI after doi start"
body=$(curl -sf "$url/api/projects") && has "$body" '"kept"' || fail "doi start used another workspace"
server=$(jq_field "$info" pid)
again=$(cd "$two" && run_bin start --json --port "$port") || fail "second doi start: $again"
has "$again" '"reused":true' || fail "second doi start: $again"
[ "$(jq_field "$again" pid)" = "$server" ] || fail "second doi start made another server"
status=$(cd "$two" && run_bin status --json) || fail "doi status: $status"
has "$status" '"running":true' || fail "doi status: $status"
code=0
other=$(cd "$one" && run_bin start --json --workspace "$dir/other" --port "$port") || code=$?
[ "$code" = 5 ] || fail "exit code $code for a port with another workspace: $other"
has "$other" "port_conflict" || fail "no port conflict: $other"
[ ! -e "$dir/other" ] || fail "the refused start made the workspace"
stopped=$(cd "$two" && run_bin stop --json) || fail "doi stop: $stopped"
has "$stopped" '"stopped":true' || fail "doi stop: $stopped"
if curl -sf -o /dev/null "$url/"; then fail "the server still answers after doi stop"; fi
code=0
status=$(run_bin status --json) || code=$?
[ "$code" = 1 ] || fail "exit code $code for doi status after a stop"
report=$(run_bin doctor --json) || fail "doi doctor: $report"
has "$report" '"name":"git"' || fail "doi doctor: $report"

# The shared design (#146): an agent reads a design through MCP, a person edits it, and the agent's
# next read has the edit. DOI_SMOKE_RENDER=1 also installs Chromium and asks for a rendered image.
info=$(cd "$one" && run_bin start --json --port "$port") || fail "doi start for MCP: $info"
mcp() { # tool, JSON arguments
  curl -sf -X POST "$url/mcp" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":$2}}"
}
design='{"project":"sample","design":"home"}'
first=$(mcp get_design "$design") || fail "MCP get_design"
has "$first" 'index.html' || fail "MCP get_design: no page"
if has "$first" '321px'; then fail "MCP get_design: the edit is there before the edit"; fi
curl -sf -X POST "$url/api/projects/sample/designs/home/edit" -H 'content-type: application/json' \
  -d '{"oid":"main","style":{"width":"321px"}}' > /dev/null || fail "the edit of a person"
next=$(mcp get_design "$design") || fail "MCP get_design after the edit"
has "$next" '321px' || fail "the agent's next read has no edit"
if [ "${DOI_SMOKE_RENDER:-}" = 1 ]; then
  run_bin install-browser > /dev/null 2>&1 || fail "doi install-browser"
  status=$(run_bin status --json) || fail "doi status for the renderer: $status"
  has "$status" '"renderer":{"ready":true' || fail "the renderer is not ready: $status"
  image=$(mcp export_png '{"project":"sample","design":"home"}') || fail "MCP export_png"
  has "$image" '"type":"image"' || fail "MCP export_png gave no image: $(printf '%.300s' "$image")"
fi
stopped=$(run_bin stop --json) || fail "the last doi stop: $stopped"

# A home folder that doi cannot write to: exit code 2, and the message names the per-user file.
if [ "$(id -u)" != 0 ]; then
  locked="$dir/locked"
  mkdir -p "$locked"
  chmod 500 "$locked"
  code=0
  message=$(cd "$one" && env -i HOME="$locked" PATH=/usr/bin:/bin "$bin" --port "$port" 2>&1) || code=$?
  chmod 700 "$locked"
  [ "$code" = 2 ] || fail "exit code $code for a locked home folder"
  has "$message" "$locked/.config/doi/config.toml" || fail "the message names another file: $message"
fi
echo "smoke test passed: $bin"
