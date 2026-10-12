import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { assertName } from "./paths.ts";
import { projectFile } from "./project-file.ts";

/**
 * A design system folder: `design-systems/<name>/` with `tokens.css`, `fonts/`,
 * `components.html` (and `components.css`), `rules.md` and `screenshots/`. Every part is optional.
 */
export interface DesignSystem {
  name: string;
  tokens: string | null;
  components: string | null;
  /**
   * The CSS of the components: `components.css`, or else the <style> blocks of
   * components.html. Pages link it at /ds/<name>/components.css.
   */
  componentStyles: string | null;
  rules: string | null;
  /** File names in fonts/. tokens.css loads them with @font-face. */
  fonts: string[];
  /** File names in screenshots/. */
  screenshots: string[];
}

export const designSystemsDir = (workspace: string) => join(workspace, "design-systems");

export function designSystemDir(workspace: string, name: string): string {
  assertName("design system", name);
  return join(designSystemsDir(workspace), name);
}

/** The URL path that pages use for a design system file. */
export const designSystemUrl = (name: string, file = "") => `/ds/${name}/${file}`;

async function text(path: string): Promise<string | null> {
  const f = Bun.file(path);
  return (await f.exists()) ? f.text() : null;
}

async function names(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isFile() && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/** Loads a design system. Null when the folder does not exist; a missing file is not an error. */
export async function loadDesignSystem(workspace: string, name: string): Promise<DesignSystem | null> {
  const dir = designSystemDir(workspace, name);
  try {
    await readdir(dir);
  } catch {
    return null;
  }
  const [tokens, components, componentsCss, rules, fonts, screenshots] = await Promise.all([
    text(join(dir, "tokens.css")),
    text(join(dir, "components.html")),
    text(join(dir, "components.css")),
    text(join(dir, "rules.md")),
    names(join(dir, "fonts")),
    names(join(dir, "screenshots")),
  ]);
  return { name, tokens, components, componentStyles: componentsCss ?? stylesOf(components), rules, fonts, screenshots };
}

/** The CSS in the <style> blocks of an HTML text, or null when it has none. */
export function stylesOf(html: string | null): string | null {
  if (!html) return null;
  const blocks = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]!.trim()).filter(Boolean);
  return blocks.length ? blocks.join("\n\n") + "\n" : null;
}

/** The names of the design systems in the workspace. */
export async function listDesignSystems(workspace: string): Promise<string[]> {
  try {
    return (await readdir(designSystemsDir(workspace), { withFileTypes: true }))
      .filter((e) => e.isDirectory() && /^[a-z0-9][a-z0-9-]*$/.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/** The design system that a project selected in project.json, or null. */
export async function projectDesignSystemName(workspace: string, project: string): Promise<string | null> {
  try {
    const meta = await Bun.file(projectFile(workspace, project)).json();
    const name = (meta as { designSystem?: unknown }).designSystem;
    return typeof name === "string" && /^[a-z0-9][a-z0-9-]*$/.test(name) ? name : null;
  } catch {
    return null;
  }
}

/**
 * The design system as text for the stable part of the prompt. The pages link tokens.css by
 * URL, so a change to the tokens reaches every design without a new turn.
 */
export function formatDesignSystem(ds: DesignSystem): string {
  const links = [
    ...(ds.tokens !== null ? [`<link rel="stylesheet" href="${designSystemUrl(ds.name, "tokens.css")}">`] : []),
    ...(ds.componentStyles !== null ? [`<link rel="stylesheet" href="${designSystemUrl(ds.name, "components.css")}">`] : []),
  ];
  const parts = [`# Design system: ${ds.name}`];
  if (links.length) {
    parts.push(
      ["Each HTML page links these in its <head>, in this order, before its own stylesheet:", ...links].join("\n") +
        (ds.componentStyles !== null
          ? "\nThe components are styled by components.css. Use their class names as they are; " +
            "do not style them again in styles.css. Add classes only for layout and for parts the design system does not have."
          : ""),
    );
  }
  if (ds.tokens !== null) {
    parts.push(
      [
        "Use these custom properties with var(...) for colors, type, spacing, radius and shadows. " +
          "Do not copy their values into styles.css, and do not define them again.",
        "",
        "## tokens.css",
        "```css",
        ds.tokens.trim(),
        "```",
      ].join("\n"),
    );
  }
  if (ds.fonts.length) {
    parts.push(
      `## Fonts\n${ds.fonts.map((f) => `- ${designSystemUrl(ds.name, `fonts/${f}`)}`).join("\n")}\n` +
        "Use these fonts through the font tokens. Do not link other font files.",
    );
  }
  if (ds.components !== null) {
    parts.push(
      [
        "## Components (components.html)",
        "Copy this markup and its class names for buttons, cards, inputs, navigation and the other parts it shows.",
        "```html",
        ds.components.trim(),
        "```",
      ].join("\n"),
    );
  }
  if (ds.rules !== null) parts.push(`## Rules (rules.md)\n${ds.rules.trim()}`);
  if (ds.screenshots.length) {
    parts.push(`## Screenshots\nThe design system was made from: ${ds.screenshots.join(", ")}.`);
  }
  return parts.join("\n\n");
}

/** The loaded design system of a project, or null when it has none or the folder is gone. */
export async function activeDesignSystem(workspace: string, project: string): Promise<DesignSystem | null> {
  const name = await projectDesignSystemName(workspace, project);
  return name ? loadDesignSystem(workspace, name) : null;
}
