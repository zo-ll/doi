import { expect, test } from "bun:test";
import { timeAgo } from "../src/web/components/HistoryPanel.tsx";
import { versionKind } from "../src/web/history.ts";

test("timeAgo is short for recent versions and a date for old ones", () => {
  const now = Date.parse("2026-10-12T12:00:00Z");
  expect(timeAgo("2026-10-12T11:59:30Z", now)).toBe("just now");
  expect(timeAgo("2026-10-12T11:55:00Z", now)).toBe("5 min ago");
  expect(timeAgo("2026-10-12T09:00:00Z", now)).toBe("3 h ago");
  expect(timeAgo("2026-10-01T09:00:00Z", now)).toMatch(/2026/);
  expect(timeAgo("not a date", now)).toBe("");
  // A clock that is a little behind does not give "in the future".
  expect(timeAgo("2026-10-12T12:00:05Z", now)).toBe("just now");
});

test("the kind of a version comes from its commit message", () => {
  expect(versionKind("Make the title larger")).toBe("turn");
  expect(versionKind("Restore abc1234: Make the title larger")).toBe("restore");
  expect(versionKind("Pick variant 2: A calmer hero")).toBe("pick");
  expect(versionKind("Rename design home to landing")).toBe("rename");
  expect(versionKind("Create design pricing")).toBe("create");
  expect(versionKind("Tweaks: --accent, --radius")).toBe("tweak");
  // A prompt that only starts like one of them is a turn.
  for (const prompt of ["Restore the old hero", "Pick variant colors that fit", "Rename design labels to plain words", "Create design tokens for spacing"]) {
    expect(versionKind(prompt)).toBe("turn");
  }
});
