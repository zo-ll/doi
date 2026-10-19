import { describe, expect, test } from "bun:test";
import { fileName, parseSearchReplace, SearchReplaceError, SearchReplaceParser, type ParsedEvent } from "../src/providers/search-replace.ts";

const block = (file: string, search: string, replace: string) =>
  `${file}\n<<<<<<< SEARCH\n${search}\n=======\n${replace}\n>>>>>>> REPLACE\n`;

const changes = (events: ParsedEvent[]) => events.filter((e) => e.type !== "text");
const text = (events: ParsedEvent[]) => events.flatMap((e) => (e.type === "text" ? [e.delta] : [])).join("");

describe("good blocks", () => {
  test("one edit, with the text around it", () => {
    const events = parseSearchReplace(`I made the card wider.\n\n${block("styles.css", ".card { width: 200px; }", ".card { width: 320px; }")}\nDone.`);
    expect(changes(events)).toEqual([{ type: "edit", file: "styles.css", oldText: ".card { width: 200px; }", newText: ".card { width: 320px; }" }]);
    expect(text(events)).toBe("I made the card wider.\n\n\nDone.");
  });

  test("many lines, indents and empty lines stay exact", () => {
    const search = "  <ul>\n    <li>One</li>\n\n  </ul>";
    const replace = "  <ul>\n    <li>One</li>\n    <li>Two</li>\n  </ul>";
    expect(changes(parseSearchReplace(block("index.html", search, replace)))).toEqual([
      { type: "edit", file: "index.html", oldText: search, newText: replace },
    ]);
  });

  test("an empty SEARCH writes the whole file; an empty REPLACE deletes", () => {
    const events = parseSearchReplace(
      `about.html\n<<<<<<< SEARCH\n=======\n<h1>About</h1>\n>>>>>>> REPLACE\n` + block("styles.css", ".old { }", ""),
    );
    expect(changes(events)).toEqual([
      { type: "write", file: "about.html", content: "<h1>About</h1>\n" },
      { type: "edit", file: "styles.css", oldText: ".old { }", newText: "" },
    ]);
  });

  test("many blocks; a block without a name is for the file before", () => {
    const events = parseSearchReplace(
      block("styles.css", "a", "b") + `<<<<<<< SEARCH\nc\n=======\nd\n>>>>>>> REPLACE\n` + block("pages/about.html", "e", "f"),
    );
    expect(changes(events).map((e) => e.file)).toEqual(["styles.css", "styles.css", "pages/about.html"]);
  });

  test("marker forms: 5 to 9 signs, no space, spaces around", () => {
    const events = parseSearchReplace(`styles.css\n<<<<<SEARCH\na\n  =========  \nb\n>>>>>>>>> REPLACE  \n`);
    expect(changes(events)).toEqual([{ type: "edit", file: "styles.css", oldText: "a", newText: "b" }]);
  });

  test("file name forms", () => {
    for (const line of ["styles.css", "**styles.css**", "`styles.css`", "### styles.css", "File: styles.css", "styles.css:", "./styles.css", "```styles.css"]) {
      expect(fileName(line)).toBe("styles.css");
    }
    for (const line of ["I changed styles.css", "styles", "```css", "", "a b.css"]) expect(fileName(line)).toBeNull();
  });

  test("streamed in small pieces: the same events, text only in whole lines", () => {
    const reply = `Wider card.\n${block("styles.css", ".a { }", ".b { }")}Done.`;
    for (const size of [1, 3, 7]) {
      const p = new SearchReplaceParser();
      const events: ParsedEvent[] = [];
      for (let i = 0; i < reply.length; i += size) events.push(...p.push(reply.slice(i, i + size)));
      events.push(...p.end());
      expect(changes(events)).toEqual(changes(parseSearchReplace(reply)));
      expect(text(events)).toBe("Wider card.\nDone.");
    }
  });

  test("a reply without blocks is all text", () => {
    const reply = "No change is needed.\n\n```css\n.a { color: red; }\n```\n=======\nEnd";
    const events = parseSearchReplace(reply);
    expect(changes(events)).toEqual([]);
    expect(text(events)).toBe(reply);
  });
});

describe("blocks inside code fences", () => {
  test("a fence after the file name", () => {
    const events = parseSearchReplace("Here:\nstyles.css\n```css\n<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE\n```\nDone.\n");
    expect(changes(events)).toEqual([{ type: "edit", file: "styles.css", oldText: "a", newText: "b" }]);
    expect(text(events)).toBe("Here:\nDone.\n");
  });

  test("a fence before the file name", () => {
    const events = parseSearchReplace("```\nstyles.css\n<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE\n```\n");
    expect(changes(events)).toEqual([{ type: "edit", file: "styles.css", oldText: "a", newText: "b" }]);
    expect(text(events)).toBe("");
  });

  test("the file name as the fence info, and fences with ~~~", () => {
    const events = parseSearchReplace("```index.html\n<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE\n```\n~~~\nstyles.css\n<<<<<<< SEARCH\nc\n=======\nd\n>>>>>>> REPLACE\n~~~\n");
    expect(changes(events).map((e) => e.file)).toEqual(["index.html", "styles.css"]);
    expect(text(events)).toBe("");
  });

  test("fence lines inside a block are content", () => {
    const events = parseSearchReplace(block("notes.md", "```js\nold()\n```", "```js\nnew()\n```"));
    expect(changes(events)).toEqual([{ type: "edit", file: "notes.md", oldText: "```js\nold()\n```", newText: "```js\nnew()\n```" }]);
  });
});

