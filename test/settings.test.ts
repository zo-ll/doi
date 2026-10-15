import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { memoryKeyStore } from "../src/providers/keys.ts";
import { deleteProviderKey, getUsage, postProviderLogin, putModels, putProviderKey } from "../src/server/settings.ts";
import { appendChat } from "../src/workspace/chat.ts";

const put = (body: unknown) =>
  new Request("http://127.0.0.1/api/config/models", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("PUT models writes config.toml and changes the running config", async () => {
  const dir = await mkdtemp(join(tmpdir(), "doi-settings-"));
  const path = join(dir, "config.toml");
  await Bun.write(path, '# mine\n[models]\ngenerate = "anthropic:a"\n');
  const config = await loadConfig(path);
  const res = await putModels(config, put({ generate: "claude-code:claude-opus-5-5", edit: "codex:default", extract: "claude-code:claude-haiku-5-5" }));
  expect(res.status).toBe(200);
  expect(config.models.edit).toEqual({ provider: "codex", model: "default" });
  const text = await Bun.file(path).text();
  expect(text).toStartWith("# mine\n[models]\n");
  expect((await loadConfig(path)).models).toEqual(config.models);
});

test("bad models change nothing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "doi-settings-"));
  const path = join(dir, "config.toml");
  const config = await loadConfig(path); // no file yet
  const before = structuredClone(config.models);
  for (const body of [{ generate: "nobody:x", edit: "codex:a", extract: "codex:b" }, { generate: "codex:--help", edit: "codex:a", extract: "codex:b" }, { generate: "codex:a" }]) {
    expect((await putModels(config, put(body))).status).toBe(400);
  }
  expect(config.models).toEqual(before);
  expect(await Bun.file(path).exists()).toBe(false);
});

test("usage lists the token use of every answer in every project", async () => {
  const ws = await mkdtemp(join(tmpdir(), "doi-usage-"));
  await Bun.write(join(ws, "projects/a/designs/home/index.html"), "<p>a</p>");
  await Bun.write(join(ws, "projects/b/designs/deck/index.html"), "<p>b</p>");
  const usage = { inputTokens: 100, outputTokens: 20, cachedTokens: 50 };
  const answer = (design: string, at: string) => ({ role: "assistant" as const, turn: at, design, at, text: "", status: "done" as const, provider: "claude-code" as const, model: "m", usage, files: [], prompt: "v1" });
  await appendChat(ws, "a", { role: "user", turn: "t", design: "home", at: "2026-10-01T00:00:00Z", text: "x", target: null });
  await appendChat(ws, "a", answer("home", "2026-10-01T00:00:01Z"));
  await appendChat(ws, "b", answer("deck", "2026-10-02T00:00:01Z"));
  const config = { ...(await loadConfig(join(ws, "none.toml"))), workspace: ws };
  const list = (await (await getUsage(config)).json()) as { project: string; design: string; inputTokens: number }[];
  expect(list.map((e) => [e.project, e.design, e.inputTokens])).toEqual([
    ["a", "home", 100],
    ["b", "deck", 100],
  ]);
});

const keyReq = (body: unknown) =>
  new Request("http://127.0.0.1/api/providers/x/key", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("PUT and DELETE a provider key; the answer never holds the key", async () => {
  const keys = memoryKeyStore({}, "file");
  const res = await putProviderKey(keyReq({ key: " sk-secret " }), { id: "opencode-go" }, keys);
  expect(res.status).toBe(200);
  const text = await res.text();
  expect(JSON.parse(text)).toEqual({ where: "file" });
  expect(text).not.toContain("sk-secret");
  expect(await keys.get("opencode-go")).toEqual({ value: "sk-secret", where: "file" });
  expect(await (await deleteProviderKey({ id: "opencode-go" }, keys)).json()).toEqual({ removed: true });
  expect(await keys.get("opencode-go")).toBeNull();
});

test("bad keys and providers without keys are refused", async () => {
  const keys = memoryKeyStore();
  expect((await putProviderKey(keyReq({ key: "a b" }), { id: "openai" }, keys)).status).toBe(400);
  expect((await putProviderKey(keyReq({}), { id: "openai" }, keys)).status).toBe(400);
  for (const id of ["claude-code", "ollama", "nobody", "__proto__"]) {
    expect((await putProviderKey(keyReq({ key: "sk" }), { id }, keys)).status).toBe(404);
    expect((await deleteProviderKey({ id }, keys)).status).toBe(404);
  }
  expect(await keys.get("openai")).toBeNull();
});

test("login only for the CLI backends", async () => {
  const deps = { which: () => null, spawn: () => { throw new Error("no spawn"); } };
  for (const id of ["opencode-go", "anthropic", "nobody"]) expect((await postProviderLogin({ id }, deps)).status).toBe(404);
  const res = await postProviderLogin({ id: "codex" }, deps);
  expect(res.status).toBe(502);
  expect((await res.json()).error).toContain("not on PATH");
});
