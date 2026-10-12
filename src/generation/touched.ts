import type { DesignFile } from "./context.ts";

/**
 * Which of `oids` a turn changed. An element changed when its own HTML changed (its start tag,
 * its text or anything inside it), or when a CSS rule that names it changed: a rule whose
 * selector has one of its classes, its id or its data-oid. A rule that names only a tag
 * (`button { … }`) does not count, because it changes many elements.
 */
export async function touchedOids(before: DesignFile[], after: DesignFile[], oids: string[]): Promise<Set<string>> {
  const wanted = new Set(oids);
  const old = await elements(before, wanted);
  const now = await elements(after, wanted);
  const selectors = changedSelectors(css(before), css(after));
  const touched = new Set<string>();
  for (const oid of wanted) {
    const a = old.get(oid);
    const b = now.get(oid);
    if (!a || !b) continue; // a new or a removed element is not "its element edited"
    if (a.source !== b.source || names(b).some((n) => selectors.some((s) => n.test(s)))) touched.add(oid);
  }
  return touched;
}

interface Element {
  /** Start tags and text of the element and everything inside it, in order. */
  source: string;
  classes: string[];
  id: string | null;
  oid: string;
}

const html = (files: DesignFile[]) => files.filter((f) => f.content !== null && /\.html?$/i.test(f.path));
const css = (files: DesignFile[]) =>
  files.filter((f) => f.content !== null && /\.css$/i.test(f.path)).map((f) => f.content!).join("\n");

async function elements(files: DesignFile[], wanted: Set<string>): Promise<Map<string, Element>> {
  const out = new Map<string, Element>();
  for (const f of html(files)) {
    const open: Element[] = [];
    await new HTMLRewriter()
      .on("*", {
        element(el) {
          const attrs = [...el.attributes].map(([k, v]) => `${k}="${v}"`).join(" ");
          for (const o of open) o.source += `<${el.tagName} ${attrs}>`;
          const oid = el.getAttribute("data-oid");
          if (!oid || !wanted.has(oid) || out.has(oid)) return;
          const e = element(oid, el, `<${el.tagName} ${attrs}>`);
          out.set(oid, e);
          if (!el.canHaveContent) return;
          open.push(e);
          el.onEndTag(() => {
            const at = open.lastIndexOf(e);
            if (at >= 0) open.splice(at, 1);
          });
        },
      })
      .onDocument({
        text(chunk) {
          for (const o of open) o.source += chunk.text;
        },
      })
      .transform(new Response(f.content!))
      .text();
  }
  return out;
}

function element(oid: string, el: HTMLRewriterTypes.Element, startTag: string): Element {
  return {
    source: startTag,
    classes: (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean),
    id: el.getAttribute("id"),
    oid,
  };
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Patterns that find the element in a selector. */
function names(e: Element): RegExp[] {
  const end = "(?![\\w-])";
  return [
    ...e.classes.map((c) => new RegExp(`\\.${escape(c)}${end}`)),
    ...(e.id ? [new RegExp(`#${escape(e.id)}${end}`)] : []),
    new RegExp(`\\[\\s*data-oid\\s*[~|^$*]?=\\s*["']?${escape(e.oid)}["']?\\s*\\]`),
  ];
}

/**
 * The selectors of the rules that were added, removed or changed. Rules inside at-rules
 * (`@media`) count with their own selector. Comments are ignored.
 */
export function changedSelectors(before: string, after: string): string[] {
  const a = rules(before);
  const b = rules(after);
  const changed = new Set<string>();
  for (const [key, body] of a) if (b.get(key) !== body) changed.add(key);
  for (const key of b.keys()) if (!a.has(key)) changed.add(key);
  return [...changed].map((key) => key.split(" >> ").at(-1)!);
}

/** "@media (x) >> .card" → the declarations of that rule, with spaces made even. */
function rules(css: string): Map<string, string> {
  const out = new Map<string, string>();
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const stack: { selector: string; body: string }[] = [];
  let buffer = "";
  for (const ch of text) {
    if (ch === "{") {
      stack.push({ selector: buffer.replace(/\s+/g, " ").trim(), body: "" });
      buffer = "";
    } else if (ch === "}") {
      const rule = stack.pop();
      if (!rule) {
        buffer = "";
        continue;
      }
      rule.body += buffer;
      buffer = "";
      const key = [...stack.map((r) => r.selector), rule.selector].join(" >> ");
      // The same selector twice: both bodies count, in order.
      const body = rule.body.replace(/\s+/g, " ").trim();
      out.set(key, out.has(key) ? `${out.get(key)} | ${body}` : body);
    } else {
      buffer += ch;
      // A declaration of the open rule ends at ";". A statement at the top (`@import …;`)
      // is not part of the next selector.
      if (ch === ";") {
        if (stack.length) stack.at(-1)!.body += buffer;
        buffer = "";
      }
    }
  }
  return out;
}
