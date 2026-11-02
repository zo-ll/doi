import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { Glob } from "bun";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../src/config.ts";
import { startServer } from "../src/server/app.ts";
import { checkRequest, PAGE_CSP } from "../src/server/security.ts";

const req = (path: string, init: RequestInit & { host?: string } = {}) => {
  const headers = new Headers(init.headers);
  headers.set("host", init.host ?? "127.0.0.1:4317");
  return new Request(`http://127.0.0.1:4317${path}`, { ...init, headers });
};
const status = (r: Request) => checkRequest(r, 4317)?.status ?? null;

describe("request checks", () => {
  test("only the loopback host names of this port", () => {
    expect(status(req("/api/health"))).toBeNull();
    expect(status(req("/api/health", { host: "localhost:4317" }))).toBeNull();
    expect(status(req("/api/health", { host: "evil.example:4317" }))).toBe(403);
    expect(status(req("/design/p/d/", { host: "127.0.0.1:9999" }))).toBe(403);
    expect(status(req("/api/health", { host: "" }))).toBe(403);
  });

  test("changes must come from the app, with a JSON body", () => {
    const json = { "content-type": "application/json" };
    const body = "{}";
    expect(status(req("/api/projects", { method: "POST", body, headers: { ...json, origin: "http://127.0.0.1:4317" } }))).toBeNull();
    expect(status(req("/api/projects", { method: "POST", body, headers: { ...json, origin: "http://localhost:4317" } }))).toBeNull();
    // curl and other tools send no Origin.
    expect(status(req("/api/projects", { method: "POST", body, headers: json }))).toBeNull();
    expect(status(req("/api/projects", { method: "POST", body, headers: { ...json, origin: "https://evil.example" } }))).toBe(403);
    // A sandboxed design page has the origin "null".
    expect(status(req("/api/projects", { method: "POST", body, headers: { ...json, origin: "null" } }))).toBe(403);
    expect(status(req("/api/projects/p", { method: "DELETE", headers: { origin: "http://127.0.0.1:9999" } }))).toBe(403);
    // A "simple" cross-site request has no JSON type.
    expect(status(req("/api/projects", { method: "POST", body, headers: { "content-type": "text/plain" } }))).toBe(415);
    expect(status(req("/api/projects", { method: "POST", body: "x" }))).toBe(415);
    // A ZIP body only on the import routes; a form post stays refused there too.
    const zip = { "content-type": "application/zip" };
    expect(status(req("/api/import", { method: "POST", body: "PK", headers: zip }))).toBeNull();
    expect(status(req("/api/import/inspect", { method: "POST", body: "PK", headers: zip }))).toBeNull();
    expect(status(req("/api/projects", { method: "POST", body: "PK", headers: zip }))).toBe(415);
    expect(status(req("/api/import", { method: "POST", body: "x", headers: { "content-type": "text/plain" } }))).toBe(415);
    expect(status(req("/api/import", { method: "POST", body: "PK", headers: { ...zip, origin: "https://evil.example" } }))).toBe(403);
    // A POST without a body (restore) needs no type.
    expect(status(req("/api/projects/p/designs/d/history/abc1234/restore", { method: "POST" }))).toBeNull();
    // Reads are not refused for their Origin: without CORS, another site cannot read the answer.
    expect(status(req("/api/projects", { headers: { origin: "https://evil.example" } }))).toBeNull();
  });

  test("the page policy blocks network requests except own files and Google Fonts", () => {
    expect(PAGE_CSP).toContain("default-src 'self'");
    expect(PAGE_CSP).toContain("connect-src 'none'");
    expect(PAGE_CSP).toContain("form-action 'none'");
    expect(PAGE_CSP).toContain("frame-src 'none'");
    expect(PAGE_CSP).toContain("https://fonts.googleapis.com");
    expect(PAGE_CSP).toContain("https://fonts.gstatic.com");
    expect(PAGE_CSP).not.toContain("*");
  });
});

