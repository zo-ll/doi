import { expect, test } from "bun:test";
import { APP_PROMPT, assembleContext } from "../src/generation/context.ts";
import { FRAME_GAP, screenFrames } from "../src/workspace/frames.ts";

test("a mobile app shows one phone frame per page, in a row", () => {
  expect(screenFrames(["index.html", "files.html"])).toEqual([
    { id: "screen-0", label: "index", width: 390, height: 844, x: 0, y: 0, page: "index.html" },
    { id: "screen-1", label: "files", width: 390, height: 844, x: 390 + FRAME_GAP, y: 0, page: "files.html" },
  ]);
  expect(screenFrames(Array.from({ length: 30 }, (_, i) => `s${i}.html`))).toHaveLength(24);
});

test("the model gets the app section only for a mobile app", () => {
  const input = {
    systemPrompt: "rules",
    files: [{ path: "index.html", content: "<main></main>" }],
    history: [],
    turn: { text: "add a files screen", target: null },
    capabilities: { vision: true, toolUse: true, promptCache: "automatic" as const, maxContextTokens: 100_000, editsFiles: false },
  };
  expect(assembleContext({ ...input, app: true }).system.slice(0, 2)).toEqual(["rules", APP_PROMPT]);
  expect(assembleContext(input).system).not.toContain(APP_PROMPT);
  expect(APP_PROMPT).toContain("add new pages");
});
