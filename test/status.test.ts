import { describe, expect, test } from "bun:test";
import { parseConfig } from "../src/config.ts";
import { LOGGED_IN, providerStatus, safeHost, type StatusDeps } from "../src/providers/status.ts";

function deps(over: Partial<StatusDeps> = {}): StatusDeps & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    env: {},
    which: () => "/usr/bin/x",
    run: async (cmd) => {
      calls.push(cmd);
      return { code: 0, stdout: "", stderr: "" };
    },
    fetch: async () => ({ ok: false }),
    ...over,
  };
}

const config = parseConfig({}, "/tmp/doi");
const byId = async (d: StatusDeps, c = config) => Object.fromEntries((await providerStatus(c, d)).map((s) => [s.id, s]));

describe("providerStatus", () => {
  test("lists every provider once", async () => {
    const ids = (await providerStatus(config, deps())).map((s) => s.id);
    expect(ids).toEqual(["anthropic", "openai", "opencode-go", "google", "openrouter", "ollama", "claude-code", "codex"]);
  });

  test("API key providers are ready when their variable is set, and name it when it is not", async () => {
    const s = await byId(deps({ env: { ANTHROPIC_API_KEY: "sk-test" } }));
    expect(s.anthropic).toMatchObject({ source: "api_key", ready: true, detail: "Key from ANTHROPIC_API_KEY" });
    expect(s["opencode-go"]).toMatchObject({ source: "api_key", ready: false, detail: "Set OPENCODE_API_KEY" });
  });

  test("api_key_env in config.toml overrides the default variable", async () => {
    const c = parseConfig({ providers: { openai: { api_key_env: "MY_OPENAI" } } }, "/tmp/doi");
    const s = await byId(deps({ env: { MY_OPENAI: "x" } }), c);
    expect(s.openai).toMatchObject({ ready: true, detail: "Key from MY_OPENAI" });
  });

  test("details never contain the key value", async () => {
    const all = await providerStatus(config, deps({ env: { ANTHROPIC_API_KEY: "sk-secret-value" } }));
    expect(JSON.stringify(all)).not.toContain("sk-secret-value");
  });

  test("claude-code reports only the login state from claude auth status", async () => {
    const d = deps({
      run: async (cmd) => {
        d.calls.push(cmd);
        return { code: 0, stdout: JSON.stringify({ loggedIn: true, subscriptionType: "max", email: "me@example.com" }), stderr: "" };
      },
    });
    const s = await byId(d);
    expect(d.calls).toContainEqual(["claude", "auth", "status", "--json"]);
    expect(s["claude-code"]).toMatchObject({ source: "cli", ready: true, detail: LOGGED_IN });
    expect(JSON.stringify(s)).not.toContain("me@example.com");
    expect(JSON.stringify(s)).not.toContain("max");
  });

  test("claude-code: not logged in, missing CLI, bad output", async () => {
    const out = (stdout: string) => deps({ run: async () => ({ code: 0, stdout, stderr: "" }) });
    expect((await byId(out('{"loggedIn":false}')))["claude-code"]).toMatchObject({ ready: false, detail: "Not logged in. Run: claude auth login" });
    expect((await byId(out("not json")))["claude-code"]).toMatchObject({ ready: false, detail: "Cannot read claude auth status" });
    expect((await byId(deps({ which: () => null })))["claude-code"]).toMatchObject({ ready: false, detail: "Claude Code CLI not found on PATH" });
  });

  test("codex reports only the login state, never the login method", async () => {
    const res = (code: number, stderr: string) => deps({ run: async () => ({ code, stdout: "", stderr }) });
    for (const line of ["Logged in using ChatGPT", "Logged in using an API key"]) {
      expect((await byId(res(0, line)))["codex"]).toMatchObject({ ready: true, detail: LOGGED_IN });
    }
    expect((await byId(res(1, "Not logged in")))["codex"]).toMatchObject({ ready: false, detail: "Not logged in. Run: codex login" });
  });

  test("ollama details show the host only, never user information from base_url", async () => {
    const c = parseConfig({ providers: { ollama: { base_url: "https://user:s3cret-token@ollama.example:8443" } } }, "/tmp/doi");
    for (const ok of [true, false]) {
      const s = await byId(deps({ fetch: async () => ({ ok }) }), c);
      expect(s.ollama!.detail).toContain("ollama.example:8443");
      expect(JSON.stringify(s)).not.toContain("s3cret-token");
    }
    expect(safeHost("not a url")).toBe("the configured base_url");
    expect(safeHost("localhost:11434")).toBe("the configured base_url");
  });

  test("ollama is ready when its server answers", async () => {
    expect((await byId(deps({ fetch: async () => ({ ok: true }) })))["ollama"]).toMatchObject({ source: "local", ready: true });
    expect((await byId(deps({ fetch: async () => { throw new Error("refused"); } })))["ollama"]).toMatchObject({ ready: false });
  });

  test("implemented reflects the provider registry", async () => {
    const s = await byId(deps());
    expect(s.anthropic!.implemented).toBe(true);
    expect(s["claude-code"]!.implemented).toBe(true);
    expect(s.codex!.implemented).toBe(false); // #73
  });
});
