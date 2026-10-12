import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { parseConfig, type Config } from "../src/config.ts";
import type { GenerateRequest, Provider, ProviderCapabilities } from "../src/providers/types.ts";
import { DesignLocks } from "../src/server/locks.ts";
import { createVariantHandlers, type VariantSetView, type VariantStreamEvent } from "../src/server/variants.ts";
import { readChat } from "../src/workspace/chat.ts";
import { designDir } from "../src/workspace/paths.ts";
import { renameDesign } from "../src/workspace/projects.ts";
import { variantDir, variantsRoot } from "../src/workspace/variants.ts";

const caps: ProviderCapabilities = { vision: true, toolUse: true, promptCache: "explicit", maxContextTokens: 200_000, editsFiles: false };

let config: Config;
let server: ReturnType<typeof Bun.serve>;
let commits: { paths: string[]; message: string }[];
let calls: { provider: string; req: GenerateRequest }[];
let behave: (provider: string, req: GenerateRequest) => AsyncGenerator<any>;
let handlers: ReturnType<typeof createVariantHandlers>;
let dir: string;

beforeEach(async () => {
  const workspace = await mkdtemp(join(tmpdir(), "doi-variants-"));
  config = parseConfig({ workspace, models: { generate: "anthropic:big", edit: "openai:small" } });
  dir = designDir(workspace, "p", "d");
  await mkdir(dir, { recursive: true });
  await Bun.write(join(dir, "index.html"), '<h1 data-oid="title">Hi</h1>');
  await Bun.write(join(dir, "styles.css"), "h1 { color: red; }");
  await Bun.write(join(dir, ".comments.json"), "[]\n");
  commits = [];
  calls = [];
  // Each provider makes its own color, so the variants differ.
  behave = async function* (provider) {
    const color = provider === "anthropic" ? "blue" : "green";
    yield { type: "text", delta: `Made it ${color}.` };
    yield { type: "edit", file: "styles.css", oldText: "red", newText: color };
    yield { type: "usage", inputTokens: provider === "anthropic" ? 100 : 50, outputTokens: 5, cachedTokens: 0 };
    yield { type: "done" };
  };
  handlers = createVariantHandlers({
    config,
    locks: new DesignLocks(),
    commit: async (paths, message) => {
      commits.push({ paths: paths.map((p) => relative(config.workspace, p)), message });
      return "c".repeat(40);
    },
    getProvider: (id) =>
      ({
        id,
        capabilities: caps,
        generate(req: GenerateRequest) {
          calls.push({ provider: id, req });
          return behave(id, req);
        },
      }) as Provider,
  });
  server = Bun.serve({
    port: 0,
    routes: {
      "/v/:project/:design": { GET: (req) => handlers.get(req.params), POST: (req, srv) => handlers.post(req, req.params, srv) },
      "/v/:project/:design/:set/pick": { POST: (req) => handlers.pick(req, req.params) },
      "/v/:project/:design/:set": { DELETE: (req) => handlers.discard(req.params) },
    },
  });
});
afterEach(() => server.stop(true));

const url = (path = "") => `${server.url}v/p/d${path}`;
const post = (body: unknown) => fetch(url(), { method: "POST", body: JSON.stringify(body) });
const getSet = async () => (await (await fetch(url())).json()) as VariantSetView | null;
async function events(res: Response): Promise<VariantStreamEvent[]> {
  return (await res.text()).split("\n\n").filter(Boolean).map((b) => JSON.parse(b.split("\n").find((l) => l.startsWith("data: "))!.slice(6)));
}
const read = (path: string) => Bun.file(path).text();