describe("review fixes", () => {
  test("a fence with a file name right after a block opens the next block for that file", () => {
    const events = parseSearchReplace(block("styles.css", "a", "b") + "```index.html\n<<<<<<< SEARCH\nc\n=======\nd\n>>>>>>> REPLACE\n```\n");
    expect(changes(events).map((e) => e.file)).toEqual(["styles.css", "index.html"]);
    expect(text(events)).toBe("");
  });

  test("a code sample right after a block keeps its opening fence", () => {
    const events = parseSearchReplace(block("styles.css", "a", "b") + "```css\n.card { }\n```\nDone.");
    expect(text(events)).toBe("```css\n.card { }\n```\nDone.");
  });

  test("many empty lines and fences between the file name and SEARCH", () => {
    const reply = block("styles.css", "a", "b") + "Then the page:\nindex.html\n\n\n\n\n```\n\n<<<<<<< SEARCH\nc\n=======\nd\n>>>>>>> REPLACE\n";
    const events = parseSearchReplace(reply);
    expect(changes(events).map((e) => e.file)).toEqual(["styles.css", "index.html"]);
    expect(text(events)).toBe("Then the page:\n");
  });

  test("a held line goes out as text when the next text line comes", () => {
    const p = new SearchReplaceParser();
    expect(text(p.push("First line\n"))).toBe("");
    expect(text(p.push("\n\n"))).toBe("");
    expect(text(p.push("Second line\n"))).toBe("First line\n\n\n");
    expect(text(p.end())).toBe("Second line\n");
  });

  test("a reply that ends with a CR has no CR in the text", () => {
    const p = new SearchReplaceParser();
    const events = [...p.push("Done.\r"), ...p.end()];
    expect(text(events)).toBe("Done.");
  });

  test("a long run of empty lines stays fast and gives the same text", () => {
    const reply = `Intro\n${"\n".repeat(100_000)}${block("styles.css", "a", "b")}`;
    const p = new SearchReplaceParser();
    const started = performance.now();
    const events: ParsedEvent[] = [];
    for (const line of reply.split(/(?<=\n)/)) events.push(...p.push(line));
    events.push(...p.end());
    expect(performance.now() - started).toBeLessThan(2000);
    expect(changes(events)).toEqual([{ type: "edit", file: "styles.css", oldText: "a", newText: "b" }]);
    expect(text(events)).toBe("Intro\n" + "\n".repeat(100_000));
  });

  test("CRLF line ends", () => {
    const events = parseSearchReplace("Done.\r\nstyles.css\r\n<<<<<<< SEARCH\r\na\r\nb\r\n=======\r\nc\r\n>>>>>>> REPLACE\r\n");
    expect(changes(events)).toEqual([{ type: "edit", file: "styles.css", oldText: "a\nb", newText: "c" }]);
    expect(text(events)).toBe("Done.\n");
  });
});

describe("broken blocks", () => {
  const broken = (reply: string, message: string) => {
    expect(() => parseSearchReplace(reply)).toThrow(SearchReplaceError);
    expect(() => parseSearchReplace(reply)).toThrow(message);
  };

  test("no file name", () => broken("<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE\n", "no file name"));
  test("a sentence is not a file name", () => broken("I changed the card:\n<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE\n", "no file name"));
  test("the reply stops inside SEARCH", () => broken("styles.css\n<<<<<<< SEARCH\na\n", 'block for "styles.css" has no ======= line'));
  test("the reply stops inside REPLACE", () => broken("styles.css\n<<<<<<< SEARCH\na\n=======\nb", "has no >>>>>>> REPLACE line"));
  test("REPLACE without a divider", () => broken("styles.css\n<<<<<<< SEARCH\na\n>>>>>>> REPLACE\n", "has no ======= line"));
  test("a new SEARCH inside a block", () => broken("styles.css\n<<<<<<< SEARCH\na\n=======\nb\n<<<<<<< SEARCH\n", "has no >>>>>>> REPLACE line"));
  test("two dividers", () => broken("styles.css\n<<<<<<< SEARCH\na\n=======\nb\n=======\nc\n>>>>>>> REPLACE\n", "has no >>>>>>> REPLACE line"));
  test("REPLACE without a block", () => broken("Done.\n>>>>>>> REPLACE\n", "no SEARCH block before it"));
});
