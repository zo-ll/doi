# doi user guide

doi is a local design tool for one person. You describe a design in chat. A model writes plain HTML and CSS. A canvas shows each page live, in one or more frames. A coding agent can then build the design in your app.

doi runs on your computer only. The server listens on `127.0.0.1`. Your designs, the chat and the version history stay in one folder, the workspace.

![The doi window: chat on the left, the canvas in the middle, comments on the right](images/canvas.png)

## Contents

1. [Install](#install)
2. [Configure](#configure)
3. [Providers and models](#providers-and-models)
4. [Make a design](#make-a-design)
5. [Edit on the canvas](#edit-on-the-canvas)
6. [Comments, variants and history](#comments-variants-and-history)
7. [Design systems](#design-systems)
8. [Export](#export)
9. [Hand off to a coding agent (MCP)](#hand-off-to-a-coding-agent-mcp)
10. [The workspace](#the-workspace)
11. [Shortcuts](#shortcuts)
12. [Troubleshooting](#troubleshooting)

## Install

### Requirements

| Tool | Necessary | Used for |
| --- | --- | --- |
| [Bun](https://bun.sh) 1.4.3 or later | Only to run from the source or to build the binary | The server, the UI bundle and the tests |
| `git` | Yes | The version history of the workspace |
| `claude` (Claude Code CLI) or `codex` (Codex CLI) | One of them, or an API key | The model. See [Providers and models](#providers-and-models) |
| Chromium for Playwright | No | PNG and PDF export, and the screenshots in a handoff bundle |
| `gh` (GitHub CLI) | No | A link from a project to the GitHub repo of your app |

You can run doi as one binary, or from the source.

### The binary

The binary contains the server, the UI and the Bun runtime. It runs without Bun on Linux (x64, arm64) and macOS (arm64, x64).

1. Build the binaries on a computer with Bun. The binaries go to `dist/`, for example `dist/doi-0.1.0-linux-x64`:

   ```bash
   bun install
   bun run build                    # all four targets
   bun run build bun-darwin-arm64   # one target
   ```

2. Copy the binary for your system to a folder on your `PATH`, with the name `doi`.
3. Optional: install Chromium for PNG and PDF export:

   ```bash
   doi install-browser
   ```

4. Start doi:

   ```bash
   doi --open
   ```

The binary has no developer signature. If you download a macOS binary and Gatekeeper stops it, run `xattr -d com.apple.quarantine ./doi` one time.

### From the source

1. Get the code and install the packages:

   ```bash
   git clone https://github.com/zo-ll/doi.git
   cd doi
   bun install
   ```

2. Optional: install Chromium for PNG and PDF export:

   ```bash
   bun run install-browser
   ```

3. Optional: copy the example configuration. doi works without it.

   ```bash
   cp config.example.toml config.toml
   ```

4. Start doi:

   ```bash
   bun run start      # or: bun run dev (reloads when the source changes)
   ```

5. Open http://127.0.0.1:4317 in your browser.

On the first start, doi makes the folder `./workspace` with a git repository and a sample design.

### Start options

The binary and `bun run start` take the same options, for example `bun run start --port 5000`.

| Option | Description |
| --- | --- |
| `--config <file>` | The config file. The default is `config.toml` in the current folder |
| `--workspace <dir>` | The workspace folder. It replaces `workspace` from the config |
| `--port <n>` | The port on `127.0.0.1`. It replaces `port` from the config |
| `--open` | Open doi in the default browser after the start |
| `-v`, `--version` | Show the version |
| `-h`, `--help` | Show the help |
| `install-browser` | Install Chromium for PNG and PDF export, then stop |

## Configure

doi reads `config.toml` from the folder where you start it, or the file from `--config`. All keys are optional. A relative `workspace` path is relative to the folder of the config file. `config.example.toml` lists them with comments.

| Key | Default | Description |
| --- | --- | --- |
| `workspace` | `"./workspace"` | The folder for your projects, design systems and history |
| `port` | `4317` | The port of the server on `127.0.0.1` |
| `editor_url` | `"vscode://file{path}"` | The link that opens a design system file in your editor. doi puts the file path in `{path}` |
| `[providers.<id>]` | | Settings for one provider: `api_key_env`, `base_url`, `formats` |
| `[models]` | Claude Code models | The model for each task: `generate`, `edit`, `extract` |
| `[prices]` | | Prices in USD for each 1M tokens, for the usage report |

Settings (Ctrl/⌘ + ,) in the app writes only the `[models]` lines. The import of a `.doi.zip` file with its settings can also write the `[prices]` table. The other lines and your comments stay as they are. To change the prices, edit `config.toml`.

## Providers and models

A model reference has the form `provider:model`, for example `claude-code:claude-sonnet-5-5`. doi uses three tasks:

- `generate`: full designs and new pages.
- `edit`: a small change to one selected element.
- `extract`: the import of a design system. A screenshot import needs a model with vision.

### Subscriptions through the official CLIs

doi can use your subscription through the official CLI of the vendor. doi starts the CLI for each turn. You do not need an API key.

| Provider id | CLI | Log in |
| --- | --- | --- |
| `claude-code` | `claude -p` | `claude auth login`, or Settings → Models and providers → OAuth |
| `codex` | `codex exec` | `codex login`, or Settings → Models and providers → OAuth |

The OAuth button in Settings only starts the login command of the CLI. The CLI keeps the token. doi asks the CLI only if it is logged in. doi never reads or stores the token.

With `codex:default`, Codex uses the model from your Codex configuration.

### API keys

| Provider id | Default variable | Notes |
| --- | --- | --- |
| `anthropic` | `ANTHROPIC_API_KEY` | Anthropic API |
| `openai` | `OPENAI_API_KEY` | OpenAI Responses API |
| `opencode-go` | `OPENCODE_API_KEY` | OpenCode Go. Set `formats` in `config.toml` for a model that doi does not know |

You can give a key in two ways:

- Set the environment variable. `api_key_env` in `config.toml` can name a different variable.
- Open Settings → Models and providers, select the provider, select API key, and paste the key. doi keeps the key in the system keychain. If there is no keychain, doi keeps it in `~/.config/doi/credentials.json` (mode 0600).

If both exist, the environment variable wins. doi never shows a key in the UI.

The ids `google`, `openrouter` and `ollama` are reserved for adapters that are not available yet.

![Settings: the provider login and the model for each task](images/settings.png)

### Usage and cost

Usage (top bar) shows the tokens of each answer. For an API model with an entry in `[prices]`, it also shows an estimated cost. A subscription shows tokens only.

## Make a design

1. Open the projects drawer (the doi logo, or Ctrl/⌘ + P). Make a project, then a design or a slide deck.
2. Type a description in the chat on the left, and send it with Ctrl/⌘ + Enter.
3. The model writes the pages. The canvas shows each page in its frames, for example Desktop and Mobile.
4. Send more messages to change the design. Each completed turn is a new version.

You can attach images to a message (Attach), for example a sketch or a screenshot.

The canvas has three tools:

- Select (V): click an element to select it. Shift-click selects its parent.
- Comment (C): click an element to add a comment to it.
- Hand (H): move the canvas.

"+ Frame" (F) adds a frame size. "Arrange" puts the frames in a row. The zoom controls are at the bottom.

When an element is selected, your next message changes only that element. doi uses the `edit` model for it. The chip above the message box shows the selected element. Click × on the chip to clear the selection.

Every meaningful element in a design has a `data-oid` attribute. Selection, comments and edits use it. doi adds missing ids after each turn.

## Edit on the canvas

With the Select tool, you can change the selected element directly. doi writes each change as CSS in a `[data-oid="…"]` rule at the end of `styles.css`, or moves the element in the HTML. Each change is one version.

- **Resize:** drag a handle on the right edge, the bottom edge or the corner. The size snaps to the spacing unit.
- **Move:** drag the tag label of the element. A line shows where the element goes among its siblings.
- **Margins:** hold Alt and drag the tag label. The margins snap to the spacing scale.
- **Align:** use the bar under the element: start, center or end, horizontal or vertical.
- **Undo:** Ctrl/⌘ + Z undoes the last edit as a new version.

The spacing scale comes from the `--space-*`, `--spacing-*` and `--gap-*` variables on `:root`. If there are none, doi uses a 4 px scale.

An edit applies to all frames. A more specific rule in the design can still win over the edit rule. An element moves only among its siblings, not into a different parent.

### Tweaks

Tweaks (T) shows controls for the CSS variables of the design, for example colors and sizes. The canvas changes live. "Save as version" writes the values.

## Comments, variants and history

### Comments

Select an element and press N, or use the Comment tool (C). The Comments tab on the right lists the comments, and the canvas shows a pin on each element.

- Apply puts a comment into your next message.
- Done marks a comment as complete. When a turn includes an applied comment and changes its element, doi marks that comment as done.

### Variants

Select 2, 3 or 4 next to the message box before you send. doi makes that number of variants of the same request. Pick one variant to keep it. History can bring a variant set back after a pick.

### History

The History tab lists the versions of the design. Every turn, pick, edit, restore and rename is a version. Preview shows an old version on the canvas. Restore makes the old version the current one, as a new version. No version is lost.

![The History tab: each version with its kind](images/history.png)

## Design systems

A design system gives the model your tokens, components and rules. Open Design system (Ctrl/⌘ + D) in the top bar.

- **Import from a repo:** give the path of a local repo. doi reads its theme files, token files, stylesheets and main components, and the `extract` model writes the design system. doi does not read files that look like secrets.
- **Import from screenshots:** give 1 to 5 screenshots and optional notes. The `extract` model needs vision.
- **Use for a project:** select "Use in <project>". The pages of the project then link the tokens and component styles of the design system.

A design system is a folder in `design-systems/<name>/` with these optional files: `tokens.css`, `components.html`, `components.css`, `rules.md`, `fonts/` and `screenshots/`. You can edit them in your editor.

### The code of your app

A project can link the GitHub repo of your app. Click "Link the app's repo" in the top bar. You must install `gh` and log in with `gh auth login` first. doi keeps a shallow clone in `<workspace>/.repos/`. The model can then read the code of your app, so you can ask, for example, "Recreate the settings page". Turns with a linked repo read more code, so they use more tokens.

## Export

Open Export (Ctrl/⌘ + E).

| Format | Result |
| --- | --- |
| Folder | A ZIP with all pages and files, and the design system files that they link |
| HTML | One HTML file with the styles, scripts, images and fonts inline |
| PNG | An image of one frame, or a ZIP with all frames |
| PDF | One PDF page for each slide of a deck, or one page for other designs |

"Remove element ids" strips the `data-oid` attributes from the HTML. Keep them for a handoff, because comments name the elements by their ids.

PNG and PDF need Chromium. Run `doi install-browser` (from the source: `bun run install-browser`) one time.

![The Export dialog](images/export.png)

### Projects and the workspace

You can export one project (projects drawer → Export) or the full workspace (Settings → Workspace) to a `.doi.zip` file. The file contains the version history. It can also contain the model choice, the prices and the UI preferences. Import the file in any doi workspace.

## Hand off to a coding agent (MCP)

doi does not start coding agents. Any coding agent with an MCP client reads the design from doi through the MCP server of doi. The server is at `/mcp` on the doi server, for example `http://127.0.0.1:4317/mcp`. It uses the Streamable HTTP transport and has no authentication. It accepts only requests from your computer.

### Add the MCP server to your agent

Do this one time for each agent. Use the URL that Hand off shows. It contains the port from `config.toml`.

- Claude Code:

  ```bash
  claude mcp add --transport http doi http://127.0.0.1:4317/mcp
  ```

- Codex:

  ```bash
  codex mcp add doi --url http://127.0.0.1:4317/mcp
  ```

- Other agents: add an MCP server with the name `doi`, the transport Streamable HTTP, and the URL above. Refer to the documentation of your agent.

The agent reads the design from doi while it works. Keep doi running until the agent stops.

### The MCP tools

| Tool | Result |
| --- | --- |
| `list_designs` | The projects and their designs |
| `get_design` | The files of a design, its pages, frames, design system name and the last requests |
| `get_design_system` | The tokens, components and rules of the design system of a project |
| `get_comments` | The open comments of a design (with `all`: the done comments too) |
| `export_png` | An image of one page in one frame |

### Give the task to the agent

1. Open Hand off (Ctrl/⌘ + Shift + H).
2. Edit the prompt if necessary, and click Copy prompt.
3. Start your agent in the repo of your app, and paste the prompt.

The prompt tells the agent to read the design through the tools, to use the framework and components of your repo, and to run the checks of your repo.

For an agent that cannot reach doi, for example an agent in the cloud, use the "Handoff bundle (ZIP)" tab. The bundle contains a `HANDOFF.md` file, the design files, screenshots of each page and frame, and `tokens.css` when the design or its design system has tokens.

![Hand off: the MCP URL and the prompt for a coding agent](images/handoff.png)

## The workspace

The workspace is a git repository. doi commits each change with your own git identity. You can read the history with `git log`.

```text
workspace/
├── projects/
│   └── <project>/
│       ├── project.json          # name, layouts (the frames), design system, linked repo
│       ├── chat.jsonl            # one line for each chat message
│       ├── designs/
│       │   └── <design>/
│       │       ├── index.html    # the pages (more .html files are more pages)
│       │       ├── styles.css
│       │       ├── tweaks.json   # optional: the Tweaks controls
│       │       └── .comments.json
│       ├── variants/<design>/<set>/<n>/   # open variant sets
│       └── uploads/              # images that you attached to messages
├── design-systems/
│   └── <name>/                   # tokens.css, components.html, components.css, rules.md, fonts/, screenshots/
└── .repos/<owner>/<repo>/        # clones of linked app repos (not in the history)
```

A design is plain HTML and CSS. You can open it in your editor. doi reloads the canvas when a file changes. If you edit a file yourself, commit the change in the workspace, or the next doi change can include it.

## Shortcuts

On macOS, use ⌘ in place of Ctrl.

| Action | Keys |
| --- | --- |
| Projects | Ctrl + P |
| Collapse the chat / the side panel | Ctrl + [ / Ctrl + ] |
| Design system | Ctrl + D |
| Export / Hand off | Ctrl + E / Ctrl + Shift + H |
| Settings | Ctrl + , |
| Select / Comment / Hand tool | V / C / H |
| New comment on the selection | N |
| Add a frame | F |
| Tweaks | T |
| Zoom in / out / 100% / fit | + / − / 0 / Shift + 1 |
| Send / stop | Ctrl + Enter / Esc |
| Undo the last canvas edit | Ctrl + Z |
| Select the parent element | Shift-click |

Settings → Shortcuts shows the same list without Ctrl + Z.

## Troubleshooting

- **The model status is not green.** Open Settings → Models and providers. Log in to the CLI, or add an API key. "Check again" reads the status again.
- **"Another change runs on this design".** A turn, a rename or an edit is in progress on the design. Wait until it stops, and then try again.
- **"This design has open variants".** Pick a variant or discard the set first.
- **PNG or PDF export gives an error (503).** Chromium is not installed. Run `doi install-browser`, or `bun run install-browser` from the source.
- **The agent does not have the doi tools.** Add the MCP server (see [Hand off](#hand-off-to-a-coding-agent-mcp)), make sure that doi runs, and start the agent again.
- **The port is in use.** Set a different `port` in `config.toml`.
