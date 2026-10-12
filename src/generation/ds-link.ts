import { join } from "node:path";
import { designSystemUrl, type DesignSystem } from "../workspace/design-systems.ts";
import type { DesignFile } from "./context.ts";

const DS_FILE = /^\/ds\/[a-z0-9][a-z0-9-]*\/(tokens|components)\.css$/;

/** The stylesheets of a design system that pages link, in order. */
function wanted(ds: Pick<DesignSystem, "name" | "tokens" | "componentStyles">): { kind: string; href: string }[] {
  return [
    ...(ds.tokens !== null ? [{ kind: "tokens", href: designSystemUrl(ds.name, "tokens.css") }] : []),
    ...(ds.componentStyles !== null ? [{ kind: "components", href: designSystemUrl(ds.name, "components.css") }] : []),
  ];
}

/**
 * Every HTML page of a design links the stylesheets of the project's design system: tokens.css
 * and components.css. A missing link goes before the page's own first stylesheet (so the page
 * can adjust the components), or at the end of <head>. A link to another design system now
 * points to this one. Only changed files come back, byte for byte apart from these tags.
 */
export async function linkDesignSystem(
  files: DesignFile[],
  ds: Pick<DesignSystem, "name" | "tokens" | "componentStyles">,
): Promise<{ path: string; content: string }[]> {
  const want = wanted(ds);
  if (!want.length) return [];
  const out: { path: string; content: string }[] = [];
  for (const f of files) {
    if (f.content === null || !/\.html?$/i.test(f.path)) continue;
    const present = new Set<string>();
    let changed = false;
    let hasHead = false;
    let content = await new HTMLRewriter()
      .on("head", { element: () => void (hasHead = true) })
      .on('link[rel="stylesheet"][href]', {
        element(el) {
          const m = el.getAttribute("href")!.match(DS_FILE);
          if (!m) return;
          const href = designSystemUrl(ds.name, `${m[1]}.css`);
          if (el.getAttribute("href") !== href) {
            el.setAttribute("href", href);
            changed = true;
          }
          present.add(m[1]!);
        },
      })
      .transform(new Response(f.content))
      .text();
    const missing = want.filter((w) => !present.has(w.kind));
    // A fragment without <head> is left as it is: there is no place for the links.
    if (missing.length && hasHead) {
      const tags = missing.map((w) => `<link rel="stylesheet" href="${w.href}">`);
      let placed = false;
      content = await new HTMLRewriter()
        .on('head link[rel="stylesheet"]', {
          element(el) {
            if (placed || DS_FILE.test(el.getAttribute("href") ?? "")) return;
            el.before(tags.map((t) => `${t}\n  `).join(""), { html: true });
            placed = true;
          },
        })
        .on("head", {
          element(el) {
            el.onEndTag((end) => {
              if (!placed) end.before(tags.map((t) => `  ${t}\n`).join(""), { html: true });
            });
          },
        })
        .transform(new Response(content))
        .text();
      changed = true;
    }
    if (changed) out.push({ path: f.path, content });
  }
  return out;
}

/** Links the design system in the design folder `dir` on disk. Returns the paths it changed. */
export async function linkDesignSystemIn(
  dir: string,
  files: DesignFile[],
  ds: Pick<DesignSystem, "name" | "tokens" | "componentStyles">,
): Promise<string[]> {
  const fixed = await linkDesignSystem(files, ds);
  for (const f of fixed) await Bun.write(join(dir, f.path), f.content);
  return fixed.map((f) => f.path);
}
