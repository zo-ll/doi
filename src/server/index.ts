import index from "../web/index.html";
import { loadConfig } from "../config.ts";
import { detectHarnesses } from "../harnesses/registry.ts";
import { getProvider } from "../providers/registry.ts";
import { providerStatus } from "../providers/status.ts";
import { designDir, ensureWorkspace, fileIn, listProjects } from "../workspace/paths.ts";
import { variantDir } from "../workspace/variants.ts";
import { designEvents, watchDesigns } from "../workspace/watch.ts";
import { commitPaths, commitTurn, designFileAt, designVersion, ensureRepo, isSha } from "../workspace/git.ts";
import { uploadFile } from "../workspace/uploads.ts";
import { deleteCommentRoute, getComments, patchComment, postComment } from "./comments.ts";
import { getHistory, restoreVersion } from "./history.ts";
import { getLayout, putLayout } from "./layout.ts";
import { createVariantHandlers } from "./variants.ts";
import { DesignLocks } from "./locks.ts";
import { patchDesign, patchProject, postDesign, postProject } from "./projects.ts";
import { createTurnHandler, getChat } from "./turns.ts";

const config = await loadConfig();
await ensureWorkspace(config.workspace);
// Without git, doi still works; only the version history is missing.
await ensureRepo(config.workspace).catch((e) => console.error("Version history is off:", e instanceof Error ? e.message : e));

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
const historyDeps = {
  workspace: config.workspace,
  locks,
  variantsOpen: variants.isOpen,
  commit: (paths: string[], message: string) => commitPaths(config.workspace, paths, message),
};
const runTurnRequest = createTurnHandler({
  config,
  locks,
  variantsOpen: variants.isOpen,
  getProvider,
  watcher,
  commit: (project, design, prompt) => commitTurn(config.workspace, project, design, prompt),
});

const BRIDGE_TAG = `<script src="/__doi/bridge.js"></script>`;
const bridge = Bun.file(new URL("../frame/bridge.js", import.meta.url).pathname);

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
  const noStore = { "cache-control": "no-store" };
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
  const keep = { "cache-control": "private, max-age=31536000, immutable" };
  if (!file.endsWith(".html")) return new Response(data, { headers: { "content-type": Bun.file(file).type, ...keep } });
  const html = new TextDecoder().decode(data).replace("</body>", `${BRIDGE_TAG}\n</body>`);
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", ...keep } });
}

/** /variant/<project>/<design>/<set>/<n>/<file> */
function serveVariant(url: URL): Promise<Response> | Response {
  const [, , project, design, set, n, ...rest] = url.pathname.split("/");
  if (!project || !design || !set || !n) return new Response("Not found", { status: 404 });
  return servePage(url, () => variantDir(config.workspace, project, design, set, Number(n)), rest);
}

const server = Bun.serve({
  port: config.port,
  hostname: "127.0.0.1",
  routes: {
    "/": index,
    "/api/health": () => Response.json({ ok: true }),
    "/api/config": () =>
      Response.json({ models: config.models, harness: config.harness, workspace: config.workspace }),
    "/api/harnesses": async () => Response.json(await detectHarnesses()),
    "/api/providers": async () => Response.json(await providerStatus(config)),
    "/api/events": (req, srv) => designEvents(watcher, req, srv),
    "/api/projects": {
      GET: async () => Response.json(await listProjects(config.workspace)),
      POST: (req) => postProject(projectDeps, req),
    },
    "/api/projects/:project": { PATCH: (req) => patchProject(projectDeps, req, req.params) },
    "/api/projects/:project/designs": { POST: (req) => postDesign(projectDeps, req, req.params) },
    "/api/projects/:project/designs/:design": { PATCH: (req) => patchDesign(projectDeps, req, req.params) },
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
        "/api/projects/:project/designs/:design/chat": (req) => getChat(config.workspace, req.params),
    "/api/projects/:project/designs/:design/variants": {
      GET: (req) => variants.get(req.params),
      POST: (req, srv) => variants.post(req, req.params, srv),
    },
    "/api/projects/:project/designs/:design/variants/:set/pick": { POST: (req) => variants.pick(req, req.params) },
    "/api/projects/:project/designs/:design/variants/:set": { DELETE: (req) => variants.discard(req.params) },
    "/api/projects/:project/designs/:design/history": (req) => getHistory(historyDeps, req.params),
    "/api/projects/:project/designs/:design/history/:sha/restore": { POST: (req) => restoreVersion(historyDeps, req.params) },
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
    "/api/projects/:project/designs/:design/turns": { POST: (req, srv) => runTurnRequest(req, req.params, srv) },
    "/__doi/bridge.js": () => new Response(bridge, { headers: { "content-type": "text/javascript" } }),
  },
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/design/")) return serveDesign(url);
    if (url.pathname.startsWith("/variant/")) return serveVariant(url);
    if (url.pathname.startsWith("/version/")) return serveVersion(url);
    return new Response("Not found", { status: 404 });
  },
  development: process.env.NODE_ENV !== "production" && { hmr: true, console: true },
});

console.log(`doi is running at ${server.url}`);
