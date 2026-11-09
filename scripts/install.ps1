# Installs the doi command for this user, without administrator access. Windows only.
#
#   irm https://raw.githubusercontent.com/zo-ll/doi/main/scripts/install.ps1 | iex
#   powershell -File install.ps1 -Version 0.1.0 -InstallDir "$HOME\bin"
#   powershell -File install.ps1 -Uninstall
#
# Nothing else changes: an upgrade or a failed install leaves your designs, config, history and
# credentials as they are, and the old binary stays until a new one has passed every check.
param(
  [string]$Version = $env:DOI_VERSION,
  [string]$InstallDir = $(if ($env:DOI_INSTALL_DIR) { $env:DOI_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "Programs\doi" }),
  [switch]$NoModifyPath,
  [switch]$Uninstall
)
# A child scope: through `irm | iex` this runs in the user's own session, which must keep its settings.
& {
$ErrorActionPreference = "Stop"
$Repo = "zo-ll/doi"
$Base = if ($env:DOI_INSTALL_BASE_URL) { $env:DOI_INSTALL_BASE_URL } else { "https://github.com/$Repo/releases/download" }

function Stop-Install([string]$Message) {
  [Console]::Error.WriteLine("doi install: $Message")
  # `exit` would close the window of a user who runs this through `irm | iex`.
  throw "doi install: $Message"
}

function Get-ReleaseVersion([string]$Location) {
  if ($Location -and $Location.StartsWith("/", [StringComparison]::Ordinal)) { $Location = "https://github.com$Location" }
  $prefix = "https://github.com/$Repo/releases/tag/"
  if ($Location -and $Location.StartsWith($prefix, [StringComparison]::Ordinal) -and $Location.Length -gt $prefix.Length) {
    return $Location.Substring($prefix.Length)
  }
  Stop-Install "cannot find the latest release of $Repo."
}

# The raw registry value: [Environment] expands %USERPROFILE%, and writing that back would damage it.
function Get-UserPathEntries {
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Environment")
  if (-not $key) { return @() }
  $raw = $key.GetValue("Path", "", [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  $key.Close()
  return @($raw -split ";" | Where-Object { $_ })
}

function Set-UserPathEntries([string[]]$Entries) {
  $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey("Environment")
  $key.SetValue("Path", ($Entries -join ";"), [Microsoft.Win32.RegistryValueKind]::ExpandString)
  $key.Close()
  # Tells open programs that the environment changed.
  [Environment]::SetEnvironmentVariable("DOI_INSTALL_REFRESH", $null, "User")
}

# Relative to the PowerShell location, not to the folder that the process started in.
$InstallDir = [IO.Path]::GetFullPath([IO.Path]::Combine((Get-Location -PSProvider FileSystem).Path, $InstallDir))
$target = Join-Path $InstallDir "doi.exe"

if ($Uninstall) {
  if (Test-Path $target) {
    try {
      Remove-Item -Force $target
    } catch {
      Stop-Install "cannot remove $target, because it runs. Run doi stop, then uninstall again."
    }
  }
  Remove-Item -Force "$target.old" -ErrorAction SilentlyContinue
  $entries = @(Get-UserPathEntries)
  $kept = @($entries | Where-Object { $_.TrimEnd("\") -ine $InstallDir.TrimEnd("\") })
  if ($kept.Count -ne $entries.Count) { Set-UserPathEntries $kept }
  if ((Test-Path $InstallDir) -and -not (Get-ChildItem -Force $InstallDir)) { Remove-Item -Force $InstallDir }
  Write-Output "doi is removed from $InstallDir."
  Write-Output "Your designs, config and credentials stay. To delete them, remove $(Join-Path $env:LOCALAPPDATA 'doi') and $(Join-Path $env:APPDATA 'doi')."
  return
}

# The computer, not this process: an x64 PowerShell on ARM64 Windows reports AMD64 for itself.
$machine = [Environment]::GetEnvironmentVariable("PROCESSOR_ARCHITECTURE", "Machine")
if (-not $machine) { $machine = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE } }
$arch = switch ($machine) {
  "AMD64" { "x64" }
  "ARM64" { "arm64" }
  default { Stop-Install "doi has no Windows binary for the CPU $machine. It publishes x64 and arm64." }
}

[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
if (-not $Version) {
  # The redirect on github.com, as install.sh reads it: it has no API rate limit.
  try {
    $request = [Net.WebRequest]::Create("https://github.com/$Repo/releases/latest")
    $request.AllowAutoRedirect = $false
    $response = $request.GetResponse()
    $location = $response.Headers["Location"]
    $response.Close()
  } catch {
    Stop-Install "cannot find the latest release of $Repo. $($_.Exception.Message)"
  }
  $Version = Get-ReleaseVersion $location
}
$Version = $Version -replace "^v", ""
if ($Version -notmatch "^[0-9A-Za-z.-]+$") { Stop-Install "'$Version' is not a version." }

$name = "doi-$Version-windows-$arch.exe"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
# In the install folder, so the last step is a rename on one volume.
$tmp = Join-Path $InstallDir (".doi-install." + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  $client = New-Object Net.WebClient
  Write-Output "Downloading doi $Version for Windows $arch..."
  try {
    $client.DownloadFile("$Base/v$Version/SHA256SUMS", "$tmp\SHA256SUMS")
  } catch {
    Stop-Install "cannot download the checksums of version $Version. Check the version and your connection."
  }
  try {
    $client.DownloadFile("$Base/v$Version/$name", "$tmp\doi.exe")
  } catch {
    Stop-Install "the download of $name failed. Nothing changed."
  }

  $want = $null
  foreach ($line in Get-Content "$tmp\SHA256SUMS") {
    $parts = $line -split "\s+\*?", 2
    if ($parts.Count -eq 2 -and $parts[1] -eq $name) { $want = $parts[0] }
  }
  if (-not $want) { Stop-Install "the checksums do not list $name. Nothing changed." }
  $have = (Get-FileHash -Algorithm SHA256 "$tmp\doi.exe").Hash
  if ($have -ine $want) { Stop-Install "the checksum of $name does not match, so the file is incomplete or changed. Nothing changed." }

  $got = $null
  try { $got = (& "$tmp\doi.exe" --version 2>$null) -join "" } catch { $got = $null }
  if ($got -ne "doi $Version") { Stop-Install "the new binary reports '$got', not doi $Version. Nothing changed." }

  # Windows cannot replace a running exe, but it can rename one. A running doi keeps working.
  if (Test-Path "$target.old") { Remove-Item -Force "$target.old" -ErrorAction SilentlyContinue }
  $moved = $false
  if (Test-Path $target) {
    try {
      Move-Item -Force $target "$target.old"
      $moved = $true
    } catch {
      Stop-Install "cannot replace $target. Run doi stop, then install again. Nothing changed."
    }
  }
  try {
    Move-Item -Force "$tmp\doi.exe" $target
  } catch {
    if ($moved) { Move-Item -Force "$target.old" $target }
    Stop-Install "cannot write $target. The old version stays."
  }
  if ($moved) { Remove-Item -Force "$target.old" -ErrorAction SilentlyContinue }
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

$entries = Get-UserPathEntries
$known = $entries | Where-Object { $_.TrimEnd("\") -ieq $InstallDir.TrimEnd("\") }
if (-not $known) {
  if ($NoModifyPath) {
    Write-Output "Add $InstallDir to your PATH to use the doi command."
  } else {
    Set-UserPathEntries (@($entries) + $InstallDir)
    Write-Output "Added $InstallDir to your user PATH. Open a new terminal to use it."
  }
}

Write-Output "Installed doi $Version at $target."
Write-Output "doi has no code signature, so SmartScreen can warn about it. See the user guide."
Write-Output "Next: run doi doctor to check the tools, and doi install-browser for PNG, PDF and agent screenshots."
Write-Output "Then start it with doi --open."
}
