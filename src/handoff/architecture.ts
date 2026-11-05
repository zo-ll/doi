import { diagramSvg, imageText } from "../architecture/svg.ts";
import type { Architecture } from "../architecture/schema.ts";
import type { ZipEntry } from "../export/zip.ts";
import { diagramFontCss } from "../export/diagram-fonts.ts";
import { ArchitectureError, readArchitecture } from "../workspace/architecture.ts";

/**
 * The project's UML for a handoff (U25). Only when the user enabled UML and it has diagrams:
 * a handoff of a project without UML stays as it was. "invalid": the file cannot be read
 * (corrupt, or a link); the handoff still works and says so.
 */
export async function handoffArchitecture(workspace: string, project: string): Promise<Architecture | "invalid" | null> {
  try {
    const { state } = await readArchitecture(workspace, project);
    return state.enabled && state.diagrams.length ? state : null;
  } catch (error) {
    if (error instanceof ArchitectureError && error.status !== 404) return "invalid";
    throw error;
  }
}

const flat = (text: string, max: number) => { const one = text.replace(/\s+/g, " ").trim(); return one.length > max ? `${one.slice(0, max - 1)}…` : one; };
/** Markdown inline code that a backtick in the value cannot end. */
const code = (value: string) => `\`${value.replace(/`/g, "'")}\``;

/** `architecture/<name>.svg`, with "-2", "-3" for equal safe names. */
export function diagramFiles(state: Architecture): { id: string; name: string; path: string }[] {
  const stems = new Set<string>();
  return state.diagrams.map(d => {
    const base = d.name.normalize("NFKD").replace(/[^A-Za-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "diagram";
    let stem = base;
    for (let n = 2; stems.has(stem); n++) stem = `${base}-${n}`;
    stems.add(stem);
    return { id: d.id, name: d.name, path: `architecture/${stem}.svg` };
  });
}

/** The agent prompt's step for the diagrams, or "" without UML. */
export function promptStep(state: Architecture | "invalid" | null): string {
  if (!state) return "";
  if (state === "invalid") return "   The project's UML file is invalid, so its diagrams are not part of this task. Do not call `update_architecture`.";
  const names = state.diagrams.map(d => `"${flat(d.name, 80).replace(/"/g, "'")}"`).join(", ");
  return `   The project also has UML diagrams of its architecture: ${names}. Call the doi tools \`get_architecture\` for the project and \`render_architecture\` for each diagram. They show the parts of the product and how they connect. A box can link to pages and elements of the UI designs (\`references\`). Each open diagram comment is a change that the user still wants.`;
}

/** The HANDOFF.md section with its heading, or "" without UML. */
export function handoffSection(state: Architecture | "invalid" | null): string {
  if (!state) return "";
  if (state === "invalid") return "## Architecture\n\nThe project's UML file is invalid. Fix it in doi; this bundle has no diagrams.\n\n";
  const files = diagramFiles(state);
  const lines = [
    "The project has UML diagrams of its architecture. Use them to place the code: they show the parts and how they connect. A box can link to pages of the UI designs (`references`).",
    "",
    `- ${code("architecture/architecture.json")}: all diagrams with stable item ids, connectors, comments and UI links.`,
    ...files.map((f, i) => state.diagrams[i]?.nodes.length
      ? `- ${code(f.path)}: the diagram "${flat(f.name, 120).replace(/"/g, "'")}" as an image.`
      : `- The diagram "${flat(f.name, 120).replace(/"/g, "'")}" is empty: it has no image.`),
  ];
  const open = state.diagrams.flatMap(d => {
    const names = new Map([...d.nodes, ...d.edges].map(item => [item.id, "name" in item ? item.name : item.label || "connector"]));
    return d.comments.filter(c => c.status === "open").map(c => `- In "${flat(d.name, 80)}", on ${code(flat(names.get(c.item) ?? c.item, 80))} (${code(c.item)}): ${flat(c.text, 2000)}`);
  });
  lines.push("", "Open diagram comments:", "", ...(open.length ? open : ["- None."]));
  return `## Architecture\n\n${lines.join("\n")}\n\n`;
}

/** The bundle files: the JSON and one light SVG for each diagram, with the fonts that its text needs. */
export async function architectureEntries(state: Architecture | "invalid" | null): Promise<ZipEntry[]> {
  if (!state || state === "invalid") return [];
  const utf8 = new TextEncoder();
  const entries: ZipEntry[] = [{ path: "architecture/architecture.json", data: utf8.encode(JSON.stringify(state, null, 2) + "\n") }];
  const files = diagramFiles(state);
  for (const [i, diagram] of state.diagrams.entries()) {
    const image = diagramSvg(diagram, { theme: "light", background: true, fontCss: await diagramFontCss(imageText(diagram)) });
    const file = files[i];
    if (file && !("error" in image)) entries.push({ path: file.path, data: utf8.encode(image.svg) });
  }
  return entries;
}
