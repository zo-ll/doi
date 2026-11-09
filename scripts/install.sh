#!/bin/sh
# Installs the doi command for this user, without administrator access. Linux only.
#
#   curl -fsSL https://raw.githubusercontent.com/zo-ll/doi/main/scripts/install.sh | sh
#   sh install.sh --version 0.1.0 --dir "$HOME/bin"
#   sh install.sh --uninstall
#
# Nothing else changes: an upgrade or a failed install leaves your designs, config, history and
# credentials as they are, and the old binary stays until a new one has passed every check.
set -eu

REPO="zo-ll/doi"
BASE="${DOI_INSTALL_BASE_URL:-https://github.com/$REPO/releases/download}"
VERSION="${DOI_VERSION:-}"
DIR="${DOI_INSTALL_DIR:-}"
HOME="${HOME:-}"
MODIFY_PATH=1
UNINSTALL=0
MARK="# added by the doi installer"

fail() { printf 'doi install: %s\n' "$1" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --version) [ $# -ge 2 ] || fail "--version needs a value."; VERSION="$2"; shift 2 ;;
    --dir) [ $# -ge 2 ] || fail "--dir needs a value."; DIR="$2"; shift 2 ;;
    --no-modify-path) MODIFY_PATH=0; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    *) fail "unknown option $1. Options: --version <v>, --dir <folder>, --no-modify-path, --uninstall." ;;
  esac
done
if [ -z "$DIR" ]; then
  [ -n "$HOME" ] || fail "HOME is not set. Use --dir <folder>."
  DIR="$HOME/.local/bin"
fi
case "$DIR" in /*) ;; *) DIR="$PWD/$DIR" ;; esac
case "$DIR" in *'
'*) fail "the folder name has a line break." ;; esac
# One line for each folder, so an uninstall of one folder leaves the line of another.
LINE_MARK="$MARK: $DIR"

# The shell files that can set PATH. .profile is the one that a new line can always go to.
rc_candidates() {
  [ -n "$HOME" ] || return 0
  for rc in "$HOME/.profile" "$HOME/.bash_profile" "$HOME/.bashrc" "$HOME/.zprofile" "$HOME/.zshrc"; do
    if [ "$rc" = "$HOME/.profile" ] || [ -f "$rc" ]; then printf '%s\n' "$rc"; fi
  done
}

# The folder that doi uses: a relative XDG path counts as missing, as in src/user-dirs.ts.
xdg_or() {
  case "$1" in /*) printf '%s' "$1" ;; *) printf '%s' "$2" ;; esac
}

if [ "$UNINSTALL" = 1 ]; then
  rm -f "$DIR/doi" || fail "cannot remove $DIR/doi."
  rc_candidates | while IFS= read -r rc; do
    [ -f "$rc" ] || continue
    if grep -qF "$LINE_MARK" "$rc" 2>/dev/null; then
      # grep exits with 1 when no line stays, and that is a good result here.
      grep -vF "$LINE_MARK" "$rc" > "$rc.doi-tmp" || true
      if ! cat "$rc.doi-tmp" 2>/dev/null > "$rc"; then
        printf 'doi install: cannot write %s. Remove the line with "%s" yourself.\n' "$rc" "$MARK" >&2
      fi
      rm -f "$rc.doi-tmp"
    fi
  done || true
  printf 'doi is removed from %s.\n' "$DIR"
  if [ -n "$HOME" ]; then
    printf 'Your designs, config and credentials stay. To delete them, remove %s and %s.\n' \
      "$(xdg_or "${XDG_DATA_HOME:-}" "$HOME/.local/share")/doi" "$(xdg_or "${XDG_CONFIG_HOME:-}" "$HOME/.config")/doi"
  else
    printf 'Your designs, config and credentials stay.\n'
  fi
  exit 0
fi

os=$(uname -s)
case "$os" in
  Linux) ;;
  Darwin) fail "doi publishes binaries for Linux and Windows, and not for macOS. On a Mac, build it from the source: see the user guide." ;;
  *) fail "doi has no binary for $os. It publishes for Linux and Windows." ;;
esac
machine=$(uname -m)
case "$machine" in
  x86_64 | amd64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) fail "doi has no Linux binary for the CPU $machine. It publishes x64 and arm64." ;;
esac
if [ -e /etc/alpine-release ] || { command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl; }; then
  fail "this system uses musl libc, and the doi binaries need glibc. Build doi from the source: see the user guide."
fi

if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL --retry 2 -o "$2" "$1"; }
  latest() { curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -q -O "$2" "$1"; }
  latest() { wget -q -S --spider "https://github.com/$REPO/releases/latest" 2>&1 | sed -n 's/^ *[Ll]ocation: //p' | tail -1 | tr -d '\r'; }
else
  fail "curl or wget is necessary."
fi
if command -v sha256sum >/dev/null 2>&1; then
  sha() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  fail "sha256sum or shasum is necessary to verify the download."
fi

if [ -z "$VERSION" ]; then
  tag=$(latest) || fail "cannot find the latest release of $REPO."
  VERSION=${tag##*/}
