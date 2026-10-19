import { rootTokens } from "../handoff/bundle.ts";
import { closeImplied, HTML_NS } from "../generation/oids.ts";

/**
 * Direct canvas edits (#66). A resize, a nudge or an align writes declarations into the
 * element's own rule `[data-oid="…"] { … }` in styles.css. A drag in the parent moves the
 * element before or after a sibling in the HTML. The rest of each file stays byte for byte.
 */

export class EditError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/** The properties a direct edit can set. */
export const STYLE_PROPS = ["width", "height", "margin-top", "margin-right", "margin-bottom", "margin-left", "align-self", "justify-self"] as const;
export type StyleProp = (typeof STYLE_PROPS)[number];
/** A value for each property to set; null removes the declaration. */
export type ElementStyle = Partial<Record<StyleProp, string | null>>;

export const OID = /^[A-Za-z0-9_-]{1,100}$/;
const LENGTH = /^-?\d{1,5}(\.\d{1,3})?px$/;
const VAR_REF = /^var\(--[A-Za-z0-9_-]{1,60}\)$/;
const ALIGN = new Set(["auto", "start", "center", "end", "stretch", "flex-start", "flex-end"]);

function validValue(prop: StyleProp, value: string): boolean {
  if (prop === "align-self" || prop === "justify-self") return ALIGN.has(value);
  if (value === "auto") return true;
  if (LENGTH.test(value)) return prop.startsWith("margin") || !value.startsWith("-");
  return prop.startsWith("margin") && VAR_REF.test(value);
}

/** Checks the style the UI sends: known properties, plain lengths, `auto`, a `var()` for margins, align keywords. */
export function checkStyle(raw: unknown): ElementStyle {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new EditError("style must be an object.");
  const entries = Object.entries(raw as Record<string, unknown>);
  if (!entries.length) throw new EditError("style has no properties.");
  const out: ElementStyle = {};
  for (const [prop, value] of entries) {
    if (!(STYLE_PROPS as readonly string[]).includes(prop)) throw new EditError(`"${prop}" cannot be edited on the canvas.`);
    if (value !== null && (typeof value !== "string" || !validValue(prop as StyleProp, value))) {
      throw new EditError(`The value of ${prop} is not valid.`);
    }
    out[prop as StyleProp] = value as string | null;
  }
  return out;
}

const ruleSelector = (oid: string) => `[data-oid="${oid}"]`;

/**
 * Sets the declarations in the element's top-level rule. A missing rule goes at the end of
 * the file, so it comes after the rules it must override. A rule without declarations goes away.
 */
