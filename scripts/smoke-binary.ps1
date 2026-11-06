# Runs a compiled doi on Windows without Bun on PATH: per-user folders, the launch contract and the
# request checks. Usage: powershell -File scripts/smoke-binary.ps1 dist\doi-<version>-windows-x64.exe [port]
# All state goes to a temporary folder with a space in its name.
param([Parameter(Mandatory)][string]$Binary, [int]$Port = 4499)
$ErrorActionPreference = "Stop"

$bin = (Resolve-Path $Binary).Path
$dir = Join-Path ([IO.Path]::GetTempPath()) ("doi smoke " + [Guid]::NewGuid().ToString("N").Substring(0, 8))
$unrelated = Join-Path $dir "unrelated folder"
New-Item -ItemType Directory -Force -Path $unrelated | Out-Null
$env:APPDATA = Join-Path $dir "Roaming"
$env:LOCALAPPDATA = Join-Path $dir "Local"
$url = "http://127.0.0.1:$Port"

function Fail($message) { throw "FAIL: $message" }

# Runs doi and returns its stdout and exit code. Native errors must not stop the script.
function Doi([string[]]$arguments) {
  $saved = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $out = & $bin @arguments 2>$null
  $code = $LASTEXITCODE
  $ErrorActionPreference = $saved
  return [pscustomobject]@{ Text = ($out -join "`n"); Code = $code }
}

function Answer($path) { Invoke-WebRequest -UseBasicParsing -Uri "$url$path" -TimeoutSec 10 }

Push-Location $unrelated
try {
  $version = Doi @("--version")
  if ($version.Code -ne 0) { Fail "--version gave $($version.Code)" }
  Write-Output $version.Text

  $started = Doi @("start", "--json", "--port", "$Port")
  if ($started.Code -ne 0) { Fail "doi start gave $($started.Code): $($started.Text)" }
  $info = $started.Text | ConvertFrom-Json
  if (-not $info.ok -or $info.reused) { Fail "doi start: $($started.Text)" }
  if ($info.url -ne "$url/" -or $info.mcp -ne "$url/mcp") { Fail "doi start urls: $($started.Text)" }
  if ($null -eq $info.renderer.ready) { Fail "doi start renderer: $($started.Text)" }

  $config = Join-Path $env:APPDATA "doi\config.toml"
  $workspace = Join-Path $env:LOCALAPPDATA "doi\workspace"
  if (-not (Test-Path $config)) { Fail "no per-user config at $config" }
  if ($info.workspace -ne $workspace) { Fail "workspace $($info.workspace), not $workspace" }
  if (-not (Test-Path (Join-Path $workspace "projects\sample"))) { Fail "no sample project" }
  if (Test-Path (Join-Path $unrelated "config.toml")) { Fail "a file in the shell folder" }

  if ((Answer "/").StatusCode -ne 200) { Fail "no UI page" }
  if ((Answer "/__doi/bridge.js").Content -notmatch "doi:ready") { Fail "bridge script" }
  if ((Answer "/api/projects").Content -notmatch '"sample"') { Fail "projects API" }
  if ((Answer "/design/sample/home/").Content -notmatch "/__doi/bridge.js") { Fail "design page" }
  $tools = Invoke-WebRequest -UseBasicParsing -Uri "$url/mcp" -Method Post -TimeoutSec 10 -ContentType "application/json" -Headers @{ Accept = "application/json, text/event-stream" } -Body '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
  foreach ($tool in "list_designs", "get_design", "get_design_system", "get_comments", "export_png") {
    if ([Text.Encoding]::UTF8.GetString($tools.RawContentStream.ToArray()) -notmatch $tool) { Fail "MCP tool $tool" }
  }
  Invoke-WebRequest -UseBasicParsing -Uri "$url/api/projects" -Method Post -TimeoutSec 10 -ContentType "application/json" -Body '{"name":"Kept"}' | Out-Null

  $again = (Doi @("start", "--json", "--port", "$Port")).Text | ConvertFrom-Json
  if (-not $again.reused -or $again.pid -ne $info.pid) { Fail "the second start made another server" }
  $status = Doi @("status", "--json")
  if ($status.Code -ne 0 -or -not ($status.Text | ConvertFrom-Json).running) { Fail "doi status: $($status.Text)" }

  $other = Doi @("start", "--json", "--workspace", (Join-Path $dir "other"), "--port", "$Port")
  if ($other.Code -ne 5 -or $other.Text -notmatch "port_conflict") { Fail "another workspace on this port gave $($other.Code): $($other.Text)" }
  if (Test-Path (Join-Path $dir "other")) { Fail "the refused start made the workspace" }

  $stopped = Doi @("stop", "--json")
  if ($stopped.Code -ne 0 -or -not ($stopped.Text | ConvertFrom-Json).stopped) { Fail "doi stop: $($stopped.Text)" }
  $after = Doi @("status", "--json")
  if ($after.Code -ne 1) { Fail "doi status after a stop gave $($after.Code)" }
  $gone = $false
  try { Answer "/" | Out-Null } catch { $gone = $true }
  if (-not $gone) { Fail "the server still answers after doi stop" }

  # A later start from another folder finds the same workspace, and it leaves the config alone.
  $before = Get-Content -Raw $config
  Pop-Location
  Push-Location $dir
  $second = Doi @("start", "--json", "--port", "$Port")
  if ($second.Code -ne 0) { Fail "the second start gave $($second.Code): $($second.Text)" }
  if ((Answer "/api/projects").Content -notmatch '"kept"') { Fail "the second start found another workspace" }
  if ((Get-Content -Raw $config) -ne $before) { Fail "the second start changed the config" }
  if ((Doi @("stop", "--json")).Code -ne 0) { Fail "the last stop" }

  $doctor = Doi @("doctor", "--json")
  if ($doctor.Code -ne 0 -or $doctor.Text -notmatch '"name":"git"') { Fail "doi doctor gave $($doctor.Code): $($doctor.Text)" }
  Write-Output "smoke test passed: $bin"
} finally {
  Doi @("stop", "--json") | Out-Null
  Pop-Location
  Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue
}
