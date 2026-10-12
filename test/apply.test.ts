import { beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplyError, applyChanges, runTurn, type DesignRef, type TurnEvent } from "../src/generation/apply.ts";
import type { GenerateEvent, GenerateRequest, Provider } from "../src/providers/types.ts";
import { designDir } from "../src/workspace/paths.ts";

let ref: DesignRef;
let dir: string;
const HTML = '<main data-oid="main">\n  <h1 data-oid="title">Hi</h1>\n  <p data-oid="a">Same</p>\n  <p data-oid="b">Same</p>\n</main>\n';
const CSS = "h1 { color: red; }\n";

beforeEach(async () => {
  ref = { workspace: await mkdtemp(join(tmpdir(), "doi-apply-")), project: "p", design: "d" };
  dir = designDir(ref.workspace, ref.project, ref.design);
  await mkdir(dir, { recursive: true });
  await Bun.write(join(dir, "index.html"), HTML);
  await Bun.write(join(dir, "styles.css"), CSS);
});

const read = (file: string) => Bun.file(join(dir, file)).text();

describe("applyChanges", () => {
  test("an exact match is replaced, and later edits see earlier ones", async () => {
    const result = await applyChanges(ref, [
      { type: "edit", file: "styles.css", oldText: "color: red", newText: "color: blue" },
      { type: "edit", file: "styles.css", oldText: "color: blue", newText: "color: navy" },
      { type: "edit", file: "index.html", oldText: ">Hi<", newText: ">$& and $1<" },
    ]);
    expect(result).toEqual({ ok: true, files: ["styles.css", "index.html"] });
    expect(await read("styles.css")).toBe("h1 { color: navy; }\n");
    // newText is literal: "$&" is not a replacement pattern.
    expect(await read("index.html")).toContain(">$& and $1<");
  });

  test("write creates new files and folders", async () => {
    const result = await applyChanges(ref, [
      { type: "write", file: "assets/icon.svg", content: "<svg/>" },
      { type: "edit", file: "assets/icon.svg", oldText: "<svg/>", newText: "<svg></svg>" },
    ]);
    expect(result).toEqual({ ok: true, files: ["assets/icon.svg"] });
    expect(await read("assets/icon.svg")).toBe("<svg></svg>");
  });

  test("no match fails and changes nothing", async () => {
    const result = await applyChanges(ref, [
      { type: "edit", file: "styles.css", oldText: "color: red", newText: "color: blue" },
      { type: "edit", file: "index.html", oldText: "<h2>", newText: "<h3>" },
    ]);
    expect(result).toMatchObject({ ok: false, failures: [{ file: "index.html", reason: "no-match" }] });
    expect(await read("styles.css")).toBe(CSS);
  });

  test("two matches fail and change nothing", async () => {
    const result = await applyChanges(ref, [{ type: "edit", file: "index.html", oldText: ">Same<", newText: ">Other<" }]);
    expect(result).toMatchObject({ ok: false, failures: [{ reason: "many-matches", message: expect.stringContaining("2 times") }] });
    expect(await read("index.html")).toBe(HTML);
  });

  test("an edit of a missing file and an empty oldText fail", async () => {
    const result = await applyChanges(ref, [
      { type: "edit", file: "about.html", oldText: "x", newText: "y" },
      { type: "edit", file: "styles.css", oldText: "", newText: "y" },
    ]);
    expect(result).toMatchObject({ ok: false, failures: [{ reason: "missing" }, { reason: "empty" }] });
  });

  test("paths outside the design folder are refused", async () => {
    for (const file of ["../d2/index.html", "../../../../etc/passwd", "/../../x.css", ".."]) {
      const result = await applyChanges(ref, [{ type: "write", file, content: "x" }]);
      expect(result).toMatchObject({ ok: false, failures: [{ reason: "outside" }] });
    }
    expect(await readdir(join(ref.workspace, "projects", "p", "designs"))).toEqual(["d"]);
  });

  test("a failed write rolls back the files written before it", async () => {
    await mkdir(join(dir, "blocked.html")); // a folder where a file must go: the write fails
    const changes = [
      { type: "edit", file: "styles.css", oldText: "red", newText: "blue" },
      { type: "write", file: "new.html", content: "new" },
      { type: "write", file: "blocked.html", content: "x" },
    ] as const;
    await expect(applyChanges(ref, [...changes])).rejects.toThrow();
    expect(await read("styles.css")).toBe(CSS);
    expect(await Bun.file(join(dir, "new.html")).exists()).toBe(false);
  });
});

