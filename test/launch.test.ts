import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT } from "../src/server/cli.ts";
import { recordFile, writeRecord } from "../src/server/instance.ts";

const ENTRY = join(import.meta.dir, "../src/server/index.ts");
let root: string;
let env: Record<string, string>;
const started: { workspace: string }[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "doi launch "));
  env = { ...(process.env as Record<string, string>), XDG_DATA_HOME: join(root, "data"), XDG_CONFIG_HOME: join(root, "config") };
});

async function doi(args: string[], options: { env?: Record<string, string>; cwd?: string } = {}) {
  const proc = Bun.spawn([process.execPath, ENTRY, ...args], { cwd: options.cwd ?? root, env: options.env ?? env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
}
const ws = (name = "one") => join(root, "work space", name);
const config = () => join(root, "none.toml");
const common = (name = "one") => ["--json", "--config", config(), "--workspace", ws(name)];

async function startDoi(name = "one", port = "0") {
  const result = await doi(["start", ...common(name), "--port", port]);
  started.push({ workspace: ws(name) });
  return { ...result, info: JSON.parse(result.stdout) };
}

afterEach(async () => {
  for (const { workspace } of started.splice(0)) await doi(["stop", "--json", "--config", config(), "--workspace", workspace]);
  await rm(root, { recursive: true, force: true });
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("doi start", () => {
  test("returns one JSON object when the UI, API and MCP answer, and the server outlives the command", async () => {
    const { code, stdout, info } = await startDoi();
    expect(code).toBe(EXIT.ok);
    expect(stdout.trim().split("\n")).toHaveLength(1);
    expect(info).toMatchObject({ ok: true, reused: false, workspace: ws() });
    expect([typeof info.version, typeof info.pid, typeof info.instance]).toEqual(["string", "number", "string"]);
    expect(typeof info.renderer.ready).toBe("boolean");
    expect(alive(info.pid)).toBe(true);
    expect((await fetch(info.url)).ok).toBe(true);
    const projects = (await (await fetch(`${info.url}api/projects`)).json()) as { id: string }[];
    expect(projects.map((p) => p.id)).toContain("sample");
    const tools = await fetch(info.mcp, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(await tools.text()).toContain("export_png");
    expect(new URL(info.url).hostname).toBe("127.0.0.1");
    expect(await Bun.file(info.log).exists()).toBe(true);
  }, 40_000);

  test("a second start of the same workspace reuses the same server", async () => {
    const first = (await startDoi()).info;
    const second = await startDoi();
    expect(second.code).toBe(EXIT.ok);
    expect(second.info).toMatchObject({ reused: true, pid: first.pid, instance: first.instance, url: first.url });
  }, 40_000);

  test("another port for a running workspace is a conflict, not a second server", async () => {
    const first = (await startDoi()).info;
    const free = Bun.serve({ port: 0, fetch: () => new Response("x") });
    const port = free.port!;
    free.stop(true);
    const second = await startDoi("one", String(port));
    expect(second.code).toBe(EXIT.port);
    expect(second.info).toMatchObject({ ok: false, code: "port_conflict" });
    expect(alive(first.pid)).toBe(true);
  }, 40_000);

  test("a port with the doi of another workspace is a conflict: it never attaches to that workspace", async () => {
    const first = (await startDoi("one")).info;
    const second = await startDoi("two", new URL(first.url).port);
    expect(second.code).toBe(EXIT.port);
    expect(second.info.code).toBe("port_conflict");
    expect(second.info.message).toContain(ws("one"));
    expect(alive(first.pid)).toBe(true);
  }, 40_000);

  test("a port with another program is a conflict", async () => {
    const other = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("not doi") });
    try {
      const result = await startDoi("one", String(other.port));
      expect(result.code).toBe(EXIT.port);
      expect(result.info.message).toContain("another program");
    } finally {
      other.stop(true);
    }
  }, 40_000);

  test("two workspaces run side by side, and stop affects only its own", async () => {
    const one = (await startDoi("one")).info;
    const two = (await startDoi("two")).info;
    expect(one.instance).not.toBe(two.instance);
    const stopped = await doi(["stop", ...common("one")]);
    expect(JSON.parse(stopped.stdout)).toMatchObject({ stopped: true, pid: one.pid });
    expect(alive(two.pid)).toBe(true);
    expect((await fetch(two.url)).ok).toBe(true);
    await expect(fetch(one.url)).rejects.toBeDefined();
  }, 40_000);

  test("two starts at once make one server", async () => {
    const free = Bun.serve({ port: 0, fetch: () => new Response("x") });
    const port = String(free.port);
    free.stop(true);
    const [a, b] = await Promise.all([startDoi("one", port), startDoi("one", port)]);
    expect([a.code, b.code]).toEqual([EXIT.ok, EXIT.ok]);
    expect(a.info.instance).toBe(b.info.instance);
    expect([a.info.reused, b.info.reused].sort()).toEqual([false, true]);
  }, 60_000);

  test("a bad config gives exit code 2 and JSON on stdout", async () => {
    const bad = join(root, "bad.toml");
    await Bun.write(bad, "port = \"nope\"\n");
    const result = await doi(["start", "--json", "--config", bad, "--workspace", ws()]);
    expect(result.code).toBe(EXIT.usage);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, code: "invalid_config" });
    expect(result.stdout).not.toContain("at ");
  });

  test("a missing git gives exit code 3 with the recovery", async () => {
    const result = await doi(["start", ...common(), "--port", "0"], { env: { ...env, PATH: join(root, "nothing") } });
    expect(result.code).toBe(EXIT.tool);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, code: "missing_tool" });
    expect(result.stdout).toContain("git-scm.com");
  });

  test("bad usage gives exit code 2, with words on stderr and nothing on stdout", async () => {
    const result = await doi(["launch"]);
    expect(result.code).toBe(EXIT.usage);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Unknown command");
    expect((await doi(["status", "--port", "0"])).code).toBe(EXIT.usage);
  });
});

