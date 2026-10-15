import { describe, expect, test } from "bun:test";
import { loginUrl, startLogin, type LoginDeps, type LoginProc } from "../src/providers/login.ts";

/** A CLI that prints `out` and then exits with `code`, or stays when `code` is null. */
function fakeCli(out: string[], code: number | null) {
  const spawned: string[][] = [];
  let killed = false;
  const deps: LoginDeps = {
    which: () => "/usr/bin/x",
    urlWaitMs: 200,
    // A login that stays stops soon, so the next test starts a new one.
    maxMs: 60,
    spawn(cmd): LoginProc {
      spawned.push(cmd);
      const stream = (text: string) => new Response(text).body!;
      let exit!: (c: number) => void;
      const exited = new Promise<number>((r) => (exit = r));
      if (code !== null) setTimeout(() => exit(code), 20);
      return { stdout: stream(out.join("\n")), stderr: stream(""), exited, kill: () => ((killed = true), exit(143)) };
    },
  };
  return { deps, spawned, killed: () => killed };
}

describe("startLogin", () => {
  test("runs the official CLI and answers with the URL only", async () => {
    const cli = fakeCli(["Logged in as me@example.com", "Open https://claude.ai/oauth/authorize?code=true&state=x to log in"], null);
    const result = await startLogin("claude-code", cli.deps);
    expect(cli.spawned).toEqual([["claude", "auth", "login"]]);
    expect(result).toEqual({ ok: true, url: "https://claude.ai/oauth/authorize?code=true&state=x" });
    expect(JSON.stringify(result)).not.toContain("me@example.com");
    // A second click joins the login that runs.
    expect(await startLogin("claude-code", cli.deps)).toEqual(result);
    expect(cli.spawned).toHaveLength(1);
    await Bun.sleep(100);
    expect(cli.killed()).toBe(true);
  });

  test("codex uses codex login; a failed CLI gives an error", async () => {
    const cli = fakeCli(["error"], 1);
    expect(await startLogin("codex", cli.deps)).toEqual({ ok: false, error: "codex login stopped with exit code 1." });
    expect(cli.spawned).toEqual([["codex", "login"]]);
  });

  test("API providers and a missing CLI do not start", async () => {
    const cli = fakeCli([], 0);
    expect((await startLogin("opencode-go", cli.deps)).ok).toBe(false);
    expect(await startLogin("codex", { ...cli.deps, which: () => null })).toEqual({ ok: false, error: "codex is not on PATH. Install the CLI first." });
    expect(cli.spawned).toHaveLength(0);
  });

  test("no URL in time answers without one", async () => {
    const cli = fakeCli(["Opening the browser…"], null);
    expect(await startLogin("claude-code", { ...cli.deps, maxMs: 300 })).toEqual({ ok: true, url: null });
  });
});

test("loginUrl takes only https URLs", () => {
  expect(loginUrl("go to https://auth.openai.com/oauth?x=1).")).toBe("https://auth.openai.com/oauth?x=1");
  expect(loginUrl("http://localhost:1455/callback")).toBeNull();
  expect(loginUrl("javascript:alert(1)")).toBeNull();
});
