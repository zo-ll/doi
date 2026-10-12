import { describe, expect, test } from "bun:test";
import { parseConfig } from "../src/config.ts";
import { providerStatus, type StatusDeps } from "../src/providers/status.ts";

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

  test("claude-code reads only the login state and the plan from claude auth status", async () => {
    const d = deps({
      run: async (cmd) => {
        d.calls.push(cmd);
        return { code: 0, stdout: JSON.stringify({ loggedIn: true, subscriptionType: "max", email: "me@example.com" }), stderr: "" };
      },
    });
    const s = await byId(d);
    expect(d.calls).toContainEqual(["claude", "auth", "status", "--json"]);
    expect(s["claude-code"]).toMatchObject({ source: "cli", ready: true, detail: "Claude max subscription" });
    expect(JSON.stringify(s)).not.toContain("me@example.com");
  });

  test("claude-code: not logged in, missing CLI, bad output", async () => {
    const out = (stdout: string) => deps({ run: async () => ({ code: 0, stdout, stderr: "" }) });
    expect((await byId(out('{"loggedIn":false}')))["claude-code"]).toMatchObject({ ready: false, detail: "Not logged in. Run: claude auth login" });
    expect((await byId(out("not json")))["claude-code"]).toMatchObject({ ready: false, detail: "Cannot read claude auth status" });
    expect((await byId(deps({ which: () => null })))["claude-code"]).toMatchObject({ ready: false, detail: "Claude Code CLI not found on PATH" });
  });

  test("codex: ChatGPT login, API key login, not logged in", async () => {
    // Codex writes the login state to stderr.
    const res = (code: number, stderr: string) => deps({ run: async () => ({ code, stdout: "", stderr }) });
    expect((await byId(res(0, "Logged in using ChatGPT")))["codex"]).toMatchObject({ ready: true, detail: "ChatGPT subscription" });
    expect((await byId(res(0, "Logged in using an API key")))["codex"]).toMatchObject({ ready: true, detail: "Logged in with an API key" });
    expect((await byId(res(1, "Not logged in")))["codex"]).toMatchObject({ ready: false, detail: "Not logged in. Run: codex login" });
  });

  test("ollama is ready when its server answers", async () => {
    expect((await byId(deps({ fetch: async () => ({ ok: true }) })))["ollama"]).toMatchObject({ source: "local", ready: true });
    expect((await byId(deps({ fetch: async () => { throw new Error("refused"); } })))["ollama"]).toMatchObject({ ready: false });
  });

  test("implemented reflects the provider registry", async () => {
    const s = await byId(deps());
    expect(s.anthropic!.implemented).toBe(true);
    expect(s["claude-code"]!.implemented).toBe(false);
  });
});