fi
VERSION=${VERSION#v}
case "$VERSION" in
  '' | *[!0-9A-Za-z.-]*) fail "'$VERSION' is not a version." ;;
esac

name="doi-$VERSION-linux-$arch"
mkdir -p "$DIR" || fail "cannot make $DIR."
# In the install folder, so the last step is an atomic rename on one file system.
tmp=$(mktemp -d "$DIR/.doi-install.XXXXXX") || fail "cannot write to $DIR."
trap 'rm -rf "$tmp"' EXIT
trap 'exit 130' INT TERM

printf 'Downloading doi %s for Linux %s…\n' "$VERSION" "$arch"
fetch "$BASE/v$VERSION/SHA256SUMS" "$tmp/SHA256SUMS" || fail "cannot download the checksums of version $VERSION. Check the version and your connection."
fetch "$BASE/v$VERSION/$name" "$tmp/doi" || fail "the download of $name failed. Nothing changed."

want=$(awk -v f="$name" '$2 == f || $2 == "*" f { print $1 }' "$tmp/SHA256SUMS")
[ -n "$want" ] || fail "the checksums do not list $name. Nothing changed."
have=$(sha "$tmp/doi")
[ "$have" = "$want" ] || fail "the checksum of $name does not match, so the file is incomplete or changed. Nothing changed."

chmod 755 "$tmp/doi"
got=$("$tmp/doi" --version 2>/dev/null) || fail "the new binary does not run on this system. Nothing changed."
[ "$got" = "doi $VERSION" ] || fail "the new binary reports '$got', not doi $VERSION. Nothing changed."
mv -f "$tmp/doi" "$DIR/doi"

on_path=0
case ":${PATH:-}:" in *":$DIR:"*) on_path=1 ;; esac
if [ "$on_path" = 0 ]; then
  if [ "$MODIFY_PATH" = 1 ] && [ -n "$HOME" ]; then
    # Single quotes: nothing in the folder name runs, or breaks the file, at the next shell start.
    esc=$(printf '%s' "$DIR" | sed "s/'/'\\\\''/g")
    line="export PATH='$esc':\"\$PATH\" $LINE_MARK"
    # The binary is in place by now, so a shell file that cannot change must not fail the install.
    rc_candidates | while IFS= read -r rc; do
      if grep -qF "$LINE_MARK" "$rc" 2>/dev/null; then continue; fi
      if { printf '%s\n' "$line" >> "$rc"; } 2>/dev/null; then
        printf 'Added %s to your PATH in %s. Open a new terminal to use it.\n' "$DIR" "$rc"
      else
        printf 'doi install: cannot write %s. Add %s to your PATH yourself.\n' "$rc" "$DIR" >&2
      fi
    done || true
  else
    printf 'Add %s to your PATH to use the doi command.\n' "$DIR"
  fi
fi

printf 'Installed doi %s at %s.\n' "$VERSION" "$DIR/doi"
printf 'A doi that still runs keeps the old version until you run doi stop.\n'
printf 'Next: run doi doctor to check the tools, and doi install-browser for PNG, PDF and agent screenshots.\n'
printf 'Then start it with doi --open.\n'
