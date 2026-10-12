import { join } from "node:path";
import type { DesignFile } from "./context.ts";

/**
 * After a turn, each meaningful element of the design has a `data-oid`, and no two elements of
 * one design share one. Selection, comments and targeted edits depend on this.
 *
 * Only the start tags that change are written again; the rest of each file stays byte for byte,
 * so the model's next edits still find their oldText.
 */

/** Elements that get an id when they have none. The system prompt names the same kinds. */
const MEANINGFUL = new Set([
  "main", "header", "footer", "nav", "section", "article", "aside", "div", "form", "fieldset",
  "h1", "h2", "h3", "h4", "h5", "h6", "p", "blockquote", "figure", "figcaption",
  "ul", "ol", "li", "dl", "dt", "dd", "table", "thead", "tbody", "tfoot", "tr", "th", "td",
  "a", "button", "input", "textarea", "select", "label", "img", "picture", "video", "audio", "svg", "canvas", "iframe",
]);
/** Attributes that tell two elements without text apart, such as two images. */
const KEY_ATTRIBUTES = ["src", "alt", "href", "type", "name", "placeholder"];
const VALID = /^[A-Za-z0-9_-]{1,100}$/;
const HTML_NS = "http://www.w3.org/1999/xhtml";
const MAX_TEXT = 200;

/**
 * End tags that HTML may leave out: a start tag of one of these closes an open element of the
 * same group, unless one of the `scope` elements is open between them.
 */
const IMPLIED_END: { opens: string[]; closes: string[]; scope: string[] }[] = [
  { opens: ["li"], closes: ["li"], scope: ["ul", "ol", "menu"] },
  { opens: ["dt", "dd"], closes: ["dt", "dd"], scope: ["dl"] },
  { opens: ["tr"], closes: ["tr", "td", "th"], scope: ["table", "thead", "tbody", "tfoot"] },
  { opens: ["td", "th"], closes: ["td", "th"], scope: ["tr", "table"] },
  { opens: ["thead", "tbody", "tfoot"], closes: ["thead", "tbody", "tfoot", "tr", "td", "th"], scope: ["table"] },
  { opens: ["option"], closes: ["option"], scope: ["select", "datalist", "optgroup"] },
  {
    opens: ["address", "article", "aside", "blockquote", "details", "div", "dl", "fieldset", "figcaption", "figure",
      "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "main", "menu", "nav", "ol", "p", "pre",
      "section", "table", "ul"],
    closes: ["p"],
    scope: ["button", "table", "td", "th", "li", "dd", "dt"],
  },
];

function closeImplied(open: { tag: string }[], tag: string): void {
  for (const rule of IMPLIED_END) {
    if (!rule.opens.includes(tag)) continue;
    for (let i = open.length - 1; i >= 0; i--) {
      if (rule.scope.includes(open[i]!.tag)) break;
      if (rule.closes.includes(open[i]!.tag)) {
        open.splice(i);
        break;
      }
    }
  }
}

interface Node {
  file: string;
  /** Position in the file, in the order HTMLRewriter calls the element handler. */
  index: number;
  tag: string;
  /** The data-oid as written, or null. */
  oid: string | null;
  meaningful: boolean;
  /** Tag, text and key attributes: equal keys mean "the same element" across two versions. */
  key: string;
  text: string;
}

async function scan(file: string, html: string): Promise<Node[]> {
  const nodes: (Node & { attrs: string })[] = [];
  // Open elements. An end tag that HTML leaves implied (<li> without </li>) never fires, so
  // an end tag closes its own element and every element still open above it.
  const open: Node[] = [];
  let index = 0;
  const rewriter = new HTMLRewriter()
    .on("*", {
      element(el) {
        const tag = el.tagName.toLowerCase();
        if (el.namespaceURI === HTML_NS) closeImplied(open, tag);
        // Text of two elements must not run together: "Plans" + "Pay" is not "PlansPay".
        for (const o of open) if (o.text.length < MAX_TEXT) o.text += " ";
        const skipped = open.some((o) => o.tag === "template" || o.tag === "svg");
        const node = {
          file,
          index: index++,
          tag,
          oid: el.getAttribute("data-oid"),
          meaningful: MEANINGFUL.has(tag) && !skipped && (el.namespaceURI === HTML_NS || tag === "svg"),
          key: "",
          text: "",
          attrs: KEY_ATTRIBUTES.map((a) => `${a}=${el.getAttribute(a) ?? ""}`).join(" "),
        };
        nodes.push(node);
        if (!el.canHaveContent) return;
        open.push(node);
        el.onEndTag(() => {
          const at = open.lastIndexOf(node);
          if (at >= 0) open.splice(at);
          for (const o of open) if (o.text.length < MAX_TEXT) o.text += " ";
        });
      },
    })
    .onDocument({
      text(chunk) {
        for (const o of open) if (o.text.length < MAX_TEXT) o.text += chunk.text;
      },
    });
  await rewriter.transform(new Response(html)).text();
  return nodes.map(({ attrs, ...n }) => {
    const text = n.text.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
    return { ...n, text, key: `${n.tag}|${text}|${attrs}` };
  });
}

