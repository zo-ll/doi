import { describe, expect, test } from "bun:test";
import { SYSTEM_PROMPT } from "../src/generation/prompts.ts";

const text = SYSTEM_PROMPT.text;

/** The fenced blocks of one language, in order. */
function blocks(lang: string): string[] {
  return [...text.matchAll(new RegExp("```" + lang + "\\n([\\s\\S]*?)```", "g"))].map((m) => m[1]!);
}

/** The element tags and data-oid values of an HTML document, in order. */
function elements(html: string): { tag: string; oid: string | null }[] {
  const out: { tag: string; oid: string | null }[] = [];
  new HTMLRewriter().on("*", { element: (el) => void out.push({ tag: el.tagName, oid: el.getAttribute("data-oid") }) }).transform(html);
  return out;
}

// Elements that the prompt says carry no data-oid.
const NO_OID = new Set(["html", "head", "meta", "link", "title", "body", "strong", "em"]);

describe("system prompt", () => {
  test("is a versioned file with the required rules", () => {
    expect(SYSTEM_PROMPT.version).toBe("v3");
    for (const rule of ["index.html", "styles.css", "plain HTML and CSS", "data-oid", "Keep existing ids", "`edit`", "`write`"]) {
      expect(text).toContain(rule);
    }
    for (const topic of ["Spacing:", "Type:", "Contrast:", "Layout:"]) expect(text).toContain(topic);
  });

  test("tells how to write tweaks.json, with a valid example", () => {
    expect(text).toContain("`tweaks.json`");
    const json = blocks("json");
    expect(json).toHaveLength(1);
    const controls = (JSON.parse(json[0]!) as { controls: { var: string; type: string }[] }).controls;
    expect(controls.map((c) => c.type)).toEqual(["color", "slider", "select"]);
  });

  test("tells how to mark the slides of a deck for the PDF export", () => {
    expect(text).toContain("`data-slide`");
    expect(text).toContain("1920 by 1080 px");
  });

  test("the example HTML follows the data-oid rules", () => {
    const html = blocks("html");
    expect(html.length).toBeGreaterThan(0);
    for (const doc of html) {
      const els = elements(doc);
      const missing = els.filter((e) => !NO_OID.has(e.tag) && !e.oid).map((e) => e.tag);
      expect(missing).toEqual([]);
      const oids = els.flatMap((e) => (e.oid ? [e.oid] : []));
      expect(new Set(oids).size).toBe(oids.length);
      expect(oids.every((id) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(id))).toBe(true);
    }
  });

  test("the example has no scripts, style attributes or external URLs", () => {
    for (const doc of [...blocks("html"), ...blocks("css")]) {
      expect(doc).not.toMatch(/<script|\sstyle=|https?:\/\//);
    }
  });

  test("each example edit matches its file exactly once", () => {
    const files: Record<string, string> = { "index.html": blocks("html")[0]!, "styles.css": blocks("css")[0]! };
    const edits = [...text.matchAll(/You call `edit` on `([^`]+)`:\n\n- oldText: `([^`]+)`\n- newText: `([^`]+)`/g)];
    expect(edits.length).toBeGreaterThan(0);
    for (const [, file, oldText] of edits) {
      expect(files[file!]!.split(oldText!).length - 1).toBe(1);
    }
  });
});
