
Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun check` instead of `tsc --noEmit`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Type checking

Use `bun check` to type check the project. It reads `tsconfig.json` and reports the same errors as `tsc`.

- `bun check src/index.ts` checks one file and what it imports
- `bun --check src/index.ts`, `bun test --check` and `bun build --check` type check first, and do nothing else if there is an error

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.

## doi project notes

- **Start here:** read `docs/agent-handoff.md` for the current state, the workflow, and the next issues. Update it when you stop.
- The design doc is the source of truth: https://claude.ai/code/artifact/4d202f6c-3105-4a19-8315-24b41aedf3ae
- Designs are plain HTML + CSS only. Do not add React or framework output for designs.
- Every meaningful element in a design carries a `data-oid` attribute. Selection, comments and targeted edits depend on it.
- Design iframes use `sandbox="allow-scripts"` without same-origin access. They talk to the app only through `postMessage`.
- Vendor SDKs and agent CLIs are used only inside `src/providers/*`. CLI flags change between releases: check the CLI docs before you change a command line.
- doi does not start coding agents for a handoff. Any agent reads a design through the MCP server at `/mcp` (`src/mcp/server.ts`), with the prompt from `src/handoff/prompt-v0.md`. Do not add code or settings for one agent.
- GitHub only through the official `gh` CLI, inside `src/github/*`. doi never reads the gh token; `gh auth status` gives only its exit code.
- Credentials: an API key comes from the environment variable named in `config.toml` (`api_key_env`), or from Settings. Settings stores a key in the system keychain (`Bun.secrets`), else in `~/.config/doi/credentials.json` (0600), through `src/providers/keys.ts` only. The variable wins. The API never returns a key. Subscriptions go only through the official CLIs (`claude -p`, `codex exec`); OAuth in Settings runs only `claude auth login` or `codex login` (`src/providers/login.ts`).
- Never read, copy or store OAuth tokens or credential files of other apps (Claude Code, Codex, pi, OpenCode). Anthropic's terms forbid other apps to use Claude subscription credentials: https://code.claude.com/docs/en/legal-and-compliance
- Status checks may ask a CLI for its login state, but must not return account details or secrets to the UI.