function newId(node: Node, used: Set<string>): string {
  const words = node.text.toLowerCase().match(/[a-z0-9]+/g)?.slice(0, 3) ?? [];
  const base = [node.tag, ...words].join("-").slice(0, 40).replace(/-+$/, "");
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
  return id;
}

export interface OidChanges {
  /** Elements that had no id or a duplicate, and got a new one. */
  added: string[];
  /** Ids the model dropped, put back on the same element. */
  restored: string[];
}

export interface FixedFile {
  path: string;
  content: string;
}

/**
 * Compares the HTML files of a design after a turn (`after`) with the files before it
 * (`before`), and returns the files that need changes, with their new content.
 * - An element that has a valid, unique id keeps it, also when the model changed it.
 * - A duplicate id stays on the element that had it before the turn (same tag, text and key
 *   attributes), else on the first one. The other elements get a new id.
 * - A meaningful element without an id gets back an id the model dropped when the tag, the
 *   text and the key attributes match the old element. Else it gets a new id.
 */
export async function fixOids(
  before: DesignFile[],
  after: DesignFile[],
): Promise<{ files: FixedFile[]; changes: OidChanges }> {
  const html = (files: DesignFile[]) => files.filter((f) => f.content !== null && /\.html?$/i.test(f.path));
  const oldNodes = (await Promise.all(html(before).map((f) => scan(f.path, f.content!)))).flat();
  const newFiles = html(after);
  const newNodes = (await Promise.all(newFiles.map((f) => scan(f.path, f.content!)))).flat();

  const oldById = new Map<string, Node>();
  for (const n of oldNodes) if (n.oid && VALID.test(n.oid) && !oldById.has(n.oid)) oldById.set(n.oid, n);

  // Which element keeps each valid id.
  const owners = new Map<string, Node>();
  for (const n of newNodes) {
    if (!n.oid || !VALID.test(n.oid)) continue;
    const owner = owners.get(n.oid);
    if (!owner) owners.set(n.oid, n);
    else if (owner.key !== oldById.get(n.oid)?.key && n.key === oldById.get(n.oid)?.key) owners.set(n.oid, n);
  }
  const used = new Set(owners.keys());

  // Ids from before the turn that no element has now, by key, in document order.
  const dropped = new Map<string, string[]>();
  for (const n of oldNodes) {
    if (!n.oid || used.has(n.oid) || oldById.get(n.oid) !== n) continue;
    dropped.set(n.key, [...(dropped.get(n.key) ?? []), n.oid]);
  }

  const needy = newNodes.filter((n) => {
    const hasValid = n.oid !== null && VALID.test(n.oid);
    const duplicate = hasValid && owners.get(n.oid!) !== n;
    return duplicate || !(hasValid || (n.oid === null && !n.meaningful));
  });
  const assigned = new Map<Node, string>();
  const changes: OidChanges = { added: [], restored: [] };
  // Restore first, so that a new id cannot take a dropped id that a later element needs.
  for (const n of needy) {
    const id = dropped.get(n.key)?.find((d) => !used.has(d));
    if (!id) continue;
    assigned.set(n, id);
    used.add(id);
    changes.restored.push(id);
  }
  // New ids also stay off every id from before the turn: comments on an old element must
  // not move to another one.
  const taken = new Set([...used, ...oldById.keys()]);
  for (const n of needy) {
    if (assigned.has(n)) continue;
    const id = newId(n, taken);
    assigned.set(n, id);
    taken.add(id);
    changes.added.push(id);
  }
  const plan = new Map<string, Map<number, string>>(); // file → element index → id
  for (const [n, id] of assigned) {
    if (!plan.has(n.file)) plan.set(n.file, new Map());
    plan.get(n.file)!.set(n.index, id);
  }

  const files: FixedFile[] = [];
  for (const f of newFiles) {
    const ids = plan.get(f.path);
    if (!ids) continue;
    let index = 0;
    const content = await new HTMLRewriter()
      .on("*", {
        element(el) {
          const id = ids.get(index++);
          if (id) el.setAttribute("data-oid", id);
        },
      })
      .transform(new Response(f.content!))
      .text();
    files.push({ path: f.path, content });
  }
  return { files, changes };
}

/** Fixes the ids in the design folder `dir` on disk. Returns the paths it changed. */
export async function fixDesignOids(dir: string, before: DesignFile[], after: DesignFile[]): Promise<string[]> {
  const { files } = await fixOids(before, after);
  for (const f of files) await Bun.write(join(dir, f.path), f.content);
  return files.map((f) => f.path);
}

/** The data-oids in the HTML files of a design. A comment on an id that is not here is detached. */
export async function designOids(files: DesignFile[]): Promise<Set<string>> {
  const html = files.filter((f) => f.content !== null && /\.html?$/i.test(f.path));
  const nodes = (await Promise.all(html.map((f) => scan(f.path, f.content!)))).flat();
  return new Set(nodes.flatMap((n) => (n.oid ? [n.oid] : [])));
}
