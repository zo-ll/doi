# doi

A local, single-user design tool in the style of Claude Design. You describe a design in chat, a model writes HTML and CSS, and a canvas shows it live. Any model provider can generate, and any coding agent can implement the result.

Design doc: https://claude.ai/code/artifact/4d202f6c-3105-4a19-8315-24b41aedf3ae

Agents working on the repo: start with [docs/agent-handoff.md](docs/agent-handoff.md).

## Status

In progress (M1). The app shell, element selection, provider status, the Anthropic and OpenCode Go adapters, and the Claude Code and Codex subscription backends work. The generation loop (endpoint, edit applier, history) is next. See [docs/agent-handoff.md](docs/agent-handoff.md).

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
| `src/providers/` | `Provider` interface and adapters (Anthropic, OpenAI stubs) |
| `src/harnesses/` | `Harness` interface, CLI adapters, handoff |
| `src/workspace/` | Workspace layout and safe path helpers |
| `src/mcp/` | MCP server (M4) |
| `test/` | `bun test` suites |