describe("variants", () => {
  test("N turns run on copies of the design, each with its own model and usage", async () => {
    const evs = await events(await post({ text: "Make it pop", count: 2, models: ["anthropic:big", "openai:mini"] }));
    expect(evs[0]).toMatchObject({ type: "variants", variants: [{ n: 1, provider: "anthropic", model: "big" }, { n: 2, provider: "openai", model: "mini" }] });
    expect(evs.filter((e) => e.type === "variant" && e.event.type === "applied").map((e) => (e as any).n).sort()).toEqual([1, 2]);
    expect(evs.at(-1)).toEqual({ type: "variants-done", commit: "c".repeat(40) });
    expect(calls.map((c) => [c.provider, c.req.model]).sort()).toEqual([["anthropic", "big"], ["openai", "mini"]]);

    const set = (await getSet())!;
    expect(set.running).toBe(false);
    expect(set.prompt).toBe("Make it pop");
    expect(set.variants.map((v) => [v.n, v.status, v.text, v.usage.inputTokens, v.files])).toEqual([
      [1, "done", "Made it blue.", 100, ["styles.css"]],
      [2, "done", "Made it green.", 50, ["styles.css"]],
    ]);
    expect(await read(join(variantDir(config.workspace, "p", "d", set.id, 1), "styles.css"))).toBe("h1 { color: blue; }");
    expect(await read(join(variantDir(config.workspace, "p", "d", set.id, 2), "styles.css"))).toBe("h1 { color: green; }");
    // The design itself is unchanged, and its comments are not copied.
    expect(await read(join(dir, "styles.css"))).toBe("h1 { color: red; }");
    expect(existsSync(join(variantDir(config.workspace, "p", "d", set.id, 1), ".comments.json"))).toBe(false);
    expect(commits).toEqual([{ paths: [`projects/p/variants/d/${set.id}`], message: "Variants: Make it pop" }]);
    expect(await handlers.isOpen({ project: "p", design: "d" })).toBe(true);
    expect((await post({ text: "Again", count: 2 })).status).toBe(409);
  });

  test("pick makes the variant the design, adds it to the chat, and removes the set", async () => {
    await events(await post({ text: "Make it pop", count: 2, models: ["anthropic:big", "openai:mini"] }));
    const set = (await getSet())!;
    expect((await fetch(url(`/${set.id}/pick`), { method: "POST", body: JSON.stringify({ n: 3 }) })).status).toBe(400);
    const res = await fetch(url(`/${set.id}/pick`), { method: "POST", body: JSON.stringify({ n: 2 }) });
    expect(await res.json()).toEqual({ commit: "c".repeat(40) });
    expect(await read(join(dir, "styles.css"))).toBe("h1 { color: green; }");
    expect(await read(join(dir, ".comments.json"))).toBe("[]\n");
    expect(existsSync(join(variantsRoot(config.workspace, "p", "d"), set.id))).toBe(false);
    expect(await getSet()).toBeNull();
    const [user, answer] = await readChat(config.workspace, "p", "d");
    expect(user).toMatchObject({ role: "user", text: "Make it pop", target: null });
    expect(answer).toMatchObject({ role: "assistant", text: "Made it green.", provider: "openai", model: "mini", variant: 2, status: "done" });
    expect(commits.at(-1)).toEqual({
      paths: ["projects/p/designs/d", `projects/p/variants/d/${set.id}`, "projects/p/chat.jsonl"],
      message: "Pick variant 2: Make it pop",
    });
  });

  test("discard removes the set and keeps the design", async () => {
    await events(await post({ text: "Try", count: 3 }));
    const set = (await getSet())!;
    expect(set.variants.map((v) => v.provider)).toEqual(["anthropic", "anthropic", "anthropic"]);
    expect((await fetch(url(`/${set.id}`), { method: "DELETE" })).status).toBe(200);
    expect(await getSet()).toBeNull();
    expect(await read(join(dir, "styles.css"))).toBe("h1 { color: red; }");
    expect(commits.at(-1)).toEqual({ paths: [`projects/p/variants/d/${set.id}`], message: "Discard variants: Try" });
    expect((await fetch(url(`/${set.id}`), { method: "DELETE" })).status).toBe(404);
  });

  test("a failed variant cannot be picked; when all fail, no set stays", async () => {
    behave = async function* (provider) {
      if (provider === "openai") throw new Error("rate limit");
      yield { type: "edit", file: "styles.css", oldText: "red", newText: "blue" };
      yield { type: "done" };
    };
    const evs = await events(await post({ text: "x", count: 2, models: ["anthropic:big", "openai:mini"] }));
    expect(evs.find((e) => e.type === "variant" && e.event.type === "error")).toEqual({
      type: "variant",
      n: 2,
      event: { type: "error", kind: "provider", message: "rate limit" },
    });
    const set = (await getSet())!;
    expect(set.variants.map((v) => v.status)).toEqual(["done", "error"]);
    const bad = await fetch(url(`/${set.id}/pick`), { method: "POST", body: JSON.stringify({ n: 2 }) });
    expect((await bad.json()).error).toBe("Variant 2 did not finish, so it cannot be picked.");
    await fetch(url(`/${set.id}`), { method: "DELETE" });

    behave = async function* () {
      throw new Error("down");
    };
    const all = await events(await post({ text: "y", count: 2 }));
    expect(all.at(-1)).toEqual({ type: "variants-done", commit: null, error: "No variant was made." });
    expect(await getSet()).toBeNull();
  });

  test("bad requests are refused before any provider call", async () => {
    const cases: [unknown, string][] = [
      [{ text: "x", count: 1 }, "count must be 2 to 4."],
      [{ text: "x", count: 5 }, "count must be 2 to 4."],
      [{ text: " ", count: 2 }, "text must be a non-empty string."],
      [{ text: "x", count: 2, models: ["anthropic:a"] }, 'models must be a list of 2 "<provider>:<model>" values.'],
      [{ text: "x", count: 2, models: ["anthropic:a", "anthropic:--help"] }, 'The model name "--help" is not valid.'],
      [{ text: "x", count: 2, models: ["anthropic:a", "nope:b"] }, 'Unknown provider "nope" in "nope:b".'],
      [{ text: "x", count: 2, target: "bad id" }, "target must be a data-oid or null."],
    ];
    for (const [body, error] of cases) {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe(error);
    }
    expect((await fetch(`${server.url}v/p/none`, { method: "POST", body: JSON.stringify({ text: "x", count: 2 }) })).status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  test("a renamed design takes its open variants along", async () => {
    await events(await post({ text: "x", count: 2 }));
    const { paths } = await renameDesign(config.workspace, "p", "d", "e");
    expect(paths.map((p) => relative(config.workspace, p))).toContain("projects/p/variants/e");
    expect(existsSync(variantsRoot(config.workspace, "p", "e"))).toBe(true);
    expect(existsSync(variantsRoot(config.workspace, "p", "d"))).toBe(false);
  });
});
