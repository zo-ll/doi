# doi

A local, single-user design tool in the style of Claude Design. You describe a design in chat, a model writes HTML and CSS, and a canvas shows it live. Any model provider can generate, and any coding agent can implement the result.

Design doc: https://claude.ai/code/artifact/4d202f6c-3105-4a19-8315-24b41aedf3ae

Agents working on the repo: start with [docs/agent-handoff.md](docs/agent-handoff.md).

## Status

In progress (M4, handoff). The core loop (M1), precision tools (M2) and design systems (M3) work. See [docs/agent-handoff.md](docs/agent-handoff.md).

doi uses your subscriptions through the official CLIs by default: `claude-code:<model>` (`claude -p`) and `codex:<model>` (`codex exec`). Log in to the CLI first. API keys are optional; see `config.example.toml`.

## Run

```bash
bun install
cp config.example.toml config.toml   # optional
bun run dev                          # http://127.0.0.1:4317
```

The first run creates `./workspace` with a sample design.

## Check

```bash
bun test
bun check
```

## Layout

| Path | Contents |
| --- | --- |
| `src/server/` | `Bun.serve` routes, design file serving, bridge injection |
| `src/web/` | React UI (HTML import, no Vite): chat panel and canvas |
| `src/frame/bridge.js` | Script injected into each design iframe for selection |
| `src/providers/` | `Provider` interface, API adapters (Anthropic, OpenAI, OpenCode Go) and the CLI backends (Claude Code, Codex) |
| `src/harnesses/` | `Harness` interface, CLI adapters, handoff |
| `src/workspace/` | Workspace layout and safe path helpers |
| `src/mcp/` | MCP server (M4) |
| `test/` | `bun test` suites |
