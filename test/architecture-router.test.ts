import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseConfig } from "../src/config.ts";
import { startServer } from "../src/server/app.ts";

test("diagram routes run through the normal host and origin guard", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "doi-uml-http-"));
  const app = await startServer(parseConfig({ workspace }), { port: 0, development: false });
  const url = `http://127.0.0.1:${app.server.port}/api/projects/sample/architecture`;
  try {
    const response = await fetch(url);
    expect(response.status).toBe(200);
    const initial = await response.json();
    expect(initial.state.enabled).toBe(false);
    expect(await Bun.file(join(workspace, "projects/sample/architecture.json")).exists()).toBe(false);
    const body = JSON.stringify({ ...initial, state: { ...initial.state, enabled: true } });
    const put = (origin?: string) => fetch(url, { method: "PUT", headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body });
    expect((await put("https://evil.example")).status).toBe(403);
    expect((await put()).status).toBe(200);
    expect((await put()).status).toBe(409);
  } finally { app.stop(); await rm(workspace, { recursive: true, force: true }); }
});