describe("the server", () => {
  let app: Awaited<ReturnType<typeof startServer>>;
  let base: string;
  beforeAll(async () => {
    const workspace = await mkdtemp(join(tmpdir(), "doi-app-"));
    app = await startServer(parseConfig({ workspace }), { port: 0, development: false });
    base = `http://127.0.0.1:${app.server.port}`;
  });
  afterAll(() => app.stop());

  test("listens on 127.0.0.1 only", () => {
    expect(app.server.hostname).toBe("127.0.0.1");
    expect(app.server.url.hostname).toBe("127.0.0.1");
  });

  test("refuses other hosts, other sites and non-JSON bodies; design pages get the policy", async () => {
    expect((await fetch(`${base}/api/health`)).status).toBe(200);
    expect((await fetch(`${base}/api/health`, { headers: { host: "rebind.example" } })).status).toBe(403);
    const post = (headers: Record<string, string>) =>
      fetch(`${base}/api/projects`, { method: "POST", headers, body: JSON.stringify({ name: "Shop" }) });
    expect((await post({ "content-type": "application/json", origin: "https://evil.example" })).status).toBe(403);
    expect((await post({ "content-type": "text/plain" })).status).toBe(415);
    expect((await post({ "content-type": "application/json", origin: base })).status).toBe(201);
    // The stop route of a turn has the same guard: another site or a design page cannot stop a turn.
    const stopTurn = (origin: string) => fetch(`${base}/api/projects/shop/designs/home/turns`, { method: "DELETE", headers: { origin } });
    expect((await stopTurn("https://evil.example")).status).toBe(403);
    expect((await stopTurn("null")).status).toBe(403);
    expect((await stopTurn(base)).status).toBe(204);

    const page = await fetch(`${base}/design/shop/home/`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toBe(PAGE_CSP);
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await page.text()).toContain('<script src="/__doi/bridge.js"></script>');
    expect((await fetch(`${base}/design/shop/home/styles.css`)).headers.get("content-security-policy")).toBe(PAGE_CSP);
    expect((await fetch(`${base}/design/shop/home/`, { headers: { host: "rebind.example" } })).status).toBe(403);

    // Design system files are served for pages, with the same policy.
    const ds = join(app.workspace, "design-systems", "brand");
    await Bun.write(join(ds, "tokens.css"), ":root { --x: 1px; }");
    await Bun.write(join(ds, ".secret"), "x");
    const tokens = await fetch(`${base}/ds/brand/tokens.css`);
    expect(tokens.status).toBe(200);
    expect(await tokens.text()).toBe(":root { --x: 1px; }");
    expect(tokens.headers.get("content-security-policy")).toBe(PAGE_CSP);
    expect((await fetch(`${base}/ds/brand/.secret`)).status).toBe(404);
    expect((await fetch(`${base}/ds/Bad/tokens.css`)).status).toBe(400);
    expect(await (await fetch(`${base}/api/design-systems`)).json()).toEqual(["brand"]);
    // Without components.css, the styles of components.html are served as components.css.
    expect((await fetch(`${base}/ds/brand/components.css`)).status).toBe(404);
    await Bun.write(join(ds, "components.html"), "<button class=b>x</button><style>.b { color: red; }</style>");
    const comps = await fetch(`${base}/ds/brand/components.css`);
    expect([comps.status, comps.headers.get("content-type"), await comps.text()]).toEqual([200, "text/css; charset=utf-8", ".b { color: red; }\n"]);
    const preview = await fetch(`${base}/ds/brand/preview.html`);
    expect(preview.headers.get("content-security-policy")).toBe(PAGE_CSP);
    expect(await preview.text()).toContain("<button class=b>x</button>");
  });
});

describe("frame rules in the code", () => {
  const sources = async () => {
    const out: { path: string; text: string }[] = [];
    for await (const path of new Glob("src/web/**/*.{ts,tsx}").scan(".")) out.push({ path, text: await Bun.file(path).text() });
    return out;
  };

  test("every iframe is sandboxed with allow-scripts only (no same-origin access)", async () => {
    let count = 0;
    for (const { path, text } of await sources()) {
      for (const m of text.matchAll(/<iframe\b[^>]*>/gs)) {
        count++;
        expect({ path, sandbox: m[0].match(/sandbox="([^"]*)"/)?.[1] }).toEqual({ path, sandbox: "allow-scripts" });
      }
    }
    expect(count).toBeGreaterThan(0);
    for (const { text } of await sources()) expect(text).not.toContain("allow-same-origin");
  });

  test("every message listener checks the frame and parses the data", async () => {
    let count = 0;
    for (const { path, text } of await sources()) {
      if (!text.includes('addEventListener("message"')) continue;
      count++;
      expect({ path, source: text.includes("event.source !== ref.current?.contentWindow") }).toEqual({ path, source: true });
      expect({ path, parse: text.includes("parseFrameMessage(event.data)") }).toEqual({ path, parse: true });
      expect({ path, raw: /event\.data\.\w/.test(text) }).toEqual({ path, raw: false });
    }
    expect(count).toBeGreaterThan(0);
  });
});
