import index from "../web/index.html";
import { loadConfig } from "../config.ts";
import { detectHarnesses } from "../harnesses/registry.ts";
import { designFile, ensureWorkspace } from "../workspace/paths.ts";

const config = await loadConfig();
await ensureWorkspace(config.workspace);

const BRIDGE_TAG = `<script src="/__doi/bridge.js"></script>`;
const bridge = Bun.file(new URL("../frame/bridge.js", import.meta.url).pathname);

/** Serves /design/<project>/<design>/<file>. Injects the bridge script into HTML pages. */
async function serveDesign(url: URL): Promise<Response> {
  const [, , project, design, ...rest] = url.pathname.split("/");
  if (!project || !design) return new Response("Not found", { status: 404 });
  if (rest.length === 0) return Response.redirect(`${url.pathname}/`, 301);

  let path: string | null;
  try {
    path = designFile(config.workspace, project, design, rest.join("/") || "index.html");
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  if (!path) return new Response("Forbidden", { status: 403 });

  const file = Bun.file(path);
  if (!(await file.exists())) return new Response("Not found", { status: 404 });
  if (!path.endsWith(".html")) return new Response(file);

  const html = (await file.text()).replace("</body>", `${BRIDGE_TAG}\n</body>`);
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
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
    "/__doi/bridge.js": () => new Response(bridge, { headers: { "content-type": "text/javascript" } }),
  },
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/design/")) return serveDesign(url);
    return new Response("Not found", { status: 404 });
  },
  development: process.env.NODE_ENV !== "production" && { hmr: true, console: true },
});

console.log(`doi is running at ${server.url}`);
