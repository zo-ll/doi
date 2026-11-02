import index from "../web/index.html";
// Text import: the compiled binary has no source folder to read the bridge from.
import bridgeSource from "../frame/bridge.js" with { type: "text" };
import type { Config } from "../config.ts";
import { join } from "node:path";
import { getProvider } from "../providers/registry.ts";
import { providerStatus } from "../providers/status.ts";
import { designDir, designPages, ensureWorkspace, fileIn, listProjects } from "../workspace/paths.ts";
import { variantDir } from "../workspace/variants.ts";
import { designSystemDir, listDesignSystems, loadDesignSystem, previewPage } from "../workspace/design-systems.ts";
import { designEvents, watchDesigns } from "../workspace/watch.ts";
import { commitPaths, commitStats, commitTurn, designFileAt, designVersion, ensureRepo, isSha, workspaceChanges } from "../workspace/git.ts";
import { uploadFile } from "../workspace/uploads.ts";
import { deleteCommentRoute, getComments, patchComment, postComment } from "./comments.ts";
import { getDesignSystem, importFromRepo, importFromScreenshots, putProjectDesignSystem } from "./design-systems.ts";
import { getExport } from "./export.ts";
import { getHandoff, getPrompt, postBundle } from "./handoff.ts";
import { configView, deleteProviderKey, getProviderModels, getUsage, postProviderLogin, putModels, putProviderKey } from "./settings.ts";
import { getTweaks, putTweaks } from "./tweaks.ts";
import { getSpacing, postEdit, undoEdit } from "./element-edit.ts";
import { MAX_IMPORT_BYTES, postExport, postImport, postImportInspect } from "./archive.ts";
import { deleteProjectRepo, getGithubRepos, getGithubStatus, putProjectRepo, syncProjectRepo } from "./github.ts";
import { excludeClones } from "../github/gh.ts";
import { handleMcp, MCP_PATH } from "../mcp/server.ts";
import { getHistory, reopenVariants, restoreVersion } from "./history.ts";
import { getLayout, putLayout } from "./layout.ts";
import { createVariantHandlers } from "./variants.ts";
import { DesignLocks } from "./locks.ts";
import { checkRequest, HOSTNAME, PAGE_HEADERS } from "./security.ts";
import { deleteProject, patchDesign, patchProject, postDesign, postProject, postScreen, putDesignKind } from "./projects.ts";
import { createTurnHandler, getChat } from "./turns.ts";

const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
type AnyHandler = (req: Request, server: Bun.Server<unknown>) => Response | Promise<Response>;

/**
 * Runs `checkRequest` before every route handler. Static routes (the app page) stay as they
 * are. The type is Bun's own, so each handler still gets its typed `req.params`.
 */
function guardRoutes<R extends string>(routes: Bun.Serve.Routes<unknown, R>): Bun.Serve.Routes<unknown, R> {
  const wrap = (h: AnyHandler): AnyHandler => (req, srv) => checkRequest(req, srv.port!) ?? h(req, srv);
  const out: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(routes) as [string, unknown][]) {
    if (typeof value === "function") out[path] = wrap(value as AnyHandler);
    else if (value && typeof value === "object" && !(value instanceof Response) && Object.keys(value).length && Object.keys(value).every((k) => METHODS.has(k))) {
      out[path] = Object.fromEntries(
        Object.entries(value).map(([m, h]) => [m, typeof h === "function" ? wrap(h as AnyHandler) : h]),
      );
    } else out[path] = value;
  }
  return out as Bun.Serve.Routes<unknown, R>;
}

/**
 * Starts doi: the workspace, the watcher and the HTTP server on 127.0.0.1. `port: 0` picks a
 * free port (tests).
 */
