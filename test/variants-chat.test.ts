import { expect, test } from "bun:test";
import { applyVariantEvent, type VariantsMessage } from "../src/web/chat.ts";

test("variant events build one item per variant, with its own text, usage and status", () => {
  let m: VariantsMessage = { id: 1, kind: "variants", status: "running", items: [] };
  m = applyVariantEvent(m, { type: "variants", set: "s", variants: [{ n: 1, provider: "anthropic", model: "a" }, { n: 2, provider: "openai", model: "b" }] });
  m = applyVariantEvent(m, { type: "variant", n: 1, event: { type: "text", delta: "Blue" } });
  m = applyVariantEvent(m, { type: "variant", n: 1, event: { type: "usage", inputTokens: 10, outputTokens: 2, cachedTokens: 0 } });
  m = applyVariantEvent(m, { type: "variant", n: 1, event: { type: "usage", inputTokens: 5, outputTokens: 1, cachedTokens: 3 } });
  m = applyVariantEvent(m, { type: "variant", n: 1, event: { type: "done" } });
  m = applyVariantEvent(m, { type: "variant", n: 2, event: { type: "error", kind: "apply", message: "no match" } });
  expect(m.items).toEqual([
    { n: 1, model: "anthropic:a", status: "done", text: "Blue", usage: { inputTokens: 15, outputTokens: 3, cachedTokens: 3 } },
    { n: 2, model: "openai:b", status: "error", text: "", usage: null, error: "The changes could not be applied, so the design is unchanged. no match" },
  ]);
  expect(applyVariantEvent(m, { type: "variants-done", commit: "c" }).status).toBe("done");

  const failed = applyVariantEvent(
    { ...m, items: m.items.map((i) => ({ ...i, status: "error" as const })) },
    { type: "variants-done", commit: null, error: "No variant was made." },
  );
  expect(failed).toMatchObject({ status: "error", error: "No variant was made." });
});
