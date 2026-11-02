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
  const walk = (list: CSSRuleList, within: string[], source: string) => {
    for (const rule of [...list] as AnyRule[]) {
      if (rules.length >= MAX_RULES) return;
      if (typeof rule.selectorText === "string" && rule.style) {
        let match = false;
        try {
          match = el.matches(rule.selectorText);
        } catch {}
        if (match) rules.push({ selector: cut(rule.selectorText, 2000), declarations: cut(rule.style.cssText, MAX_TEXT), within, source });
        if (rule.cssRules?.length) walk(rule.cssRules, [...within, cut(rule.selectorText, 300)], source);
      } else if (rule.styleSheet !== undefined && typeof rule.href === "string") {
        try {
          if (rule.styleSheet) walk(rule.styleSheet.cssRules, within, sourceOf(rule.styleSheet));
        } catch {}
      } else if (rule.cssRules?.length) {
        const at = (rule.cssText.match(/^@[\w-]+/) ?? ["@rule"])[0];
        const label = rule.conditionText ? `${at} ${rule.conditionText}` : rule.name ? `${at} ${rule.name}` : at;
        walk(rule.cssRules, [...within, cut(label, 300)], source);
      }
    }
  };
  for (const sheet of [...doc.styleSheets]) {
    try {
      walk(sheet.cssRules, [], sourceOf(sheet));
    } catch {} // a sheet from another origin (a font host) has no readable rules
  }
  return { rules, inline: cut(el.getAttribute("style") ?? "", MAX_TEXT) };
}

/** The declarations of a rule, one per line; a ";" inside a value (a string, a url) stays. */
export function declarationLines(declarations: string): string[] {
  return declarations
    .split(/;\s*(?=(?:--)?[A-Za-z][\w-]*\s*:)/)
    .map((d) => d.trim().replace(/;$/, "").trim())
    .filter(Boolean);
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
