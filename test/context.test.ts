import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assembleContext,
  capabilitiesFor,
  ContextTooLargeError,
  estimateTokens,
  formatFiles,
  MAX_HISTORY_MESSAGES,
  OUTPUT_RESERVE_TOKENS,
  readDesignFiles,
  type ContextInput,
} from "../src/generation/context.ts";
import type { Message, Provider, ProviderCapabilities } from "../src/providers/types.ts";

const caps: ProviderCapabilities = {
  vision: true,
  toolUse: true,
  promptCache: "explicit",
  maxContextTokens: 200_000,
  editsFiles: false,
};

const user = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (text: string): Message => ({ role: "assistant", content: [{ type: "text", text }] });
const texts = (ms: Message[]) => ms.map((m) => (m.content[0] as { text: string }).text);

function input(over: Partial<ContextInput> = {}): ContextInput {
  return {
    systemPrompt: "RULES",
    designSystem: null,
    files: [
      { path: "index.html", content: "<h1 data-oid=\"title\">Hi</h1>" },
      { path: "styles.css", content: "h1 { color: red; }" },
    ],
    history: [],
    turn: { text: "Make it blue" },
    capabilities: caps,
    ...over,
  };
}

describe("assembleContext order", () => {
  test("system prompt, design system, files, then history and the new message", () => {
    const ctx = assembleContext(
      input({ designSystem: "TOKENS", history: [user("first"), assistant("done first")] }),
    );
    expect(ctx.system).toHaveLength(3);
    expect(ctx.system[0]).toBe("RULES");
    expect(ctx.system[1]).toBe("TOKENS");
    expect(ctx.system[2]).toStartWith("# Current design files");
    expect(ctx.system[2]!.indexOf("index.html")).toBeLessThan(ctx.system[2]!.indexOf("styles.css"));
    expect(texts(ctx.messages)).toEqual(["first", "done first", "Make it blue"]);
    expect(ctx.droppedMessages).toBe(0);
  });

  test("no design system leaves out its part", () => {
    expect(assembleContext(input({ designSystem: "  " })).system).toEqual(["RULES", expect.stringContaining("<file")]);
  });

  test("the selection and images go into the new message", () => {
    const data = new Uint8Array([1]);
    const ctx = assembleContext(input({ turn: { text: "Bigger", target: "cta", images: [{ mediaType: "image/png", data }] } }));
    expect(ctx.messages.at(-1)).toEqual({
      role: "user",
      content: [
        { type: "text", text: 'Target: data-oid="cta". Bigger' },
        { type: "image", mediaType: "image/png", data },
      ],
    });
  });

  test("images fail for a model without vision", () => {
    expect(() =>
      assembleContext(
        input({ capabilities: { ...caps, vision: false }, turn: { text: "x", images: [{ mediaType: "image/png", data: new Uint8Array() }] } }),
      ),
    ).toThrow("does not accept images");
  });

  test("binary files appear by name only", () => {
    expect(formatFiles([{ path: "assets/logo.png", content: null }])).toContain('<file path="assets/logo.png" binary="true" />');
    expect(formatFiles([])).toContain("The design is empty.");
  });
});

describe("assembleContext trimming", () => {
  test("drops the oldest history first when the budget is short", () => {
    const big = "x".repeat(3_000); // about 1000 tokens each
    const history = [user(`a${big}`), assistant(`b${big}`), user(`c${big}`), assistant(`d${big}`)];
    const base = assembleContext(input()).estimatedTokens;
    // Room for the fixed parts and about two and a half history messages.
    const maxContextTokens = OUTPUT_RESERVE_TOKENS + base + 2_500;
    const ctx = assembleContext(input({ history, capabilities: { ...caps, maxContextTokens } }));
    expect(texts(ctx.messages).map((t) => t[0])).toEqual(["c", "d", "M"]);
    expect(ctx.droppedMessages).toBe(2);
    expect(ctx.estimatedTokens).toBeLessThanOrEqual(maxContextTokens - OUTPUT_RESERVE_TOKENS);
  });

  test("the kept history starts with a user message", () => {
    const big = "x".repeat(3_000);
    const history = [user(`a${big}`), assistant(`b${big}`), user(`c${big}`), assistant(`d${big}`)];
    const base = assembleContext(input()).estimatedTokens;
    // Room for three messages: b, c and d fit, but b is an assistant message at the start.
    const ctx = assembleContext(input({ history, capabilities: { ...caps, maxContextTokens: OUTPUT_RESERVE_TOKENS + base + 3_100 } }));
    expect(texts(ctx.messages).map((t) => t[0])).toEqual(["c", "d", "M"]);
    expect(ctx.droppedMessages).toBe(2);
  });

  test("keeps at most MAX_HISTORY_MESSAGES", () => {
    const history = Array.from({ length: 30 }, (_, i) => (i % 2 ? assistant(`a${i}`) : user(`u${i}`)));
    const ctx = assembleContext(input({ history }));
    expect(ctx.messages).toHaveLength(MAX_HISTORY_MESSAGES + 1);
    expect(texts(ctx.messages)[0]).toBe("u10");
    expect(ctx.droppedMessages).toBe(30 - MAX_HISTORY_MESSAGES);
  });

  test("a request that is too large without history is a clear error", () => {
    const files = [{ path: "index.html", content: "x".repeat(3 * 200_000) }];
    expect(() => assembleContext(input({ files }))).toThrow(ContextTooLargeError);
    expect(() => assembleContext(input({ files }))).toThrow(/about \d+ tokens, but this model takes 200000/);
  });

  test("estimateTokens errs on the high side for code", () => {
    expect(estimateTokens("abcdef")).toBe(2);
    expect(estimateTokens("abcdefg")).toBe(3);
  });
});

describe("capabilitiesFor", () => {
  test("uses forModel when the provider has it", () => {
    const base = { id: "opencode-go", capabilities: caps, generate: async function* () {} } as Provider;
    expect(capabilitiesFor(base, "m")).toBe(caps);
    const small = { ...caps, maxContextTokens: 8_000 };
    expect(capabilitiesFor({ ...base, forModel: () => small }, "m")).toBe(small);
  });
});

describe("readDesignFiles", () => {
  test("reads text files, names binary files, skips hidden ones, index.html and styles.css first", async () => {
    const dir = await mkdtemp(join(tmpdir(), "doi-ctx-"));
    await mkdir(join(dir, "assets"));
    await mkdir(join(dir, ".hidden"));
    await Bun.write(join(dir, "styles.css"), "css");
    await Bun.write(join(dir, "about.html"), "about");
    await Bun.write(join(dir, "index.html"), "index");
    await Bun.write(join(dir, "assets", "logo.png"), new Uint8Array([137, 80]));
    await Bun.write(join(dir, "assets", "icon.svg"), "<svg/>");
    await Bun.write(join(dir, ".DS_Store"), "x");
    await Bun.write(join(dir, ".hidden", "a.css"), "x");
    expect(await readDesignFiles(dir)).toEqual([
      { path: "index.html", content: "index" },
      { path: "styles.css", content: "css" },
      { path: "about.html", content: "about" },
      { path: "assets/icon.svg", content: "<svg/>" },
      { path: "assets/logo.png", content: null },
    ]);
  });
});
