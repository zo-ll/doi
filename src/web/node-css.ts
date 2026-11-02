/** One style rule that matches the element; `within`: the grouping rules around it, outermost first. */
export interface CssRule {
  selector: string;
  declarations: string;
  within: string[];
  /** The stylesheet: a file of the design, "design system <name>/<file>", or "<style>". */
  source: string;
}

export interface NodeCss {
  rules: CssRule[];
  /** The element's style attribute. */
  inline: string;
}

/**
 * Reads the CSS of the element with this data-oid from a document: the style rules whose
 * selector matches it, in stylesheet order, with the grouping rules around them (a @media that
 * does not apply at this width too), and its style attribute. Null when no element has the oid.
 *
 * The document comes from a hidden same-origin iframe without scripts (NodeCssBlock): the
 * design frames have the origin "null", so their stylesheets are cross-origin and unreadable.
 * Self-contained and duck-typed (no instanceof: the rules come from another window), so a test
 * can run it in a browser page as it is.
 */
export function readNodeCss(doc: Document, oid: string): NodeCss | null {
  const MAX_RULES = 60;
  const MAX_TEXT = 4000;
  const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const el = [...doc.querySelectorAll("[data-oid]")].find((e) => e.getAttribute("data-oid") === oid);
  if (!el) return null;
  const sourceOf = (sheet: CSSStyleSheet) => {
    if (!sheet.href) return "<style>";
    try {
      const parts = new URL(sheet.href).pathname.split("/").filter(Boolean);
      return parts[0] === "ds" ? `design system ${parts.slice(1).join("/")}` : (parts.at(-1) ?? sheet.href);
    } catch {
      return sheet.href;
    }
  };
  const rules: CssRule[] = [];
  type AnyRule = CSSRule & { selectorText?: string; style?: CSSStyleDeclaration; cssRules?: CSSRuleList; styleSheet?: CSSStyleSheet | null; conditionText?: string; name?: string; href?: string };
  // A nested rule (`.card { & .inner {} }`) has a relative selector: `&` stands for the parent,
  // and no `&` means a descendant of it. `parent` is the resolved selector of the rule around it.
  // The items of a selector list, split at commas outside parentheses, brackets and quotes.
  const items = (selector: string) => {
    const out: string[] = [];
    let depth = 0;
    let quote: string | null = null;
    let start = 0;
    for (let i = 0; i < selector.length; i++) {
      const c = selector[i]!;
      if (quote) {
        if (c === "\\") i++;
        else if (c === quote) quote = null;
      } else if (c === '"' || c === "'") quote = c;
      else if (c === "(" || c === "[") depth++;
      else if (c === ")" || c === "]") depth = Math.max(0, depth - 1);
      else if (c === "," && depth === 0) {
        out.push(selector.slice(start, i));
        start = i + 1;
      }
    }
    out.push(selector.slice(start));
    return out.map((s) => s.trim()).filter(Boolean);
  };
  const resolve = (selector: string, parent: string | null) =>
    parent === null
      ? selector
      : items(selector)
          .map((s) => (s.includes("&") ? s.replace(/&/g, `:is(${parent})`) : `:is(${parent}) ${s}`))
          .join(", ");
  // `parentMatch`: the style rule around this list matches the element, so declarations nested in
  // it (CSSNestedDeclarations, for example inside `.card { @media (…) { color: red } }`) apply.
  const walk = (list: CSSRuleList, within: string[], source: string, parent: string | null, parentMatch: boolean) => {
    for (const rule of [...list] as AnyRule[]) {
      if (rules.length >= MAX_RULES) return;
      if (typeof rule.selectorText === "string" && rule.style) {
        const full = resolve(rule.selectorText, parent);
        let match = false;
        try {
          match = el.matches(full);
        } catch {}
        // A rule that only holds nested rules has no declarations of its own.
        if (match && rule.style.length > 0) rules.push({ selector: cut(rule.selectorText, 2000), declarations: cut(rule.style.cssText, MAX_TEXT), within, source });
        if (rule.cssRules?.length) walk(rule.cssRules, [...within, cut(rule.selectorText, 300)], source, full, match);
      } else if (rule.constructor?.name === "CSSNestedDeclarations" && rule.style) {
        if (parentMatch && rule.style.length > 0) rules.push({ selector: "&", declarations: cut(rule.style.cssText, MAX_TEXT), within, source });
      } else if (rule.styleSheet !== undefined && typeof rule.href === "string") {
        try {
          if (rule.styleSheet) walk(rule.styleSheet.cssRules, within, sourceOf(rule.styleSheet), parent, parentMatch);
        } catch {}
      } else if (rule.cssRules?.length) {
        const at = (rule.cssText.match(/^@[\w-]+/) ?? ["@rule"])[0];
        const label = rule.conditionText ? `${at} ${rule.conditionText}` : rule.name ? `${at} ${rule.name}` : at;
        walk(rule.cssRules, [...within, cut(label, 300)], source, parent, parentMatch);
      }
    }
  };
  for (const sheet of [...doc.styleSheets]) {
    try {
      walk(sheet.cssRules, [], sourceOf(sheet), null, false);
    } catch {} // a sheet from another origin (a font host) has no readable rules
  }
  return { rules, inline: cut(el.getAttribute("style") ?? "", MAX_TEXT) };
}

/** The declarations of a rule, one per line; a ";" inside quotes or parentheses (a string, a url) stays. */
export function declarationLines(declarations: string): string[] {
  const out: string[] = [];
  let quote: string | null = null;
  let depth = 0;
  let start = 0;
  for (let i = 0; i < declarations.length; i++) {
    const c = declarations[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (c === ";" && depth === 0) {
      out.push(declarations.slice(start, i));
      start = i + 1;
    }
  }
  out.push(declarations.slice(start));
  return out.map((d) => d.trim()).filter(Boolean);
}

/**
 * The CSS of a node as the side panel shows it: each matching rule with its source file and
 * the grouping rules around it, then the style attribute, as browser dev tools show it.
 */
export function formatNodeCss(css: NodeCss): string {
  const blocks: string[] = [];
  if (css.inline.trim()) blocks.push(["/* style attribute */", "element.style {", ...declarationLines(css.inline).map((d) => `  ${d};`), "}"].join("\n"));
  for (const r of css.rules) {
    const pad = (n: number) => "  ".repeat(n);
    const lines = [`/* ${r.source} */`];
    r.within.forEach((w, i) => lines.push(`${pad(i)}${w} {`));
    const depth = r.within.length;
    lines.push(`${pad(depth)}${r.selector} {`);
    for (const d of declarationLines(r.declarations)) lines.push(`${pad(depth + 1)}${d};`);
    lines.push(`${pad(depth)}}`);
    for (let i = depth - 1; i >= 0; i--) lines.push(`${pad(i)}}`);
    blocks.push(lines.join("\n"));
  }
  return blocks.join("\n\n");
}
