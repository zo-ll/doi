# Agent handoff

This file is for the next coding agent on doi. Read it before you start an issue. Update it when you stop.

Last update: 2026-10-12, after PR #84 (#7 generation endpoint). Tests: 103 pass. `bun check`: no errors.

## 1. What doi is

doi is a local, single-user design tool like Claude Design. The user describes a design in chat. A model writes plain HTML and CSS. A canvas shows the result live. A coding agent can then implement the design in a real repo.

- Design doc (source of truth for scope and decisions): https://claude.ai/code/artifact/4d202f6c-3105-4a19-8315-24b41aedf3ae
- Issues: https://github.com/zo-ll/doi/issues. Each issue has a milestone, an area label, tasks and "Done when" checks.
- Repo rules for agents: `CLAUDE.md`. Read it first.

## 2. Rules you must follow

1. **Commit identity.** Commit only with the git identity that is configured in the repo (the user's own). Do not add AI attribution anywhere: no `Co-Authored-By` trailers, no "Generated with" lines, no AI or vendor names in commit messages, PR bodies or issue text.
2. **Credentials.** Never read, copy or store OAuth tokens or credential files of other apps (Claude Code, Codex, pi, OpenCode). Anthropic's terms forbid other apps to use Claude subscription credentials (https://code.claude.com/docs/en/legal-and-compliance). API keys come only from environment variables. Subscriptions go only through the official CLIs.
3. **Designs are plain HTML and CSS.** No React or other framework output for designs. Every meaningful element has a `data-oid`.
4. **Sandbox.** Design iframes use `sandbox="allow-scripts"` without `allow-same-origin`. They talk to the app only through `postMessage`.
5. **Layers.** Vendor SDKs only in `src/providers/*`. Agent CLIs only in `src/providers/claude-code.ts`, `src/providers/codex.ts` and `src/harnesses/*`.
6. **Check APIs against local docs, not memory.** The AI SDK is v7. Its docs are in `node_modules/ai/docs` and `node_modules/@ai-sdk/*/docs`. CLI flags change between releases: run `claude --help` or `codex exec --help` before you change a command line.
7. **Spending.** Real runs of `claude -p` and `codex exec` use the user's subscriptions. Keep manual runs small (Haiku, short prompts).

## 3. Workflow

1. Take the next issue (section 6). Create a branch from `main`, for example `provider/openai`.
2. Write the code and the tests. Run `bun test` and `bun check`.
3. Push, and open a PR with "Closes #N". If a "Done when" item needs something you cannot do (for example a real API key), write "Part of #N" and list what is missing.
4. A critic reviews the PR with the user's `code-review` skill. On this machine it is a pi session in tmux window `default:doi-critic` (window `critic` belongs to another project). It sends its verdict to the coder pane with `tmux send-keys`. Fix every finding that is concrete, or explain in the PR why you do not.
5. Before you merge, wait for CI on the exact head commit:
   ```sh
   SHA=$(git rev-parse HEAD)
   RID=$(gh run list --branch <branch> --json databaseId,headSha --jq ".[] | select(.headSha==\"$SHA\") | .databaseId" | head -1)
   gh run watch "$RID" --exit-status
   ```
   `gh pr checks` can report "no checks" before the run starts. That is not a pass.
6. Merge with a merge commit: `gh pr merge <n> --merge --delete-branch`. Do not squash a PR that another PR is stacked on.
7. If PR B is stacked on PR A, change the base of B to `main` before you merge A. Deleting the base branch of B closes B.

## 4. Run and check

```sh
bun install
bun run dev                     # http://127.0.0.1:4317, creates ./workspace with a sample design
bun test
bun check
bun scripts/try-provider.ts <provider:model> ["prompt"] [--abort-after <ms>]
```

- `config.example.toml` lists all settings. Copy it to `config.toml` (ignored by git).
- `GET /api/providers` shows for each provider if it is ready and why not.
- Screenshots: Playwright works from a scratch folder. Point `executablePath` at a Chromium in `~/.cache/ms-playwright/`. Inside the scaled iframes, click with `page.mouse` at computed page coordinates; Playwright's own frame clicks fail there.

## 5. Code map

| Path | Contents |
|---|---|
| `src/server/index.ts` | `Bun.serve` routes: UI, `/api/*`, design files with the bridge script injected |
| `src/config.ts` | `config.toml` loading, provider ids, `keyEnvFor()` |
| `src/workspace/paths.ts` | Safe design paths, `listProjects()`, sample workspace |
| `src/frame/bridge.js` | Script in each design iframe: click → `data-oid` → `postMessage` |
| `src/web/` | React UI (Bun HTML import, no Vite). All sizes and colors in `tokens.css`; only 1px hairlines are literal |
| `src/providers/types.ts` | `Provider`, `GenerateRequest`, `GenerateEvent`, capabilities incl. `editsFiles` |
| `src/providers/ai-sdk.ts` | Shared AI SDK helper: a cache marker on each system part (max 4), `edit`/`write` tools without `execute`, stream mapping |
| `src/providers/anthropic.ts` | Anthropic API key adapter |
| `src/providers/openai.ts` | OpenAI API key adapter (Responses API, automatic cache) |
| `src/providers/opencode-go.ts`, `opencode-go-formats.ts` | OpenCode Go: three wire formats chosen per model |
| `src/providers/claude-code.ts` | Claude subscription through `claude -p` (stream-json, `--restricted`) |
| `src/providers/codex.ts` | ChatGPT subscription through `codex exec --json` |
| `src/providers/cli.ts` | Process helpers shared by the two CLI backends |
| `src/providers/status.ts` | Provider readiness without secrets or account details |
| `src/providers/registry.ts` | Provider factories, `isImplemented()` |
| `src/harnesses/` | Coding-agent CLIs for handoff (M4); `asProvider()` for the two subscription CLIs |
| `src/generation/prompts.ts`, `prompts/system-v0.md` | System prompt as a versioned file (`SYSTEM_PROMPT`). A new version is a new file |
| `src/generation/context.ts` | `assembleContext()`: request order, history trimming, size check; `readDesignFiles()` |
| `src/generation/apply.ts` | `applyChanges()` (all or none, rollback) and `runTurn()` (retry once, then full rewrite; skips `editsFiles` providers) |
| `src/server/turns.ts` | `POST .../turns`: one turn per design (409 while one runs), SSE events, abort on disconnect. `target` set → `models.edit`, else `models.generate` |
| `test/fixtures/prompts.md` | Five sample prompts, the acceptance checks and the last results |
| `scripts/try-provider.ts` | Manual check of a provider with real credentials |

### Provider contract

- A provider yields `text`, `edit`, `write`, `usage`, `done`. Errors and aborts throw (an abort throws an `AbortError`). A provider never drops an edit silently.
- API providers (`editsFiles: false`) only propose `edit`/`write`. The edit applier (#6) applies them.
- CLI backends (`editsFiles: true`) change the files in `GenerateRequest.cwd` themselves. Their `edit`/`write` events only report the change. **The edit applier must skip them.**

## 6. State and next steps

Done and closed: #1 CI, #13 app shell, #74 credentials and status, #60 Claude Code backend, #73 Codex backend, #4 system prompt v0, #5 context assembler, #6 edit applier, #7 generation endpoint.

Open only for a manual run with a real key (the user must set the key; do not read pi's credentials):
- #2 Anthropic: `ANTHROPIC_API_KEY=... bun scripts/try-provider.ts anthropic:claude-haiku-5-5`
- #3 OpenAI (PR #80 merged): `OPENAI_API_KEY=... bun scripts/try-provider.ts openai:<model>`
- #72 OpenCode Go: run one model of each format, for example `glm-5.3`, `claude-haiku-5-5`, `gpt-6-luna`. This also confirms the image-support assumption in `supportsVision()`.

Next, in this order (M1):

1. **#8 Chat history.** The endpoint streams SSE events: `text`, `edit`, `write`, `usage`, `retry`, `applied`, `done`, and `error` with `kind` (`context`, `apply`, `provider`). The chat panel must read this stream (it now ignores the body). Pass the history into `assembleContext()` in `src/server/turns.ts` (it sends `history: []` now). Also fix the task that was added from a review: keep messages for each design.
2. **#10 Live reload**, **#11 Git history**, **#12 Projects**, **#9 Image input.**

After M1: M2 (precision), M3 (design systems), M4 (handoff), M5 (breadth). #75 (Sign in with ChatGPT) waits for a client ID from OpenAI.

## 7. Known limits and decisions

- Codex loads the user's skills from `~/.codex/skills`; no flag turns them off. Its sandbox limits writes to the design folder but not reads.
- Claude Code: do not use `--bare`. It skips keychain reads, which the subscription login can need. The system text goes through `--append-system-prompt-file` (a 0600 file in a private temporary folder), because one argument is limited to about 128 KB.
- Provider status reports only "Logged in" for CLI backends. The plan and the login method are account details and stay out of the UI.
- Bun was not installed on this machine on 2026-10-12. It was installed with `npm i -g bun` (1.4.3).
- OpenAI reasoning models get the system parts as `developer` messages. This is SDK behavior. The Responses API stores responses by default (`store: true`); doi does not set `store: false` yet.
- `claude -p` loads the user's own Claude Code context. In a sample run it put the user's real name into a generated profile. Check if a flag can turn this off without `--bare` (see the Claude Code note above).
- `.gitignore` uses `/workspace` (root only). A bare `workspace` rule once hid `src/workspace/`.
