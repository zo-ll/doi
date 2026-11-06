import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.ts";
import { isDownloadChild } from "../src/export/browser.ts";
import { openCommand, parseCli } from "../src/server/cli.ts";

describe("parseCli", () => {
  test("no arguments: start with the default config", () => {
    expect(parseCli([])).toEqual({ command: "run", config: undefined, workspace: undefined, port: undefined, open: false, json: false });
  });

  test("start options", () => {
    expect(parseCli(["--config", "a/doi.toml", "--workspace", "~/w", "--port", "5000", "--open"])).toEqual({
      command: "run",
      config: "a/doi.toml",
      workspace: "~/w",
      port: 5000,
      open: true,
      json: false,
    });
    expect(parseCli(["start", "--json", "--port", "0"])).toMatchObject({ command: "start", json: true, port: 0 });
    expect(parseCli(["status"])).toMatchObject({ command: "status", json: false });
    expect(parseCli(["stop"])).toMatchObject({ command: "stop" });
    expect(parseCli(["doctor", "--json"])).toEqual({ command: "doctor", json: true });
    expect(() => parseCli(["--port", "0"])).toThrow("--port");
    expect(() => parseCli(["launch"])).toThrow("launch");
    expect(parseCli(["--port=4317"])).toMatchObject({ port: 4317 });
    expect(() => parseCli(["--config", ""])).toThrow("--config");
  });

  test("help, version and install-browser", () => {
    expect(parseCli(["--help"])).toEqual({ command: "help" });
    expect(parseCli(["-h", "--port", "x"])).toEqual({ command: "help" });
    expect(parseCli(["-v"])).toEqual({ command: "version" });
    expect(parseCli(["install-browser"])).toEqual({ command: "install-browser" });
  });

  test("bad input throws", () => {
    for (const port of ["0", "65536", "12ab", "-1", "1.5", ""]) expect(() => parseCli(["--port", port])).toThrow("--port");
    expect(() => parseCli(["--workspace", ""])).toThrow("--workspace");
    expect(() => parseCli(["--nope"])).toThrow();
    expect(() => parseCli(["launch"])).toThrow('Unknown command "launch"');
    expect(() => parseCli(["install-browser", "x"])).toThrow("Unknown arguments");
    expect(() => parseCli(["--open=yes"])).toThrow();
  });
});

test("openCommand per system", () => {
  expect(openCommand("http://127.0.0.1:1/", "darwin")).toEqual(["open", "http://127.0.0.1:1/"]);
  expect(openCommand("http://127.0.0.1:1/", "linux")).toEqual(["xdg-open", "http://127.0.0.1:1/"]);
  expect(openCommand("http://127.0.0.1:1/", "win32")).toEqual(["cmd", "/c", "start", "", "http://127.0.0.1:1/"]);
});

test("isDownloadChild: only the Playwright download child", () => {
  expect(isDownloadChild(["/usr/bin/doi", "/home/x/node_modules/playwright-core/lib/entry/oopBrowserDownload.js"])).toBe(true);
  expect(isDownloadChild(["bun", "/$bunfs/root/doi", "--port", "4317"])).toBe(false);
});

test("loadConfig: a relative workspace is relative to the config file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "doi-cli-"));
  try {
    await Bun.write(join(dir, "doi.toml"), 'workspace = "ws"\n');
    expect((await loadConfig(join(dir, "doi.toml"))).workspace).toBe(join(dir, "ws"));
    expect((await loadConfig(join(dir, "missing.toml"))).workspace).toBe(join(dir, "workspace"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an invalid config reports its file and field without a stack trace", async () => {
  const dir = await mkdtemp(join(tmpdir(), "doi-bad-config-"));
  const path = join(dir, "config.toml");
  try {
    for (const { source, field, detail } of [
      { source: 'port = "not a port"\n', field: "port:", detail: "Use a port number" },
      { source: "[providers.mistral]\n", field: "providers:", detail: "mistral" },
    ]) {
      await Bun.write(path, source);
      const proc = Bun.spawn([process.execPath, fileURLToPath(new URL("../src/server/index.ts", import.meta.url)), "--config", path], {
        stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 5000,
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
      ]);
      expect(code).toBe(2);
      expect(stdout).toBe("");
      expect(stderr).toContain(path);
      expect(stderr).toContain(field);
      expect(stderr).toContain(detail);
      expect(stderr).not.toContain("ZodError");
      expect(stderr).not.toContain("NaN");
      expect(stderr.trim().split("\n")).toHaveLength(1);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
