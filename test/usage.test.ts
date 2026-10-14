import { expect, test } from "bun:test";
import { costOf, formatCount, summarize } from "../src/web/usage.ts";

const e = (at: string, provider: string, model: string, input: number, output: number, cached = 0, project = "a", design = "home") => ({
  at,
  project,
  design,
  provider,
  model,
  inputTokens: input,
  outputTokens: output,
  cachedTokens: cached,
});
const billing = (p: string) => (p === "claude-code" ? "subscription" : p === "ollama" ? "local" : "api") as "subscription" | "api" | "local";
const now = Date.parse("2026-10-14T12:00:00Z");

test("cost: uncached input, cached input and output, per 1M tokens", () => {
  expect(costOf({ inputTokens: 1_000_000, outputTokens: 100_000, cachedTokens: 400_000 }, { input: 3, output: 15, cached: 0.3 })).toBeCloseTo(1.8 + 0.12 + 1.5);
  expect(costOf({ inputTokens: 1000, outputTokens: 0, cachedTokens: 1000 }, { input: 2, output: 8 })).toBeCloseTo(0.002);
  expect(costOf({ inputTokens: 1, outputTokens: 1, cachedTokens: 0 }, undefined)).toBeNull();
});

test("totals, groups and days in the range; subscriptions and local models have no cost", () => {
  const entries = [
    e("2026-10-14T10:00:00Z", "claude-code", "opus", 1000, 200, 500),
    e("2026-10-13T10:00:00Z", "anthropic", "big", 1_000_000, 0, 0, "b", "deck"),
    e("2026-10-13T11:00:00Z", "openai", "nopriced", 10, 10),
    e("2026-10-12T10:00:00Z", "ollama", "qwen", 300, 30),
    e("2026-09-01T10:00:00Z", "anthropic", "big", 5, 5),
  ];
  const s = summarize(entries, billing, { "anthropic:big": { input: 3, output: 15 } }, "model", 7, now, { provider: (p) => p.toUpperCase() });
  expect([s.input, s.output, s.cached]).toEqual([1_001_310, 240, 500]);
  expect(s.cost).toBeCloseTo(3);
  expect(s.unpriced).toBe(1);
  expect(s.days).toHaveLength(7);
  expect(s.days.at(-1)).toEqual({ date: "2026-10-14", subscription: 1200, api: 0, local: 0 });
  expect(s.days.find((d) => d.date === "2026-10-13")).toEqual({ date: "2026-10-13", subscription: 0, api: 1_000_020, local: 0 });
  expect(s.rows.map((r) => [r.label, r.via, r.turns, r.billing, r.cost === null ? null : Math.round(r.cost)])).toEqual([
    ["big", "ANTHROPIC", 1, "api", 3],
    ["opus", "CLAUDE-CODE", 1, "subscription", null],
    ["qwen", "OLLAMA", 1, "local", null],
    ["nopriced", "OPENAI", 1, "api", null],
  ]);
  const byProject = summarize(entries, billing, {}, "project", null, now, { project: (id) => `P-${id}` });
  expect(byProject.rows.map((r) => [r.label, r.turns, r.billing])).toEqual([
    ["P-b", 1, "api"],
    ["P-a", 4, "mixed"],
  ]);
  expect(byProject.days[0]!.date).toBe("2026-09-01");
  const byDay = summarize(entries, billing, {}, "day", 7, now);
  expect(byDay.rows.map((r) => r.label)).toEqual(["2026-10-14", "2026-10-13", "2026-10-12"]);
});

test("short counts", () => {
  expect(formatCount(2_410_000)).toBe("2.41M");
  expect(formatCount(618_400)).toBe("618k");
  expect(formatCount(950)).toBe("950");
});
