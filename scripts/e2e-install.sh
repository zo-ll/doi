#!/usr/bin/env bash
# The whole way on a clean home folder: the install script takes a local release, and the smoke test
# runs on the installed command, up to the shared design. scripts/e2e-install.sh <binary for this system>
set -euo pipefail

bin=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
here=$(cd "$(dirname "$0")" && pwd)
dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT

version=$("$bin" --version | cut -d' ' -f2)
name=$(basename "$bin")
mkdir -p "$dir/release/v$version" "$dir/home with space"
cp "$bin" "$dir/release/v$version/$name"
(cd "$dir/release/v$version" && {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$name"; else shasum -a 256 "$name"; fi
} > SHA256SUMS)

env -i HOME="$dir/home with space" PATH=/usr/bin:/bin DOI_INSTALL_BASE_URL="file://$dir/release" sh "$here/install.sh" --version "$version"
installed="$dir/home with space/.local/bin/doi"
[ -x "$installed" ] || { echo "FAIL: no installed doi"; exit 1; }
grep -q "doi installer" "$dir/home with space/.profile" || { echo "FAIL: no PATH line"; exit 1; }
"$here/smoke-binary.sh" "$installed"
echo "install to shared design passed: $name"
