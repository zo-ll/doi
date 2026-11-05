import sans400 from "@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-400-normal.woff2" with { type: "file" };
import sans600 from "@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-600-normal.woff2" with { type: "file" };
import mono400 from "@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2" with { type: "file" };

/**
 * The app's IBM Plex faces (Latin) as `@font-face` rules with data URLs, for UML exports: a PNG,
 * a PDF or a downloaded SVG then measures and draws text as the canvas does. The file imports
 * put the fonts into the compiled binary. About 80 KB of base64, read once.
 */
let css: Promise<string> | null = null;
export function diagramFontCss(): Promise<string> {
  css ??= (async () => {
    const face = async (family: string, weight: number, path: string) =>
      `@font-face{font-family:'${family}';font-style:normal;font-weight:${weight};font-display:block;src:url(data:font/woff2;base64,${Buffer.from(await Bun.file(path).bytes()).toString("base64")}) format('woff2')}`;
    return (await Promise.all([face("IBM Plex Sans", 400, sans400), face("IBM Plex Sans", 600, sans600), face("IBM Plex Mono", 400, mono400)])).join("");
  })();
  return css;
}
