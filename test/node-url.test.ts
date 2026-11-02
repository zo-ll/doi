import { expect, test } from "bun:test";
import { nodeQuery, nodeUrl, parseNodeQuery } from "../src/web/node-url.ts";

test("a node URL names the design, the page and the node", () => {
  const ref = { project: "sample", design: "home", page: "about.html", node: "hero-cta" };
  expect(nodeUrl("http://127.0.0.1:4317", ref)).toBe("http://127.0.0.1:4317/?project=sample&design=home&page=about.html&node=hero-cta");
  // the default page and a missing node are left out
  expect(nodeQuery({ ...ref, page: "index.html", node: null })).toBe("?project=sample&design=home");
  expect(parseNodeQuery(nodeQuery(ref))).toEqual(ref);
  expect(parseNodeQuery("?project=sample&design=home")).toEqual({ project: "sample", design: "home", page: "index.html", node: null });
});

test("bad parts of a node URL are left out; a bad design gives null", () => {
  expect(parseNodeQuery("")).toBeNull();
  expect(parseNodeQuery("?project=../etc&design=home")).toBeNull();
  expect(parseNodeQuery("?project=Sample&design=home")).toBeNull();
  const odd = parseNodeQuery("?project=a&design=b&page=../secret.html&node=x%22y");
  expect(odd).toEqual({ project: "a", design: "b", page: "index.html", node: null });
  expect(parseNodeQuery("?project=a&design=b&page=docs/./x.html")?.page).toBe("index.html");
  expect(parseNodeQuery("?project=a&design=b&page=docs/x.htm")?.page).toBe("docs/x.htm");
  expect(parseNodeQuery("?project=a&design=b&page=x.js")?.page).toBe("index.html");
});