describe("doi status and doi stop", () => {
  test("status reports a running server, and exit code 1 after a stop", async () => {
    const { info } = await startDoi();
    const running = await doi(["status", ...common()]);
    expect(running.code).toBe(EXIT.ok);
    expect(JSON.parse(running.stdout)).toMatchObject({ running: true, pid: info.pid, url: info.url, mcp: info.mcp });
    expect((await doi(["stop", ...common()])).code).toBe(EXIT.ok);
    expect(alive(info.pid)).toBe(false);
    const after = await doi(["status", ...common()]);
    expect(after.code).toBe(EXIT.notRunning);
    expect(JSON.parse(after.stdout)).toMatchObject({ ok: true, running: false, workspace: ws() });
  }, 40_000);

  test("stop with nothing running is fine and does nothing", async () => {
    const result = await doi(["stop", ...common()]);
    expect(result.code).toBe(EXIT.ok);
    expect(JSON.parse(result.stdout)).toEqual({ ok: true, stopped: false, workspace: ws() });
  });

  test("a stale record never stops an unrelated process", async () => {
    const unrelated = Bun.spawn(["sleep", "30"]);
    try {
      // The record names a live process, and nothing that proves it is doi answers on that port.
      const file = recordFile(ws(), join(root, "data", "doi"));
      await writeRecord({ id: "old", pid: unrelated.pid, port: 1, workspace: ws(), version: "0", log: null }, file);
      const result = await doi(["stop", ...common()]);
      expect(JSON.parse(result.stdout)).toMatchObject({ stopped: false });
      expect(alive(unrelated.pid)).toBe(true);
    } finally {
      unrelated.kill();
    }
  });

  test("a record whose port now has another doi does not stop that doi", async () => {
    const other = (await startDoi("two")).info;
    const file = recordFile(ws("one"), join(root, "data", "doi"));
    await writeRecord({ id: "old", pid: other.pid, port: Number(new URL(other.url).port), workspace: ws("one"), version: "0", log: null }, file);
    const result = await doi(["stop", ...common("one")]);
    expect(JSON.parse(result.stdout)).toMatchObject({ stopped: false });
    expect(alive(other.pid)).toBe(true);
  }, 40_000);
});

test("a terminal run of a workspace that already runs says so, with exit code 5", async () => {
  const { info } = await startDoi();
  const result = await doi(["--config", config(), "--workspace", ws(), "--port", "1"]);
  expect(result.code).toBe(EXIT.port);
  expect(result.stderr).toContain(info.url);
  expect(alive(info.pid)).toBe(true);
}, 40_000);

test("doctor reports the tools and the renderer, and no model starts", async () => {
  const result = await doi(["doctor", "--json"]);
  const info = JSON.parse(result.stdout);
  expect(info.tools.map((t: { name: string }) => t.name)).toEqual(["git", "claude", "codex", "gh"]);
  expect(typeof info.renderer.ready).toBe("boolean");
  expect(info.exitCode).toBeUndefined();
  const none = await doi(["doctor", "--json"], { env: { ...env, PATH: join(root, "nothing") } });
  expect(none.code).toBe(EXIT.tool);
  expect(JSON.parse(none.stdout).ok).toBe(false);
}, 30_000);