export async function startServer(config: Config, options: { port?: number; development?: boolean } = {}) {
  await ensureWorkspace(config.workspace);
  // Without git, doi still works; only the version history is missing.
  await ensureRepo(config.workspace).catch((e) => console.error("Version history is off:", e instanceof Error ? e.message : e));
  // Clones of linked repos live in the workspace, outside its history.
  await excludeClones(config.workspace).catch(() => {});

  const watcher = watchDesigns(config.workspace);
  const locks = new DesignLocks();
  const commentDeps = {
    workspace: config.workspace,
    version: (project: string, design: string) => designVersion(config.workspace, project, design),
  };
  const projectDeps = {
    workspace: config.workspace,
    locks,
    commit: (paths: string[], message: string) => commitPaths(config.workspace, paths, message),
  };
  const variants = createVariantHandlers({
    config,
    locks,
    getProvider,
    commit: (paths, message) => commitPaths(config.workspace, paths, message),
  });
  const importDeps = {
    config,
    locks,
    getProvider,
    commit: (paths: string[], message: string) => commitPaths(config.workspace, paths, message),
  };
  const historyDeps = {
    workspace: config.workspace,
    locks,
    variantsOpen: variants.isOpen,
    commit: (paths: string[], message: string) => commitPaths(config.workspace, paths, message),
  };
  const githubDeps = { workspace: config.workspace, locks, commit: (paths: string[], message: string) => commitPaths(config.workspace, paths, message) };
  const tweakDeps = { workspace: config.workspace, locks, commit: (paths: string[], message: string) => commitPaths(config.workspace, paths, message) };
  const editDeps = { ...tweakDeps, variantsOpen: variants.isOpen };
  const chatStats = (project: string, design: string, shas: string[]) => commitStats(config.workspace, project, design, shas);
  const runTurnRequest = createTurnHandler({
    config,
    locks,
    variantsOpen: variants.isOpen,
    getProvider,
    watcher,
    commit: (project, design, prompt) => commitTurn(config.workspace, project, design, prompt),
    stats: chatStats,
  });

  const BRIDGE_TAG = `<script src="/__doi/bridge.js"></script>`;
  // TypeScript types the text import of a .js file as the module; Bun gives its text.
  const bridge = bridgeSource as unknown as string;

  /** Serves a file of a page folder. Injects the bridge script into HTML pages. */
  async function servePage(url: URL, dir: () => string, rest: string[]): Promise<Response> {
    if (rest.length === 0) return Response.redirect(`${url.pathname}/`, 301);
    // Hidden files (comments) are app data, not part of the page.
    if (rest.some((part) => part.startsWith("."))) return new Response("Not found", { status: 404 });

    let path: string | null;
    try {
      path = fileIn(dir(), rest.join("/") || "index.html");
    } catch {
      return new Response("Bad request", { status: 400 });
    }
    if (!path) return new Response("Forbidden", { status: 403 });

    const file = Bun.file(path);
    if (!(await file.exists())) return new Response("Not found", { status: 404 });
    // Turns change these files in place, so the browser must not reuse an old copy.
    const noStore = { "cache-control": "no-store", ...PAGE_HEADERS };
    if (!path.endsWith(".html")) return new Response(file, { headers: noStore });

    const html = (await file.text()).replace("</body>", `${BRIDGE_TAG}\n</body>`);
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", ...noStore } });
  }

  /** /design/<project>/<design>/<file> */
  function serveDesign(url: URL): Promise<Response> | Response {
    const [, , project, design, ...rest] = url.pathname.split("/");
    if (!project || !design) return new Response("Not found", { status: 404 });
    return servePage(url, () => designDir(config.workspace, project, design), rest);
  }

  /** /version/<project>/<design>/<sha>/<file>: a design as it was at a commit, read from git. */
  async function serveVersion(url: URL): Promise<Response> {
    const [, , project, design, sha, ...rest] = url.pathname.split("/");
    if (!project || !design || !sha) return new Response("Not found", { status: 404 });
    if (rest.length === 0) return Response.redirect(`${url.pathname}/`, 301);
    if (rest.some((part) => part.startsWith("."))) return new Response("Not found", { status: 404 });
    if (!isSha(sha)) return new Response("Bad request", { status: 400 });
    const file = rest.join("/") || "index.html";
    let data: Uint8Array<ArrayBuffer> | null;
    try {
      data = await designFileAt(config.workspace, project, design, sha, file);
    } catch {
      return new Response("Bad request", { status: 400 });
    }
    if (!data) return new Response("Not found", { status: 404 });
    // A commit never changes, so its files can be kept.
    const keep = { "cache-control": "private, max-age=31536000, immutable", ...PAGE_HEADERS };
    if (!file.endsWith(".html")) return new Response(data, { headers: { "content-type": Bun.file(file).type, ...keep } });
    const html = new TextDecoder().decode(data).replace("</body>", `${BRIDGE_TAG}\n</body>`);
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", ...keep } });
  }

  /** /ds/<name>/<file>: design system files that pages link (tokens, fonts). */
  function serveDesignSystem(url: URL): Promise<Response> | Response {
    const [, , name, ...rest] = url.pathname.split("/");
    if (!name) return new Response("Not found", { status: 404 });
    // The components on one page with the design system's stylesheets, for the UI.
    if (rest.join("/") === "preview.html") {
      return (async () => {
        let ds;
        try {
          ds = await loadDesignSystem(config.workspace, name);
        } catch {
          return new Response("Bad request", { status: 400 });
        }
        if (!ds) return new Response("Not found", { status: 404 });
        return new Response(previewPage(ds), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...PAGE_HEADERS } });
      })();
    }
    // Without a components.css file, the <style> blocks of components.html are the components' CSS.
    if (rest.join("/") === "components.css") {
      return (async () => {
        let ds;
        try {
          ds = await loadDesignSystem(config.workspace, name);
        } catch {
          return new Response("Bad request", { status: 400 });
        }
        if (!ds?.componentStyles) return new Response("Not found", { status: 404 });
        return new Response(ds.componentStyles, { headers: { "content-type": "text/css; charset=utf-8", "cache-control": "no-store", ...PAGE_HEADERS } });
      })();
    }
    return servePage(url, () => designSystemDir(config.workspace, name), rest);
  }

  /** /variant/<project>/<design>/<set>/<n>/<file> */
  function serveVariant(url: URL): Promise<Response> | Response {
    const [, , project, design, set, n, ...rest] = url.pathname.split("/");
    if (!project || !design || !set || !n) return new Response("Not found", { status: 404 });
    return servePage(url, () => variantDir(config.workspace, project, design, set, Number(n)), rest);
  }

  const server: Bun.Server<unknown> = Bun.serve({
    port: options.port ?? config.port,
    hostname: HOSTNAME,
    maxRequestBodySize: MAX_IMPORT_BYTES,
    routes: guardRoutes({
      "/": index,
      "/api/health": () => Response.json({ ok: true }),
      "/api/config": () => Response.json(configView(config)),
      "/api/config/models": { PUT: (req) => putModels(config, req) },
      "/api/usage": () => getUsage(config),
      "/api/export": { POST: (req) => postExport({ config, locks }, req) },
      "/api/import/inspect": { POST: (req) => postImportInspect({ config, locks }, req) },
      "/api/import": { POST: (req) => postImport({ config, locks }, req) },
      "/api/github/status": () => getGithubStatus(githubDeps),
      "/api/github/repos": () => getGithubRepos(githubDeps),
      "/api/projects/:project/repo": {
        PUT: (req, srv) => putProjectRepo(githubDeps, req, req.params, srv),
        DELETE: (req) => deleteProjectRepo(githubDeps, req.params),
      },
      "/api/projects/:project/repo/sync": { POST: (req, srv) => syncProjectRepo(githubDeps, req, req.params, srv) },
      "/api/providers": async () => Response.json(await providerStatus(config)),
      "/api/providers/:id/key": {
        PUT: (req) => putProviderKey(req, req.params),
        DELETE: (req) => deleteProviderKey(req.params),
      },
      "/api/providers/:id/login": { POST: (req) => postProviderLogin(req.params) },
      "/api/providers/:id/models": (req) => getProviderModels(config, req.params),
      // The workspace path and its git state, for the projects navigator. `changes` is null without git.
      "/api/workspace": async () => Response.json({ path: config.workspace, changes: await workspaceChanges(config.workspace) }),
      "/api/events": (req, srv) => designEvents(watcher, req, srv),
      "/api/design-systems": async () => Response.json(await listDesignSystems(config.workspace)),
      "/api/design-systems/import": { POST: (req, srv) => importFromRepo(importDeps, req, srv) },
      "/api/design-systems/import-screenshots": { POST: (req, srv) => importFromScreenshots(importDeps, req, srv) },
      "/api/design-systems/:name": (req) => getDesignSystem(config.workspace, req.params.name),
      "/api/projects/:project/design-system": { PUT: (req) => putProjectDesignSystem(importDeps, req, req.params) },
      "/api/projects": {
        GET: async () => Response.json(await listProjects(config.workspace)),
        POST: (req) => postProject(projectDeps, req),
      },
      "/api/projects/:project": {
        PATCH: (req) => patchProject(projectDeps, req, req.params),
        DELETE: (req) => deleteProject(projectDeps, req.params),
      },
      "/api/projects/:project/designs": { POST: (req) => postDesign(projectDeps, req, req.params) },
      "/api/projects/:project/designs/:design": { PATCH: (req) => patchDesign(projectDeps, req, req.params) },
      "/api/projects/:project/designs/:design/kind": { PUT: (req) => putDesignKind(projectDeps, req, req.params) },
      "/api/projects/:project/designs/:design/screens": { POST: (req) => postScreen(projectDeps, req, req.params) },
      "/api/projects/:project/uploads/:file": async (req) => {
        let path: string | null;
        try {
          path = uploadFile(config.workspace, req.params.project, req.params.file);
        } catch {
          return new Response("Bad request", { status: 400 });
        }
        const file = path ? Bun.file(path) : null;
        if (!file || !(await file.exists())) return new Response("Not found", { status: 404 });
        return new Response(file, { headers: { "cache-control": "private, max-age=31536000, immutable" } });
      },
          "/api/projects/:project/designs/:design/tweaks": {
        GET: (req) => getTweaks(config.workspace, req.params),
        PUT: (req) => putTweaks(tweakDeps, req, req.params),
      },
      "/api/projects/:project/designs/:design/spacing": (req) => getSpacing(config.workspace, req.params),
      "/api/projects/:project/designs/:design/edit": { POST: (req) => postEdit(editDeps, req, req.params) },
      "/api/projects/:project/designs/:design/edit/undo": { POST: (req) => undoEdit(editDeps, req, req.params) },
      "/api/projects/:project/designs/:design/pages": async (req) => {
        try {
          const { project, design } = req.params;
          if (!(await Bun.file(join(designDir(config.workspace, project, design), "index.html")).exists())) {
            return Response.json({ error: "Design not found." }, { status: 404 });
          }
          return Response.json(await designPages(config.workspace, project, design));
        } catch (e) {
          return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
        }
      },
      "/api/projects/:project/designs/:design/chat": (req) => getChat(config.workspace, req.params, chatStats),
      "/api/projects/:project/designs/:design/variants": {
        GET: (req) => variants.get(req.params),
        POST: (req, srv) => variants.post(req, req.params, srv),
      },
      "/api/projects/:project/designs/:design/variants/:set/pick": { POST: (req) => variants.pick(req, req.params) },
      "/api/projects/:project/designs/:design/variants/:set": { DELETE: (req) => variants.discard(req.params) },
      "/api/projects/:project/designs/:design/export": (req) => getExport(config.workspace, req, req.params),
      "/api/projects/:project/designs/:design/handoff": { GET: (req) => getHandoff(config.workspace, req.params) },
      "/api/projects/:project/designs/:design/handoff/prompt": (req, srv) =>
        getPrompt(config.workspace, req.params, `http://${HOSTNAME}:${srv.port}${MCP_PATH}`),
      "/api/projects/:project/designs/:design/handoff/bundle": { POST: (req) => postBundle(config.workspace, req, req.params) },
      "/api/projects/:project/designs/:design/history": (req) => getHistory(historyDeps, req.params),
      "/api/projects/:project/designs/:design/history/:sha/restore": { POST: (req) => restoreVersion(historyDeps, req.params) },
      "/api/projects/:project/designs/:design/history/:sha/reopen-variants": { POST: (req) => reopenVariants(historyDeps, req.params) },
      "/api/projects/:project/designs/:design/layout": {
        GET: (req) => getLayout(config.workspace, req.params),
        PUT: (req) => putLayout(config.workspace, req, req.params),
      },
      "/api/projects/:project/designs/:design/comments": {
        GET: (req) => getComments(commentDeps, req.params),
        POST: (req) => postComment(commentDeps, req, req.params),
      },
      "/api/projects/:project/designs/:design/comments/:id": {
        PATCH: (req) => patchComment(commentDeps, req, req.params),
        DELETE: (req) => deleteCommentRoute(commentDeps, req.params),
      },
      "/api/projects/:project/designs/:design/turns": {
        POST: (req, srv) => runTurnRequest(req, req.params, srv),
        DELETE: (req) => runTurnRequest.stop(req.params),
      },
      // Stateless: no server-sent stream (GET) and no session to end (DELETE), so only POST.
      [MCP_PATH]: {
        POST: (req) => handleMcp({ workspace: config.workspace }, req),
        GET: () => new Response("Method not allowed", { status: 405, headers: { allow: "POST" } }),
        DELETE: () => new Response("Method not allowed", { status: 405, headers: { allow: "POST" } }),
      },
      "/__doi/bridge.js": () => new Response(bridge, { headers: { "content-type": "text/javascript" } }),
    }),
    fetch(req, srv) {
      const refused = checkRequest(req, srv.port!);
      if (refused) return refused;
      const url = new URL(req.url);
      if (url.pathname.startsWith("/design/")) return serveDesign(url);
      if (url.pathname.startsWith("/variant/")) return serveVariant(url);
      if (url.pathname.startsWith("/ds/")) return serveDesignSystem(url);
      if (url.pathname.startsWith("/version/")) return serveVersion(url);
      return new Response("Not found", { status: 404 });
    },
    development: (options.development ?? process.env.NODE_ENV !== "production") && { hmr: true, console: true },
  });

  return {
    server,
    workspace: config.workspace,
    stop() {
      watcher.close();
      server.stop(true);
    },
  };
}
