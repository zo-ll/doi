# Checks install.ps1 with a local release folder: a path with spaces, an upgrade, a failed upgrade,
# an interrupted download, a missing PATH entry and an uninstall. Usage:
#   powershell -File scripts/test-install.ps1 dist\doi-<version>-windows-x64.exe [-ModifyPath]
# Without -ModifyPath, the user PATH is not touched: that is for a real computer. CI uses it.
param([Parameter(Mandatory)][string]$Binary, [switch]$ModifyPath)
$ErrorActionPreference = "Stop"
$bin = (Resolve-Path $Binary).Path
$script = Join-Path $PSScriptRoot "install.ps1"
$dir = Join-Path ([IO.Path]::GetTempPath()) ("doi install " + [Guid]::NewGuid().ToString("N").Substring(0, 8))
$target = Join-Path $dir "the bin"
$env:LOCALAPPDATA = Join-Path $dir "Local"
$env:APPDATA = Join-Path $dir "Roaming"
$version = ((& $bin --version) -join "") -replace "^doi ", ""
$arch = if ($bin -match "arm64") { "arm64" } else { "x64" }
$name = "doi-$version-windows-$arch.exe"

function Fail($message) { throw "FAIL: $message" }
function Base($case) { ([Uri](Join-Path $dir "release $case")).AbsoluteUri }
function New-Release($case, [string]$Hash = $null, [string]$File = $bin) {
  $folder = Join-Path $dir "release $case\v$version"
  New-Item -ItemType Directory -Force -Path $folder | Out-Null
  Copy-Item $File (Join-Path $folder $name)
  $sum = if ($Hash) { $Hash } else { (Get-FileHash -Algorithm SHA256 $File).Hash.ToLower() }
  Set-Content -Encoding Ascii -Path (Join-Path $folder "SHA256SUMS") -Value "$sum  $name"
}
function Install($case, [string[]]$Extra = @()) {
  $env:DOI_INSTALL_BASE_URL = Base $case
  $saved = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $out = & powershell -NoProfile -ExecutionPolicy Bypass -File $script -Version $version -InstallDir $target @Extra 2>&1
  $code = $LASTEXITCODE
  $ErrorActionPreference = $saved
  return [pscustomobject]@{ Text = ($out -join "`n"); Code = $code }
}
[string[]]$pathFlag = if ($ModifyPath) { @() } else { @("-NoModifyPath") }
$exe = Join-Path $target "doi.exe"
function Leftovers { @(Get-ChildItem -Force $target | Where-Object { $_.Name -ne "doi.exe" }) }

