import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { designEvents, designOf, watchDesigns, type DesignChange, type DesignWatcher } from "../src/workspace/watch.ts";

let watcher: DesignWatcher | undefined;
afterEach(() => watcher?.close());

async function setup() {
  const ws = await mkdtemp(join(tmpdir(), "doi-watch-"));
  const dir = join(ws, "projects", "p", "designs", "d");
  await mkdir(join(dir, "assets"), { recursive: true });
  await Bun.write(join(dir, "index.html"), "<h1>Hi</h1>");
  watcher = watchDesigns(ws, 100);
  const seen: { change: DesignChange }[] = [];
  watcher.subscribe((change) => seen.push({ change }));
  await Bun.sleep(50); // let the watcher start
  return { ws, dir, seen };
}

describe("designOf", () => {
  test("maps design files and ignores the rest", () => {
    expect(designOf("p/designs/d/styles.css")).toEqual({ project: "p", design: "d" });
    expect(designOf("p/designs/d/assets/a.png")).toEqual({ project: "p", design: "d" });
    expect(designOf("p/chat.jsonl")).toBeNull();
    expect(designOf("p/designs/d")).toBeNull();
    expect(designOf("p/project.json")).toBeNull();
    expect(designOf("P/designs/d/x.css")).toBeNull();
  });
});

describe("watchDesigns", () => {
  test("a change shows within one second, and a burst gives one event", async () => {
    const { dir, seen } = await setup();
    const start = performance.now();
    await Bun.write(join(dir, "styles.css"), "a");
    await Bun.write(join(dir, "index.html"), "<h1>Bye</h1>");
    await Bun.write(join(dir, "assets", "x.svg"), "<svg/>");
    for (let i = 0; i < 100 && seen.length === 0; i++) await Bun.sleep(10);
    const elapsed = performance.now() - start;
    await Bun.sleep(300); // a second event would arrive by now
    expect(seen.map((s) => s.change)).toEqual([{ project: "p", design: "d" }]);
    expect(elapsed).toBeLessThan(1_000);
  });

  test("other files of the project do not count", async () => {
    const { ws, seen } = await setup();
    await Bun.write(join(ws, "projects", "p", "chat.jsonl"), "{}\n");
    await Bun.sleep(300);
    expect(seen).toEqual([]);
  });

  test("a held design sends one event when it is released", async () => {
    const { dir, seen } = await setup();
    watcher!.hold({ project: "p", design: "d" });
    await Bun.write(join(dir, "styles.css"), "a");
    await Bun.sleep(250);
    await Bun.write(join(dir, "styles.css"), "b");
    await Bun.sleep(250);
    expect(seen).toEqual([]);
    watcher!.release({ project: "p", design: "d" });
    await Bun.sleep(300);
    expect(seen.map((s) => s.change)).toEqual([{ project: "p", design: "d" }]);
  });

  test("a new design folder is watched too", async () => {
    const { ws, seen } = await setup();
    const other = join(ws, "projects", "q", "designs", "e");
    await mkdir(other, { recursive: true });
    await Bun.sleep(50);
    await Bun.write(join(other, "index.html"), "x");
    for (let i = 0; i < 100 && !seen.some((s) => s.change.project === "q"); i++) await Bun.sleep(10);
    expect(seen.map((s) => s.change)).toContainEqual({ project: "q", design: "e" });
  });
});

describe("designEvents", () => {
  test("streams design changes until the client goes away", async () => {
    const { dir } = await setup();
    const client = new AbortController();
    const res = designEvents(watcher!, new Request("http://x/api/events", { signal: client.signal }));
    expect(res.headers.get("content-type")).toStartWith("text/event-stream");
    const reader = res.body!.getReader();
    // Read in this process, the chunks are the strings that the stream enqueued.
    const next = async () => String((await reader.read()).value);
    expect(await next()).toBe(": connected\n\n");
    await Bun.write(join(dir, "styles.css"), "changed");
    expect(await next()).toBe('event: design-changed\ndata: {"project":"p","design":"d"}\n\n');
    client.abort();
    expect((await reader.read()).done).toBe(true);
  });
});
