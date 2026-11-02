/**
 * What `get_element` tells an agent about one element. `readElement()` runs inside the rendered
 * page (Chromium), so the box, the computed styles and the matched rules are the browser's own.
 */
export interface ElementInfo {
  oid: string;
  tag: string;
  attributes: Record<string, string>;
  /** The visible text, at most MAX_TEXT characters. */
  text: string;
  /** outerHTML, at most MAX_HTML characters; `htmlTruncated` when it was longer. */
  html: string;
  htmlTruncated: boolean;
  /** CSS pixels from the top left of the page, at the frame's width. */
  box: { x: number; y: number; width: number; height: number };
  visible: boolean;
  /** A short list of computed values that matter for a build. */
  styles: Record<string, string>;
  /** The style rules that match the element, in stylesheet order; at-rules around them in `within`. */
  rules: { selector: string; declarations: string; within?: string[] }[];
  rulesTruncated: boolean;
  /** The ancestors that have a data-oid, from the outermost to the parent. */
  path: { oid: string; tag: string }[];
  /** The nearest descendants that have a data-oid. */
  children: { oid: string; tag: string; text: string }[];
}

/**
 * Runs in the page: no imports, no closures over module values. Returns null when no element
 * has this data-oid.
 */
export function readElement(oid: string): ElementInfo | null {
  const MAX_TEXT = 500;
  const MAX_HTML = 20_000;
  const MAX_RULES = 60;
  const MAX_CHILDREN = 100;
  const STYLE_KEYS = [
    "display", "position", "box-sizing", "width", "height", "margin", "padding", "gap",
    "flex-direction", "flex-wrap", "justify-content", "align-items", "grid-template-columns", "grid-template-rows",
    "color", "background-color", "background-image", "font-family", "font-size", "font-weight", "line-height",
    "letter-spacing", "text-align", "text-transform", "border", "border-radius", "box-shadow", "opacity", "overflow", "z-index",
  ];

  const el = [...document.querySelectorAll("[data-oid]")].find((e) => e.getAttribute("data-oid") === oid);
  if (!el) return null;
  const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const textOf = (e: Element) => ((e as HTMLElement).innerText ?? e.textContent ?? "").replace(/\s+/g, " ").trim();

  const attributes: Record<string, string> = {};
  for (const a of el.attributes) attributes[a.name] = a.value;

  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const styles: Record<string, string> = {};
  for (const k of STYLE_KEYS) {
    const v = cs.getPropertyValue(k);
    if (v) styles[k] = v;
  }

  const rules: ElementInfo["rules"] = [];
  let rulesTruncated = false;
  const walk = (list: CSSRuleList, within: string[]) => {
    for (const rule of list) {
      if (rules.length >= MAX_RULES) {
        rulesTruncated = true;
        return;
      }
      if (rule instanceof CSSStyleRule) {
        let match = false;
        try {
          match = el.matches(rule.selectorText);
        } catch {}
        if (match) rules.push({ selector: rule.selectorText, declarations: rule.style.cssText, ...(within.length ? { within } : {}) });
        if (rule.cssRules?.length) walk(rule.cssRules, [...within, rule.selectorText]);
      } else if (rule instanceof CSSMediaRule) {
        if (matchMedia(rule.conditionText).matches) walk(rule.cssRules, [...within, `@media ${rule.conditionText}`]);
      } else if (rule instanceof CSSSupportsRule) {
        if (CSS.supports(rule.conditionText)) walk(rule.cssRules, [...within, `@supports ${rule.conditionText}`]);
      } else if (typeof CSSLayerBlockRule !== "undefined" && rule instanceof CSSLayerBlockRule) {
        walk(rule.cssRules, [...within, `@layer ${rule.name}`]);
      } else if (rule instanceof CSSImportRule && rule.styleSheet) {
        try {
          walk(rule.styleSheet.cssRules, within);
        } catch {}
      }
    }
  };
  for (const sheet of document.styleSheets) {
    try {
      walk(sheet.cssRules, []);
    } catch {} // a sheet from another origin (a font host) has no readable rules
  }

  const path: ElementInfo["path"] = [];
  for (let p = el.parentElement; p; p = p.parentElement) {
    const id = p.getAttribute("data-oid");
    if (id) path.unshift({ oid: id, tag: p.tagName.toLowerCase() });
  }

  const children: ElementInfo["children"] = [];
  const visit = (parent: Element) => {
    for (const c of parent.children) {
      if (children.length >= MAX_CHILDREN) return;
      const id = c.getAttribute("data-oid");
      if (id) children.push({ oid: id, tag: c.tagName.toLowerCase(), text: short(textOf(c), 80) });
      else visit(c);
    }
  };
  visit(el);

  const html = el.outerHTML;
  return {
    oid,
    tag: el.tagName.toLowerCase(),
    attributes,
    text: short(textOf(el), MAX_TEXT),
    html: html.slice(0, MAX_HTML),
    htmlTruncated: html.length > MAX_HTML,
    box: { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), width: Math.round(r.width), height: Math.round(r.height) },
    visible: r.width > 0 && r.height > 0 && cs.display !== "none" && cs.visibility !== "hidden",
    styles,
    rules,
    rulesTruncated,
    path,
    children,
  };
}