try {
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  New-Release "good"
  $first = Install "good" $pathFlag
  if ($first.Code -ne 0 -or -not (Test-Path $exe)) { Fail "first install: $($first.Text)" }
  if ((Leftovers).Count) { Fail "temp files after an install: $(Leftovers)" }
  if (((& $exe --version) -join "") -ne "doi $version") { Fail "the installed binary" }

  $user = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Environment").GetValue("Path", "", "DoNotExpandEnvironmentNames")
  if ($ModifyPath) {
    if ($user -notlike "*$target*") { Fail "not on the user PATH: $user" }
  } else {
    if ($user -like "*$target*") { Fail "the PATH changed with -NoModifyPath" }
    if ($first.Text -notmatch "Add ") { Fail "no PATH advice: $($first.Text)" }
  }

  $data = Join-Path $env:LOCALAPPDATA "doi\workspace\kept.txt"
  New-Item -ItemType Directory -Force -Path (Split-Path $data) | Out-Null
  Set-Content -Path $data -Value "my design"

  $hash = (Get-FileHash -Algorithm SHA256 $exe).Hash

  # Each failure keeps the old binary and the data, and it leaves no temp files.
  New-Release "badsum" ("0" * 64)
  $bad = Install "badsum" $pathFlag
  if ($bad.Text -notmatch "does not match") { Fail "wrong checksum: $($bad.Text)" }

  # A cut download: the file is shorter than its checksum says.
  $short = Join-Path $dir "short.exe"
  [IO.File]::WriteAllBytes($short, [byte[]](1..200))
  New-Release "short" (Get-FileHash -Algorithm SHA256 $bin).Hash.ToLower() $short
  $cut = Install "short" $pathFlag
  if ($cut.Text -notmatch "does not match") { Fail "cut download: $($cut.Text)" }

  # A transfer that breaks: the server promises more bytes, and it closes the connection.
  $cutPort = 4496
  $server = Start-Job -ArgumentList $cutPort, (Join-Path $dir "release good\v$version\SHA256SUMS") -ScriptBlock {
    param($port, $sums)
    $listener = New-Object Net.HttpListener
    $listener.Prefixes.Add("http://127.0.0.1:$port/")
    $listener.Start()
    for ($i = 0; $i -lt 2; $i++) {
      $context = $listener.GetContext()
      if ($context.Request.Url.AbsolutePath -like "*SHA256SUMS") {
        $bytes = [IO.File]::ReadAllBytes($sums)
        $context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
        $context.Response.Close()
      } else {
        $context.Response.ContentLength64 = 1000000
        $context.Response.OutputStream.Write([byte[]](1..10), 0, 10)
        $context.Response.OutputStream.Flush()
        $context.Response.Abort()
      }
    }
    $listener.Stop()
  }
  Start-Sleep -Seconds 2
  $env:DOI_INSTALL_BASE_URL = "http://127.0.0.1:$cutPort"
  $saved = $ErrorActionPreference; $ErrorActionPreference = "Continue"
  $broken = (& powershell -NoProfile -ExecutionPolicy Bypass -File $script -Version $version -InstallDir $target @pathFlag 2>&1) -join "`n"
  $ErrorActionPreference = $saved
  Stop-Job $server -ErrorAction SilentlyContinue; Remove-Job $server -Force -ErrorAction SilentlyContinue
  if ($broken -notmatch "failed. Nothing changed") { Fail "a broken transfer: $broken" }

  $gone = Install "no-such-release" $pathFlag
  if ($gone.Text -notmatch "cannot download") { Fail "missing release: $($gone.Text)" }

  # A file that is no program, with a matching checksum.
  New-Release "broken" $null $short
  $broken = Install "broken" $pathFlag
  if ($broken.Text -notmatch "Nothing changed") { Fail "broken binary: $($broken.Text)" }

  if ((Get-FileHash -Algorithm SHA256 $exe).Hash -ne $hash) { Fail "a failed install changed the binary" }
  if ((Leftovers).Count) { Fail "temp files after a failure: $(Leftovers)" }
  if ((Get-Content $data) -ne "my design") { Fail "a failed install changed the data" }

  # An upgrade over a running doi: Windows can rename a running exe.
  $saved = $ErrorActionPreference; $ErrorActionPreference = "Continue"
  $running = Start-Process -FilePath $exe -ArgumentList "serve", "--workspace", "`"$(Join-Path $dir 'ws')`"", "--port", "4498" -PassThru -WindowStyle Hidden
  $ErrorActionPreference = $saved
  Start-Sleep -Seconds 2
  $again = Install "good" $pathFlag
  if ($again.Code -ne 0) { Fail "upgrade over a running doi: $($again.Text)" }
  Stop-Process -Id $running.Id -Force -ErrorAction SilentlyContinue
  if (((& $exe --version) -join "") -ne "doi $version") { Fail "the binary after the upgrade" }
  if ((Get-Content $data) -ne "my design") { Fail "the upgrade changed the data" }

  # The whole way: the smoke test on the installed command, up to the shared design. A computer
  # without git cannot start doi, so only a run with -ModifyPath (CI) does this.
  if ($ModifyPath) {
    & (Join-Path $PSScriptRoot "smoke-binary.ps1") $exe 4495
    Write-Output "install to shared design passed: $exe"
  }

  # Uninstall keeps the data.
  $removed = Install "good" @("-Uninstall")
  if (Test-Path $exe) { Fail "uninstall kept the binary" }
  if ((Get-Content $data) -ne "my design") { Fail "uninstall changed the data" }
  if ($removed.Text -notmatch "stay") { Fail "uninstall words: $($removed.Text)" }
  $user = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Environment").GetValue("Path", "", "DoNotExpandEnvironmentNames")
  if ($user -like "*$target*") { Fail "uninstall kept the PATH entry" }
  Write-Output "install test passed: $bin"
} finally {
  Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue
}
