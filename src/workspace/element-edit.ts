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

/** Stands in for the characters of a comment in a rule body. */
const MASK = "\u0001";

const ruleSelector = (oid: string) => `[data-oid="${oid}"]`;

/** A comment, or a string in double or single quotes (with escapes). One scan, so a quote in a comment does not count. */
const COMMENT_OR_STRING = /\/\*[\s\S]*?\*\/|"(?:[^"\\\n]|\\[\s\S])*"|'(?:[^'\\\n]|\\[\s\S])*'/g;

/**
 * The CSS with the same length, where comments are `comment` characters and the text in
 * strings is MASK (the quotes stay). Braces and ";" in either then do not count.
 */
const maskCss = (css: string, comment: string) =>
  css.replace(COMMENT_OR_STRING, (m) => (m.startsWith("/*") ? comment.repeat(m.length) : m[0] + MASK.repeat(m.length - 2) + m.at(-1)));

/**
 * Sets the declarations in the element's top-level rule. A missing rule goes at the end of
 * the file, so it comes after the rules it must override. A rule without declarations goes away.
 */
export function withElementStyle(css: string, oid: string, style: ElementStyle): string {
  if (!OID.test(oid)) throw new EditError("Invalid element id.");
  // Comments and strings can hold braces and selectors; mask them for the search (same length).
  // The selector itself has a string (`"card-1"`), so it is compared without the string mask.
  const plain = maskCss(css, " ");
  const noComments = css.replace(COMMENT_OR_STRING, (m) => (m.startsWith("/*") ? " ".repeat(m.length) : m));
  const selector = ruleSelector(oid);
  let depth = 0;
  let found: { start: number; open: number; close: number } | null = null;
  for (let i = 0; i < plain.length && !found; i++) {
    const ch = plain[i];
    if (ch === "{") {
      if (depth === 0) {
        const start = Math.max(plain.lastIndexOf("}", i), plain.lastIndexOf(";", i)) + 1;
        if (noComments.slice(start, i).trim() === selector) {
          // The matching brace: a nested rule (`& .child { … }`) is not the end of this one.
          let close = -1;
          for (let k = i + 1, d = 1; k < plain.length; k++) {
            if (plain[k] === "{") d++;
            else if (plain[k] === "}" && --d === 0) {
              close = k;
              break;
            }
          }
          if (close < 0) throw new EditError("styles.css has an open rule.", 409);
          if (plain.slice(i + 1, close).includes("{")) {
            throw new EditError(`The rule of ${oid} in styles.css has nested rules. Change it in the file.`, 409);
          }
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
  // The body as written, and the same body with its comments and strings masked: the search
  // runs on the masked one, the change goes into both at the same place. The mask is not
  // whitespace, so a trim keeps comments.
  let body = css.slice(found.open + 1, found.close);
  let bare = maskCss(body, MASK);
  /** Replaces `length` characters at `at`: the first `keep` of them stay (each copy its own), then `text`. */
  const splice = (at: number, length: number, keep: number, text: string) => {
    body = body.slice(0, at + keep) + text + body.slice(at + length);
    bare = bare.slice(0, at + keep) + text + bare.slice(at + length);
  };
  for (const [prop, value] of Object.entries(style) as [StyleProp, string | null][]) {
    // After the start of the body or a ";", so "max-width" is not "width".
    // Comments between the ";" and the property stay where they are.
    const m = new RegExp(`(^|;)([\\s${MASK}]*)${prop}\\s*:[^;]*(;?)`).exec(bare);
    if (m) {
      const [all, lead, space, end] = m as unknown as [string, string, string, string];
      if (value === null) splice(m.index, all.length, lead.length + space.replace(/\s*$/, "").length, "");
      else splice(m.index, all.length, lead.length + space.length, `${prop}: ${value}${end || ";"}`);
    } else if (value !== null) {
      const indent = /\n([ \t]+)\S/.exec(bare)?.[1] ?? "  ";
      const keep = bare.replace(/\s*$/, "").length;
      // A ";" only when the last declaration has none (a comment after it does not count).
      const last = bare.slice(0, keep).replace(new RegExp(`[\\s${MASK}]*$`), "");
      const semi = last.trim() && !last.endsWith(";") ? ";" : "";
      splice(keep, bare.length - keep, 0, `${semi}\n${indent}${prop}: ${value};\n`);
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
  /** The open parent element, as a unique node (null at the top of the page). */
  parent: object | null;
  tag: string;
  /** A void element (`<img>`) has no content and no end tag. */
  void: boolean;
}

/** The parent and the tag of each element with one of the ids. */
async function locate(html: string, oids: string[]): Promise<Map<string, Found[]>> {
  const found = new Map<string, Found[]>();
  const open: { tag: string; node: object }[] = [];
  await new HTMLRewriter()
    .on("*", {
      element(el) {
        const tag = el.tagName.toLowerCase();
        if (el.namespaceURI === HTML_NS) closeImplied(open, tag);
        const oid = el.getAttribute("data-oid");
        if (oid && oids.includes(oid)) {
          found.set(oid, [...(found.get(oid) ?? []), { parent: open.at(-1)?.node ?? null, tag, void: !el.canHaveContent }]);
        }
        if (!el.canHaveContent) return;
        const item = { tag, node: {} };
        open.push(item);
        el.onEndTag(() => {
          const at = open.lastIndexOf(item);
          if (at >= 0) open.splice(at);
        });
      },
    })
    .transform(new Response(html))
    .text();
  return found;
}

/**
 * True when `piece` is exactly one element `tag` with its own end tag (or one void element).
 * HTMLRewriter places a marker after an implied end (`<p>` without `</p>`) at the parent's end
 * tag or after a sibling, so a cut between markers must be checked before it is used.
 */
async function wholeElement(piece: string, tag: string, isVoid: boolean): Promise<boolean> {
  const open: { tag: string }[] = [];
  let top = 0;
  let text = false;
  await new HTMLRewriter()
    .on("*", {
      element(el) {
        const name = el.tagName.toLowerCase();
        if (el.namespaceURI === HTML_NS) closeImplied(open, name);
        if (!open.length) top++;
        if (!el.canHaveContent) return;
        const item = { tag: name };
        open.push(item);
        el.onEndTag(() => {
          const at = open.lastIndexOf(item);
          if (at >= 0) open.splice(at);
        });
      },
    })
    .onDocument({
      text(chunk) {
        if (!open.length && chunk.text.trim()) text = true;
      },
    })
    .transform(new Response(piece))
    .text();
  if (top !== 1 || text) return false;
  return isVoid || new RegExp(`</${tag}\\s*>$`, "i").test(piece);
}

export type Position = "before" | "after";

const NO_END_TAG = "This element has no end tag in the HTML, so it cannot move. Add the end tag, then try again.";

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
  // Markers around the element and at the target (around it for "after"); then cut and paste between them.
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
          else {
            el.before(mark("s"), { html: true });
            el.after(mark("t"), { html: true });
          }
        }
      },
    })
    .transform(new Response(html))
    .text();
  const between = (from: string, to: string) => {
    const x = marked.indexOf(mark(from));
    const y = marked.indexOf(mark(to));
    return x >= 0 && y > x ? marked.slice(x + mark(from).length, y) : null;
  };
  const piece = between("a", "b");
  if (piece === null || !(await wholeElement(piece, from.tag, from.void))) throw new EditError(NO_END_TAG, 409);
  if (position === "after") {
    const targetPiece = between("s", "t");
    if (targetPiece === null || !(await wholeElement(targetPiece.replace(mark("a"), "").replace(mark("b"), ""), to.tag, to.void))) {
      throw new EditError("The target has no end tag in the HTML. Drop the element before it, or add the end tag.", 409);
    }
  }
  const a = marked.indexOf(mark("a"));
  const b = marked.indexOf(mark("b"));
  // The whitespace before the element (its indent) moves with it.
  const space = /\s*$/.exec(marked.slice(0, a))![0];
  const rest = (marked.slice(0, a - space.length) + marked.slice(b + mark("b").length)).replace(mark("s"), "");
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
