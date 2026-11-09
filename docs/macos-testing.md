# Test the macOS installer before merge

This branch adds a native macOS binary for Apple silicon only. Intel Macs are not supported. The owner will merge it after a test on a Mac. The published v0.1.0 release contains no macOS binary. The candidate also reports `0.1.0`, but it is not that published release.

## Download the candidate

1. Open the CI run for `feature/macos-installation` on GitHub.
2. Make sure the macOS job passed.
3. Download `macos-installation-arm64`.
4. Extract the ZIP into a new folder whose path has no spaces.
5. Open Terminal in that folder.

The artifact contains `install.sh`, this document, checksums and a local release folder. You do not need Bun or a source checkout. If the artifact expired, repeat the macOS job. The standard `macos-15` runner is free for this public repository.

## Install

**Warning:** This candidate has no Developer ID signature or notarization. Its checksums detect damage, but they do not identify its author. Use only the artifact from the expected repository and commit. Do not disable Gatekeeper. If macOS blocks this candidate, record the exact error in the PR.

1. Verify the files:

   ```sh
   shasum -a 256 -c SHA256SUMS
   ```

2. Install from the local release folder:

   ```sh
   DOI_INSTALL_BASE_URL="file://$PWD/release" sh install.sh --version 0.1.0
   ```

3. Open a new terminal.
4. Return to the extracted artifact folder.
5. Check the installed command:

   ```sh
   command -v doi
   doi --version
   file "$(command -v doi)"
   doi doctor
   ```

The default install folder is `~/.local/bin`. The installer adds it to `.profile` and `.zprofile`. It also updates existing Bash and Zsh startup files. An Apple silicon Mac gets the ARM64 binary, even when Rosetta runs the shell. The installer refuses Intel Macs before download.

If git is absent, install the Command Line Tools before you start doi. macOS may offer that install after `git --version`.

### Rosetta on Apple silicon

This check applies only to Apple silicon with Rosetta. If Rosetta is absent, record that limit in the PR.

1. Confirm the translated shell:

   ```sh
   arch -x86_64 /usr/bin/uname -m
   ```

2. Make sure the output is `x86_64`.
3. Repeat the local install through that shell:

   ```sh
   DOI_INSTALL_BASE_URL="file://$PWD/release" arch -x86_64 /bin/sh install.sh --version 0.1.0 &&
     file "$(command -v doi)"
   ```

4. Make sure the install succeeds and its message names `macOS arm64`.
5. Make sure the `file` output identifies `arm64`.

## Test the app

1. Install the renderer:

   ```sh
   doi install-browser
   ```

2. Start an isolated workspace:

   ```sh
   doi start --workspace "$PWD/test-workspace" --json --open
   ```

3. Make sure the launch result names that workspace and reports the renderer as ready.
4. Open the sample design from Projects.
5. Select an element on the canvas.
6. Change its width.
7. Export a PNG.
8. Check the server status:

   ```sh
   doi status --workspace "$PWD/test-workspace" --json
   ```

The config stays in `~/.config/doi`. The default workspace stays in `~/.local/share/doi/workspace`, unless XDG variables name other folders. This test uses the explicit workspace instead. The install and the sample design need no model request.

## Upgrade and uninstall

1. Stop the test server:

   ```sh
   doi stop --workspace "$PWD/test-workspace" --json
   ```

2. Repeat the install command.
3. Make sure the sample edit remains in `test-workspace`.
4. Uninstall the command:

   ```sh
   sh install.sh --uninstall
   ```

5. Make sure `~/.local/bin/doi` is absent.
6. Make sure the installer removed only its own PATH lines.
7. Make sure `test-workspace` and the existing config remain.

Record the macOS version, CPU, CI run and any errors in the PR. Do not merge until the test on a Mac passes. A later versioned release must include the macOS files before the normal public install command can work on a Mac.
