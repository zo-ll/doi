import sans400_latin from "@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-400-normal.woff2" with { type: "file" };
import sans400_latin_ext from "@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-ext-400-normal.woff2" with { type: "file" };
import sans400_cyrillic from "@fontsource/ibm-plex-sans/files/ibm-plex-sans-cyrillic-400-normal.woff2" with { type: "file" };
import sans400_cyrillic_ext from "@fontsource/ibm-plex-sans/files/ibm-plex-sans-cyrillic-ext-400-normal.woff2" with { type: "file" };
import sans400_greek from "@fontsource/ibm-plex-sans/files/ibm-plex-sans-greek-400-normal.woff2" with { type: "file" };
import sans400_vietnamese from "@fontsource/ibm-plex-sans/files/ibm-plex-sans-vietnamese-400-normal.woff2" with { type: "file" };
import sans600_latin from "@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-600-normal.woff2" with { type: "file" };
import sans600_latin_ext from "@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-ext-600-normal.woff2" with { type: "file" };
import sans600_cyrillic from "@fontsource/ibm-plex-sans/files/ibm-plex-sans-cyrillic-600-normal.woff2" with { type: "file" };
import sans600_cyrillic_ext from "@fontsource/ibm-plex-sans/files/ibm-plex-sans-cyrillic-ext-600-normal.woff2" with { type: "file" };
import sans600_greek from "@fontsource/ibm-plex-sans/files/ibm-plex-sans-greek-600-normal.woff2" with { type: "file" };
import sans600_vietnamese from "@fontsource/ibm-plex-sans/files/ibm-plex-sans-vietnamese-600-normal.woff2" with { type: "file" };
import mono400_latin from "@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2" with { type: "file" };
import mono400_latin_ext from "@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-ext-400-normal.woff2" with { type: "file" };
import mono400_cyrillic from "@fontsource/ibm-plex-mono/files/ibm-plex-mono-cyrillic-400-normal.woff2" with { type: "file" };
import mono400_cyrillic_ext from "@fontsource/ibm-plex-mono/files/ibm-plex-mono-cyrillic-ext-400-normal.woff2" with { type: "file" };
import mono400_vietnamese from "@fontsource/ibm-plex-mono/files/ibm-plex-mono-vietnamese-400-normal.woff2" with { type: "file" };
import sansCssText from "@fontsource/ibm-plex-sans/400.css" with { type: "text" };

/** `src/web/fonts.d.ts` types every @fontsource import as any; this one is text. */
const sansCss: string = sansCssText;

/**
 * The app's IBM Plex faces as `@font-face` rules with data URLs, for UML exports: a PNG, a PDF or
 * a downloaded SVG then measures and draws text as the canvas does. The file imports put the
 * fonts into the compiled binary. The app loads six subsets for each face; an export embeds
 * only the subsets that its text needs (Latin always), so a Latin diagram carries about 80 KB.
 */
const FACES: readonly (readonly [family: string, weight: number, subset: string, path: string])[] = [
  ["IBM Plex Sans", 400, "latin", sans400_latin],
  ["IBM Plex Sans", 400, "latin-ext", sans400_latin_ext],
  ["IBM Plex Sans", 400, "cyrillic", sans400_cyrillic],
  ["IBM Plex Sans", 400, "cyrillic-ext", sans400_cyrillic_ext],
  ["IBM Plex Sans", 400, "greek", sans400_greek],
  ["IBM Plex Sans", 400, "vietnamese", sans400_vietnamese],
  ["IBM Plex Sans", 600, "latin", sans600_latin],
  ["IBM Plex Sans", 600, "latin-ext", sans600_latin_ext],
  ["IBM Plex Sans", 600, "cyrillic", sans600_cyrillic],
  ["IBM Plex Sans", 600, "cyrillic-ext", sans600_cyrillic_ext],
  ["IBM Plex Sans", 600, "greek", sans600_greek],
  ["IBM Plex Sans", 600, "vietnamese", sans600_vietnamese],
  ["IBM Plex Mono", 400, "latin", mono400_latin],
  ["IBM Plex Mono", 400, "latin-ext", mono400_latin_ext],
  ["IBM Plex Mono", 400, "cyrillic", mono400_cyrillic],
  ["IBM Plex Mono", 400, "cyrillic-ext", mono400_cyrillic_ext],
  ["IBM Plex Mono", 400, "vietnamese", mono400_vietnamese],
];
/** Each subset's `unicode-range`, read from the font package's own CSS. */
const RANGES: ReadonlyMap<string, [number, number][]> = new Map(
  [...sansCss.matchAll(/\/\* ibm-plex-sans-([a-z-]+)-400-normal \*\/[^}]*?unicode-range:\s*([^;]+);/g)].map(([, subset = "", ranges = ""]) => [subset, ranges.split(",").map(range => {
    const [from = "0", to = from] = range.trim().replace(/^U\+/i, "").split("-");
    return [parseInt(from, 16), parseInt(to, 16)] as [number, number];
  })]),
);
/** The subsets that cover at least one character of `text`. Latin is always in. */
export function fontSubsets(text: string): Set<string> {
  const out = new Set(["latin"]);
  for (const char of new Set(text)) {
    const code = char.codePointAt(0) ?? 0;
    for (const [subset, ranges] of RANGES) if (!out.has(subset) && ranges.some(([from, to]) => code >= from && code <= to)) out.add(subset);
  }
  return out;
}
const cache = new Map<string, Promise<string>>();
async function face(family: string, weight: number, subset: string, path: string): Promise<string> {
  const range = RANGES.get(subset)?.map(([from, to]) => from === to ? `U+${from.toString(16)}` : `U+${from.toString(16)}-${to.toString(16)}`).join(",");
  const data = Buffer.from(await Bun.file(path).bytes()).toString("base64");
  return `@font-face{font-family:'${family}';font-style:normal;font-weight:${weight};font-display:block;src:url(data:font/woff2;base64,${data}) format('woff2')${range ? `;unicode-range:${range}` : ""}}`;
}
/** The rules for the subsets that `text` needs. */
export async function diagramFontCss(text = ""): Promise<string> {
  const needed = fontSubsets(text);
  const rules = await Promise.all(FACES.filter(([, , subset]) => needed.has(subset)).map(([family, weight, subset, path]) => {
    const key = `${family}|${weight}|${subset}`;
    let rule = cache.get(key);
    if (!rule) { rule = face(family, weight, subset, path); cache.set(key, rule); }
    return rule;
  }));
  return rules.join("");
}