/** A provider that answers each call with the next list of events, and records the requests. */
function scripted(answers: GenerateEvent[][], editsFiles = false) {
  const requests: GenerateRequest[] = [];
  const provider: Provider = {
    id: "anthropic",
    capabilities: { vision: true, toolUse: true, promptCache: "explicit", maxContextTokens: 200_000, editsFiles },
    async *generate(req) {
      requests.push(req);
      const answer = answers[requests.length - 1];
      if (!answer) throw new Error("no more answers");
      yield* answer;
      yield { type: "done" };
    },
  };
  return { provider, requests };
}

const req: GenerateRequest = { model: "m", system: ["rules"], messages: [{ role: "user", content: [{ type: "text", text: "Blue" }] }] };

async function run(provider: Provider) {
  const events: TurnEvent[] = [];
  for await (const e of runTurn(provider, req, ref)) events.push(e);
  return events;
}

const bad = { type: "edit", file: "styles.css", oldText: "color: green", newText: "color: blue" } as const;
const good = { type: "edit", file: "styles.css", oldText: "color: red", newText: "color: blue" } as const;

describe("runTurn", () => {
  test("applies a good turn and ends with applied and one done", async () => {
    const { provider } = scripted([[{ type: "text", delta: "Done." }, good]]);
    const events = await run(provider);
    expect(events.map((e) => e.type)).toEqual(["text", "edit", "applied", "done"]);
    expect(await read("styles.css")).toBe("h1 { color: blue; }\n");
  });

  test("sends the error back one time, then applies the corrected turn", async () => {
    const { provider, requests } = scripted([[{ type: "text", delta: "Sure." }, bad], [good]]);
    const events = await run(provider);
    expect(events.map((e) => e.type)).toEqual(["text", "edit", "retry", "edit", "applied", "done"]);
    expect(requests).toHaveLength(2);
    const followUp = requests[1]!.messages.slice(-2);
    expect(followUp[0]).toMatchObject({ role: "assistant", content: [{ text: expect.stringContaining("edit styles.css") }] });
    expect(followUp[1]).toMatchObject({ role: "user", content: [{ text: expect.stringContaining("does not occur") }] });
    expect(await read("styles.css")).toBe("h1 { color: blue; }\n");
  });

  test("after a second failure it asks for a full rewrite of the failing file", async () => {
    const { provider, requests } = scripted([[bad], [bad], [{ type: "write", file: "styles.css", content: "h1 { color: blue; }\n" }]]);
    const events = await run(provider);
    expect(events.filter((e) => e.type === "retry")).toHaveLength(2);
    expect(requests[2]!.messages.at(-1)).toMatchObject({ content: [{ text: expect.stringContaining('Use write with the full new content for "styles.css"') }] });
    expect(await read("styles.css")).toBe("h1 { color: blue; }\n");
  });

  test("a third failure throws and leaves the files unchanged", async () => {
    const { provider } = scripted([[bad], [bad], [bad]]);
    await expect(run(provider)).rejects.toBeInstanceOf(ApplyError);
    expect(await read("styles.css")).toBe(CSS);
  });

  test("CLI backends are not applied again", async () => {
    const { provider, requests } = scripted([[bad]], true);
    const events = await run(provider);
    expect(events.map((e) => e.type)).toEqual(["edit", "done"]);
    expect(requests).toHaveLength(1);
    expect(await read("styles.css")).toBe(CSS);
  });
});
