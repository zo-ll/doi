# Agent handoff

This file is for the next coding agent on doi. Read it before you start an issue. Update it when you stop.

Last update: 2026-10-13, after #46 HTML export. Tests: 256 pass. M1, M2 and M3 are done. `bun check`: no errors.

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
| `src/server/index.ts`, `src/server/app.ts` | `index.ts` loads the config and calls `startServer(config, { port?, development? })` (`app.ts`): workspace, git, watcher and `Bun.serve` on 127.0.0.1 with all routes; `port: 0` in tests. Returns `{ server, stop }` |
| `src/server/security.ts` | `checkRequest()` runs before every route (through `guardRoutes()`) and in `fetch`: the Host must be `127.0.0.1:<port>` or `localhost:<port>` (DNS rebinding); a request that changes data must have no `Origin` or the app's own, and a body must be `application/json` (no cross-site or sandboxed-page requests). `PAGE_CSP` and `nosniff` on every design, variant and version file |
| `src/config.ts` | `config.toml` loading, provider ids, `keyEnvFor()` |
| `src/workspace/paths.ts` | Safe design paths, `listProjects()`, sample workspace |
| `src/frame/bridge.js` | Script in each design iframe. Sends `doi:ready`, `doi:select` (Shift-click = parent), `doi:clear` (Escape), and `doi:rects` (selected and hover boxes, on each animation frame while one is shown, only when they changed). Gets `doi:track { oid }` |
| `src/workspace/comments.ts`, `src/server/comments.ts` | Comments per design in `<design>/.comments.json` (id, oid, text, status, version = last commit of the design). GET adds `detached` from the current HTML. One write at a time per file (`file-lock.ts`); a write does not create folders, so a renamed design gives 404 |
| `src/web/comments.ts`, `src/web/components/CommentsPanel.tsx` | `useComments()` (loads again on each design change), `pinsOf()`, the Comments tab. Pins come from the bridge (`doi:track { pins }`, `doi:rects { pins }`) |
| `src/generation/touched.ts` | `touchedOids()`: which elements a turn changed (own HTML, or a changed CSS rule that names a class, the id or the `data-oid`). A comment of the turn is done when its element changed |
| `src/workspace/frames.ts`, `src/workspace/layout.ts`, `src/server/layout.ts` | Frames of a design (`id, label, width, height, x, y`), presets, limits, `parseLayout()`. Stored in `project.json` under `layouts.<design>`; every write of `project.json` goes through `updateProjectMeta()` (one at a time, replaced whole). `GET/PUT …/designs/:design/layout`. A design rename moves its layout |
| `src/web/viewport.ts` | Camera math: `zoomAt()` (keeps the point under the pointer), `stepZoom()`, `wheelFactor()`, `fitView()`, `nextPosition()`, `arrangeRow()` |
| `src/workspace/variants.ts`, `src/server/variants.ts`, `src/web/variants.ts` | Variants: `projects/<p>/variants/<design>/<set>/<n>/` (copies of the design without hidden files) and `set.json` (prompt, per-variant provider, model, status, text, usage, files). `POST …/variants { text, target?, count 2–4, models? }` streams `variants`, `variant { n, event }`, `variants-done`; the set is committed. `POST …/variants/:set/pick { n }` copies the variant into the design, writes the chat lines (with `variant: n`) and removes the set (commit). `DELETE …/variants/:set` discards (commit). Files are served at `/variant/<p>/<d>/<set>/<n>/` with the bridge |
| `src/workspace/history.ts`, `src/server/history.ts`, `src/web/history.ts`, `HistoryPanel.tsx` | Version history: `designLog()` (git log of the design folder), `designFilesAt()`/`designFileAt()` (from git), `restoreDesign()` (page files as at a commit, comments stay; the caller commits). `GET …/history` adds the model from the chat's commit lines. `POST …/history/:sha/restore` accepts only commits in the design's log. Old pages are served at `/version/<p>/<d>/<sha>/` with the bridge |
| `src/workspace/design-systems.ts`, `src/generation/ds-link.ts` | Design systems in `design-systems/<name>/`: `tokens.css`, `components.html` (+ optional `components.css`, else its `<style>` blocks), `rules.md`, `fonts/`, `screenshots/`; all optional. `project.json` → `designSystem`. `formatDesignSystem()` goes into the stable system part (after the system prompt). Files are served at `/ds/<name>/…` (with `PAGE_CSP`); `/ds/<name>/components.css` falls back to the styles of components.html. After each turn and variant, `linkDesignSystem()` makes every HTML page link tokens.css and components.css before its own first stylesheet |
| `src/generation/repo-scan.ts`, `src/server/design-systems.ts`, `src/generation/prompts/extract-v0.md` | Import from a repo: `scanRepo()` picks Tailwind/theme/token configs, stylesheets with the most tokens and main components (git repos: `git ls-files --cached --others --exclude-standard`, read only; else a walk), skips build and dot folders, links and secret-looking files; 12k per file, 100k total. `POST /api/design-systems/import { name, repo }` streams `sources`, the turn events, then `imported` or `error`. `streamExtraction()` runs the extract model with `EXTRACT_PROMPT` into a hidden `design-systems/.import-*` folder, keeps only tokens.css, components.css, components.html and rules.md, needs tokens.css, renames to `design-systems/<name>/` and commits. `extractProvider()` and `claim()` are shared with the screenshots import: `POST /api/design-systems/import-screenshots { name, images, notes? }` (1–5 images, parsed by `server/image-body.ts` like turn images; the extract model needs vision) keeps the images in `screenshots/` (written after the model ran) |
| `src/web/components/DesignSystemDialog.tsx` | Design system UI (top bar button): list, "Use for <project>" / "Stop using" (`PUT /api/projects/:project/design-system`, commits project.json), details from `GET /api/design-systems/:name` (tokens grouped by `parseTokens()` with `var()` resolved: colors, type, spacing, radius, shadows), the components at `/ds/<name>/preview.html`, rules, files with editor links (`editor_url` in config.toml, default `vscode://file{path}`), and both import forms with streamed progress |
| `src/export/html.ts`, `src/export/zip.ts`, `src/server/export.ts`, `src/web/export.ts`, `ExportDialog.tsx` | HTML export (#46). `exportFolder()`: the design's files (no hidden files) and every design system file they link, at `design-system/<name>/` (with the fonts from tokens.css; components.css falls back to components.html's styles); `/ds/` links become relative. `exportPage()`: one page with stylesheets (and `@import`s) in `<style>`, scripts inline (`</script` escaped), images, fonts and media as `data:` URLs; other sites stay links. Both report missing files and, with `stripOids`, a warning when CSS or scripts use `data-oid`. `GET …/export?format=folder\|page&oids=keep\|strip&page=` gives a ZIP (`<design>/…`, own writer, deflate) or an HTML download; the report is in `x-doi-export-report` (URI-encoded JSON). Top bar → Export |
| `src/web/frame.ts` | `parseFrameMessage()`: checks each bridge message (the page runs its own scripts); `trackMessage()` |
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
| `src/generation/oids.ts` | `fixOids()`: after each turn, adds missing `data-oid`s, restores dropped ones (same tag, text and key attributes), and makes them unique in the design. Uses `HTMLRewriter`, so only changed start tags are written again |
| `src/generation/apply.ts` | `applyChanges()` (all or none, rollback) and `runTurn()` (retry once, then full rewrite; skips `editsFiles` providers) |
| `src/server/turns.ts` | `GET .../chat` and `POST .../turns`: one turn per design (409 while one runs), SSE events, abort on disconnect. `target` set → `models.edit`, else `models.generate` |
| `src/workspace/chat.ts` | `projects/<project>/chat.jsonl`: one line per message, with `design`, `turn`, status, provider, model, usage, files, prompt version. `historyMessages()` keeps only completed turns |
| `src/workspace/watch.ts` | `fs.watch` on `projects/`, 100 ms debounce per design, `hold`/`release` while a turn runs; `GET /api/events` streams `design-changed` |
| `src/workspace/git.ts` | `ensureRepo()` on startup; `commitTurn()` after a completed turn that changed files: only that design folder and `chat.jsonl`, the user's own identity, one git command at a time |
| `src/workspace/projects.ts`, `src/server/projects.ts` | Create and rename projects (display name in `project.json`) and designs (folder move + `chat.jsonl` rewrite). Each change is committed. A design rename takes the same lock as a turn (`src/server/locks.ts`) |
| `src/workspace/uploads.ts`, `image-limits.ts`, `src/web/images.ts` | Images: the browser scales to 1568 px / 3.75 MB (`IMAGE_LIMITS`), the server checks type, count and size and saves them in `projects/<p>/uploads/`; `GET .../uploads/:file` serves them |
| `src/web/chat.ts` | Chat panel logic without React: SSE reader, stream event → answer, stored entries → messages |
| `test/fixtures/prompts.md` | Five sample prompts, the acceptance checks and the last results |
| `scripts/try-provider.ts` | Manual check of a provider with real credentials |

### Provider contract

- A provider yields `text`, `edit`, `write`, `usage`, `done`. Errors and aborts throw (an abort throws an `AbortError`). A provider never drops an edit silently.
- API providers (`editsFiles: false`) only propose `edit`/`write`. The edit applier (#6) applies them.
- CLI backends (`editsFiles: true`) change the files in `GenerateRequest.cwd` themselves. Their `edit`/`write` events only report the change. **The edit applier must skip them.**

## 6. State and next steps

Done and closed: #1 CI, #13 app shell, #74 credentials and status, #60 Claude Code backend, #73 Codex backend, #4 system prompt v0, #5 context assembler, #6 edit applier, #7 generation endpoint, #8 chat history, #10 live reload, #11 git history, #12 projects, #9 image input.

M1 is complete. The user chose to start M2 before the M1 gate (one real design), so the gate is still open.

M2 is complete: #14 data-oid post-processing, #15 selection, #16 comments, #17 targeted edits, #18 canvas, #19 variants, #20 version history, #41 sandbox hardening.

M3 is complete: #42 design system format and loader, #43 import from a repo, #44 import from screenshots, #45 design system UI.

**Subscriptions only.** The user has no Anthropic or OpenAI API keys and will not get them. doi runs on the CLI backends: `claude-code:<model>` (Claude subscription through `claude -p`) and `codex:<model>` (ChatGPT plan through `codex exec`). Do not ask for API keys. #2 (Anthropic adapter) and #3 (OpenAI adapter) were closed on 2026-10-13 as built and unit-tested, but not tested live. Test real runs with `claude-code:claude-haiku-5-5`. Since 2026-10-13 the default models in `src/config.ts` and `config.example.toml` are CLI backends (`claude-code:claude-opus-5-5`, `claude-code:claude-sonnet-5-5`, `claude-code:claude-haiku-5-5`), so doi works without a `config.toml`. The extract model needs vision for the screenshot import.

Still open for a manual run: #72 OpenCode Go, only if the user has an OpenCode Go key. Run one model of each format, for example `glm-5.3`, `claude-haiku-5-5`, `gpt-6-luna`. This also confirms the image-support assumption in `supportsVision()`.

Next, in this order:

1. M4 (handoff): the M4 milestone issues on GitHub. #46 HTML export is done; next is #47 PNG and PDF export with Playwright. The user said to continue with M4. Every export and the handoff bundle (#49) must copy or inline the `/ds/<name>/` files that pages link: reuse `exportFolder()`/`exportPage()` from `src/export/html.ts`.
2. Still open for the user: the M1 gate (one real design), and #72 if they have an OpenCode Go key.

After M1: M2 (precision), M3 (design systems), M4 (handoff), M5 (breadth). #75 (Sign in with ChatGPT) waits for a client ID from OpenAI.

## 7. Known limits and decisions

- Codex loads the user's skills from `~/.codex/skills`; no flag turns them off. Its sandbox limits writes to the design folder but not reads.
- Claude Code: do not use `--bare`. It skips keychain reads, which the subscription login can need. The system text goes through `--append-system-prompt-file` (a 0600 file in a private temporary folder), because one argument is limited to about 128 KB.
- Provider status reports only "Logged in" for CLI backends. The plan and the login method are account details and stay out of the UI.
- Bun was not installed on this machine on 2026-10-12. It was installed with `npm i -g bun` (1.4.3).
- OpenAI reasoning models get the system parts as `developer` messages. This is SDK behavior. The Responses API stores responses by default (`store: true`); doi does not set `store: false` yet.
- `claude -p` loads the user's own Claude Code context. In a sample run it put the user's real name into a generated profile. Check if a flag can turn this off without `--bare` (see the Claude Code note above).
- The chat panel is keyed by the design in `App.tsx`. A design switch unmounts it and aborts its run, so no message of the old design can reach the new one.
- A stopped CLI-backend turn can leave changed files, but it is stored with `files: []` and is not in the history.
- Answers show Markdown as plain text.
- Screenshot import: a real run (`claude-code:claude-haiku-5-5`, one 900 × 600 screenshot, 49 s, 26k in, 12k out) read the primary color exactly and the serif font; it estimated the radius (10–12 px for 14 px) and marked estimates in tokens.css.
- Import: the repo is only read by doi. The model gets the sources as text and works in the staging folder (`cwd`); API models are kept inside it by the applier, Claude Code (`acceptEdits`) and Codex (`workspace-write`) write only in `cwd`. A real import of the doi repo with `claude-code:claude-haiku-5-5` took 77 s (49k in, 21k out) and gave tokens with doi's real values, components.css with only `var(...)`, and 15 rules.
- Design systems: pages link `/ds/<name>/tokens.css` and `/ds/<name>/components.css` by absolute URL, so a change to the design system reaches every design without a turn (the frames reload only on the next design change; the watcher does not watch `design-systems/`). An export or handoff (M4) must copy or inline these files. Checked with a real model: without components.css the model used the component class but the page had no component styles, so components.css is now linked too.
- Design pages: `PAGE_CSP` allows the page's own files from the doi server, inline scripts and styles, Google Fonts (`fonts.googleapis.com`, `fonts.gstatic.com`), and `data:`/`blob:` images and media. `connect-src`, `frame-src`, `worker-src`, `object-src`, `form-action` and `base-uri` are `'none'`: a page cannot fetch, not even from the doi server. A design that needs another font host or images from the web is blocked; extend `PAGE_CSP` on purpose, not with a wildcard. Checked in Chromium with a hostile page (fetch to the API, fetch and image from other sites, a form post: all blocked).
- Version history: git does not know the model, so each turn and each variant pick appends `{"role":"commit", turn, design, sha}` to `chat.jsonl` after its commit (`readChat` skips it). This line is written after the commit, so `chat.jsonl` stays changed until the next commit takes it along. Commits from before this change show no model. A design that was renamed shows its history from the rename on. A restore is a new commit "Restore <sha7>: <message>", never a reset.
- Variants: one open set per design. While it is open, a turn or a new set on the design gets 409 (the composer says why). A pick replaces the design's page files (comments stay). All variants stay in the history through the "Variants: …" commit. A model name for a variant must not start with "-" (it goes to a CLI as an argument). Variants take no images and no comments yet. A design rename moves its variants.
- Canvas: the world element holds the frames at real size; the camera is its CSS transform. Wheel pans, Ctrl/⌘ + wheel or a pinch zooms at the pointer; drag on the background, middle button or Space + drag pans; `=`/`-`/`0`/Shift+1/arrows. Over a frame, a plain wheel scrolls the page; the bridge forwards only a pinch (`doi:wheel`) and the canvas keys (`doi:key`). A layout change makes no commit; the next commit of `project.json` (a rename) takes it along. The camera itself is not stored; a design opens fitted.
- Targeted edits: a turn body can carry `comments` (ids). The server checks that each is open and its element exists, then the user message lists them ("Apply these comments … 1. data-oid=…"). A selection adds "Change only this element and the CSS rules for it, with small edits." Only the comments sent with a turn can become done; a rule on a tag name only (`button {}`) does not count as a change of the element.
- Comments are hidden files (`.comments.json`): `readDesignFiles` skips them, the watcher does not reload frames for them, and the design server returns 404 for dot files. They move with a design rename and go into the next turn commit. A CLI backend (`cwd` = design folder) can still read the file.
- Selection: the app keeps only the selected `oid`. Each frame finds the element itself and draws it in its own layout; an element hidden in a frame draws nothing there. The selection is still cleared when the design files change (a turn).
- Playwright cannot click into the scaled design iframes with locators (it reports that other elements get the click). Move the mouse to computed screen points instead: iframe box + element rect × zoom.
- data-oid post-processing: an id the model changed on purpose stays changed (comments on the old id lose their element). New ids are `<tag>-<first three words>`, with `-2`, `-3` for repeats. Elements inside `svg` and `template` get no id.
- A design rename can race with the watcher event of the old path; the frames may show a 404 for a moment before they load the new name.
- The last open design is in `localStorage` (`doi:last-design`).
- Old images are not sent again in the history (about 1600 tokens each per turn); the history says "(N images attached to this message.)".
- Bun's `toMatchObject` with `expect.stringMatching` inside an array changed the received object in a test. Read values before such a match.
- HTML export: a design with its own top-level `design-system/` folder gets 409 (the export path of the design system files). The single file exports one page (index.html by default; the API takes `page`, the UI does not offer it yet). A `<script type="module">` that imports other local files is inlined without them. An `<a href>` or `<iframe>` to another page stays a relative link and does not work in the single file (a warning says so). The export reads the files as they are on disk; a turn that runs at the same time can give a mixed state.
- `.gitignore` uses `/workspace` (root only). A bare `workspace` rule once hid `src/workspace/`.