export function withElementStyle(css: string, oid: string, style: ElementStyle): string {
  if (!OID.test(oid)) throw new EditError("Invalid element id.");
  // Comments can hold braces and selectors; blank them for the search (same length).
  const plain = css.replace(/\/\*[\s\S]*?\*\//g, (c) => " ".repeat(c.length));
  const selector = ruleSelector(oid);
  let depth = 0;
  let found: { start: number; open: number; close: number } | null = null;
  for (let i = 0; i < plain.length && !found; i++) {
    const ch = plain[i];
    if (ch === "{") {
      if (depth === 0) {
        const start = Math.max(plain.lastIndexOf("}", i), plain.lastIndexOf(";", i)) + 1;
        if (plain.slice(start, i).trim() === selector) {
          const close = plain.indexOf("}", i);
          if (close < 0) throw new EditError("styles.css has an open rule.", 409);
          found = { start, open: i, close };
        }
      }
      depth++;
    } else if (ch === "}") depth--;
  }
  const set = Object.entries(style).filter(([, v]) => v !== null) as [StyleProp, string][];
  if (!found) {
    if (!set.length) return css;
    const body = set.map(([p, v]) => `  ${p}: ${v};`).join("\n");
    return `${css}${css.endsWith("\n") || !css ? "" : "\n"}\n${selector} {\n${body}\n}\n`;
  }
  let body = css.slice(found.open + 1, found.close);
  for (const [prop, value] of Object.entries(style) as [StyleProp, string | null][]) {
    // After the start of the body or a ";", so "max-width" is not "width".
    const decl = new RegExp(`(^|;)(\\s*)${prop}\\s*:[^;]*(;?)`);
    if (decl.test(body)) {
      body = body.replace(decl, (_all, lead: string, space: string, end: string) => (value === null ? lead : `${lead}${space}${prop}: ${value}${end || ";"}`));
    } else if (value !== null) {
      const indent = /\n([ \t]+)\S/.exec(body)?.[1] ?? "  ";
      const trimmed = body.replace(/\s*$/, "");
      body = `${trimmed}${trimmed.trim() && !trimmed.endsWith(";") ? ";" : ""}\n${indent}${prop}: ${value};\n`;
    }
  }
  // Blank lines that a removed declaration left.
  body = body.replace(/\n[ \t]*(?=\n)/g, "");
  if (!body.replace(/;/g, "").trim()) {
    const end = css[found.close + 1] === "\n" ? found.close + 2 : found.close + 1;
    return css.slice(0, found.start).replace(/\n*$/, "\n") + css.slice(end).replace(/^\n+/, "");
  }
  return css.slice(0, found.open + 1) + body + css.slice(found.close);
}

interface Found {
  /** Position in the open-element stack's parent, as a unique node. */
  parent: object | null;
  /** False when the end tag was left out (`<li>` without `</li>`): such an element cannot be cut out. */
  closed: boolean;
}

/** The parent and the end tag of each element with one of the ids. */
async function locate(html: string, oids: string[]): Promise<Map<string, Found[]>> {
  const found = new Map<string, Found[]>();
  const open: { tag: string; node: object }[] = [];
  await new HTMLRewriter()
    .on("*", {
      element(el) {
        const tag = el.tagName.toLowerCase();
        if (el.namespaceURI === HTML_NS) closeImplied(open, tag);
        const oid = el.getAttribute("data-oid");
        let entry: Found | null = null;
        if (oid && oids.includes(oid)) {
          entry = { parent: open.at(-1)?.node ?? null, closed: !el.canHaveContent };
          found.set(oid, [...(found.get(oid) ?? []), entry]);
        }
        if (!el.canHaveContent) return;
        const item = { tag, node: {} };
        open.push(item);
        // One end tag handler per element: a second call replaces the first.
        el.onEndTag(() => {
          if (entry) entry.closed = true;
          const at = open.lastIndexOf(item);
          if (at >= 0) open.splice(at);
        });
      },
    })
    .transform(new Response(html))
    .text();
  return found;
}

export type Position = "before" | "after";

/** Moves the element `oid` before or after its sibling `target`. Both must have an end tag in the source. */
export async function moveElement(html: string, oid: string, target: string, position: Position): Promise<string> {
  if (!OID.test(oid) || !OID.test(target)) throw new EditError("Invalid element id.");
  if (oid === target) throw new EditError("An element cannot move next to itself.");
  const found = await locate(html, [oid, target]);
  const one = (id: string) => {
    const list = found.get(id) ?? [];
    if (!list.length) throw new EditError(`No element ${id} on this page.`, 404);
    if (list.length > 1) throw new EditError(`Two elements have the id ${id}.`, 409);
    return list[0]!;
  };
  const from = one(oid);
  const to = one(target);
  if (from.parent !== to.parent) throw new EditError(`${oid} and ${target} are not in the same parent.`, 409);
  if (!from.closed || (position === "after" && !to.closed)) {
    throw new EditError("This element has no end tag in the HTML, so it cannot move.", 409);
  }
  // Markers around the element and at the target; then cut and paste between them.
  const nonce = crypto.randomUUID();
  const mark = (name: string) => `<!--doi-move-${nonce}-${name}-->`;
  const marked = await new HTMLRewriter()
    .on("*", {
      element(el) {
        const id = el.getAttribute("data-oid");
        if (id === oid) {
          el.before(mark("a"), { html: true });
          el.after(mark("b"), { html: true });
        } else if (id === target) {
          if (position === "before") el.before(mark("t"), { html: true });
          else el.after(mark("t"), { html: true });
        }
      },
    })
    .transform(new Response(html))
    .text();
  const a = marked.indexOf(mark("a"));
  const b = marked.indexOf(mark("b"));
  if (a < 0 || b < a) throw new EditError("The element could not be cut out.", 409);
  // The whitespace before the element (its indent) moves with it.
  const space = /\s*$/.exec(marked.slice(0, a))![0];
  const piece = marked.slice(a + mark("a").length, b);
  const rest = marked.slice(0, a - space.length) + marked.slice(b + mark("b").length);
  const t = rest.indexOf(mark("t"));
  if (t < 0) throw new EditError("The target could not be found.", 409);
  const moved = position === "before" ? piece + space : space + piece;
  return rest.slice(0, t) + moved + rest.slice(t + mark("t").length);
}

export interface SpacingStep {
  px: number;
  /** The variable for this step, when the design or its design system has one. */
  var: string | null;
}

export interface SpacingScale {
  /** The smallest step: sizes snap to multiples of it. */
  unit: number;
  steps: SpacingStep[];
}

const DEFAULT_STEPS = [0, 4, 8, 12, 16, 24, 32, 48, 64, 96];
const SPACE_VAR = /^--(space|spacing|gap)(-|$)/i;
const PX = /^(\d*\.?\d+)(px|rem)$/;

/**
 * The spacing scale: the `--space-*`, `--spacing-*` and `--gap-*` variables on :root of the
 * stylesheets (design first, so its values win), in px (1rem = 16px). Without such variables, a 4 px scale.
 */
export function spacingScale(stylesheets: string[]): SpacingScale {
  const byPx = new Map<number, string>();
  for (const css of stylesheets) {
    for (const [name, raw] of rootTokens(css)) {
      if (!SPACE_VAR.test(name)) continue;
      const m = PX.exec(raw.trim());
      if (!m) continue;
      const px = Math.round(Number(m[1]) * (m[2] === "rem" ? 16 : 1) * 100) / 100;
      if (px <= 0 || px > 512 || byPx.has(px)) continue;
      byPx.set(px, name);
    }
  }
  if (!byPx.size) return { unit: 4, steps: DEFAULT_STEPS.map((px) => ({ px, var: null })) };
  const steps = [{ px: 0, var: null }, ...[...byPx].sort((x, y) => x[0] - y[0]).map(([px, name]) => ({ px, var: name }))];
  return { unit: Math.max(1, steps[1]!.px), steps };
}
