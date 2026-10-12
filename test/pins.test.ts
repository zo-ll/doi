import { expect, test } from "bun:test";
import type { CommentView } from "../src/server/comments.ts";
import { pinsOf } from "../src/web/comments.ts";

const c = (oid: string, status: "open" | "done" = "open", detached = false): CommentView => ({
  id: crypto.randomUUID(),
  oid,
  text: "x",
  status,
  version: null,
  createdAt: "",
  detached,
});

test("one pin per element with open comments; numbers follow the list", () => {
  expect(pinsOf([c("a"), c("b", "done"), c("a"), c("gone", "open", true), c("b")])).toEqual([
    { oid: "a", numbers: [1, 3] },
    { oid: "b", numbers: [5] },
  ]);
  expect(pinsOf([])).toEqual([]);
});
