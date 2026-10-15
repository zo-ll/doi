# doi

A local, single-user design tool in the style of Claude Design. You describe a design in chat, a model writes HTML and CSS, and a canvas shows it live. Any model provider can generate, and any coding agent can implement the result.

Design doc: https://claude.ai/code/artifact/4d202f6c-3105-4a19-8315-24b41aedf3ae

Agents working on the repo: start with [docs/agent-handoff.md](docs/agent-handoff.md).

## Status

In progress (M5, breadth). The core loop (M1), precision tools (M2), design systems (M3) and the handoff (M4) work. See [docs/agent-handoff.md](docs/agent-handoff.md).

doi uses your subscriptions through the official CLIs by default: `claude-code:<model>` (`claude -p`) and `codex:<model>` (`codex exec`). Log in to the CLI first, or use the Log in button in Settings. To use an API key, select the provider in Settings (Models and providers), select API key, and paste the key. doi keeps it in the system keychain, or in `~/.config/doi/credentials.json` (mode 0600) when there is no keychain. An environment variable (see `config.example.toml`) wins over a stored key.

## Run

```bash
bun install
cp config.example.toml config.toml   # optional
bun run dev                          # http://127.0.0.1:4317
```

The first run creates `./workspace` with a sample design.

## Use

- Describe a design in the chat on the left. The canvas shows each page in its frames (Desktop, Mobile, …).
- Click an element to target it (Shift-click: its parent). Press N for a comment on it, or use the Comment tool (C). "Apply" puts a comment into the next message.
- Make 2–4 variants of one request and pick one. History (right panel) previews and restores any version.
- Tweaks (T) change the design's CSS variables live; "Save as version" writes them.
- Design systems (⌘D / Ctrl+D) come from a repo or from screenshots.
- Export (⌘E) gives a folder, one HTML file, PNG or PDF. Hand off (⌘⇧H) gives a prompt for any coding agent, which reads the design through the MCP server at `/mcp`, or a ZIP bundle.
- Settings (⌘,) chooses the model per task and writes it to `config.toml`. Usage shows tokens and estimated cost.
- Export a project (projects drawer → Export) or the whole workspace (Settings → Workspace) to one `.doi.zip` file, with its version history, and import it in any doi workspace. The file can also carry the model choice, the prices and the UI preferences.
- Link the app's GitHub repo to a project (the chip next to the design system; needs the `gh` CLI, logged in). The model then reads the app's code, so you can ask "Recreate the settings page".

All shortcuts are in Settings → Shortcuts.

## Check

```bash
bun test
bun check
```

## Layout

| Path | Contents |
| --- | --- |
| `src/server/` | `Bun.serve` routes, design file serving, bridge injection |
| `src/web/` | React UI (HTML import, no Vite): shell, chat, canvas, comments, history and the dialogs; tokens in `tokens.css` (doi UI kit, light and dark), IBM Plex bundled |
| `src/frame/bridge.js` | Script injected into each design iframe for selection |
| `src/providers/` | `Provider` interface, API adapters (Anthropic, OpenAI, OpenCode Go) and the CLI backends (Claude Code, Codex) |
| `src/mcp/` | MCP server at `/mcp`: coding agents read designs through it |
| `src/workspace/` | Workspace layout and safe path helpers |
| `test/` | `bun test` suites |
