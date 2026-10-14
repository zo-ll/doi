import { join } from "node:path";
import { ExportError } from "../export/html.ts";
import { designDir, listProjects } from "../workspace/paths.ts";
import template from "./prompt-v0.md" with { type: "text" };

/**
 * The prompt for a coding agent: one text for every agent. The agent reads the design through
 * the doi MCP server, so doi needs no setup per agent. A new version is a new file.
 */
export const AGENT_PROMPT = { version: "v0", text: template } as const;

/** Project and design ids are safe names; the display name goes on one line without quotes. */
const plain = (text: string) => text.replace(/\s+/g, " ").replace(/"/g, "'").trim();

export async function agentPrompt(workspace: string, project: string, design: string, mcpUrl: string): Promise<string> {
  if (!(await Bun.file(join(designDir(workspace, project, design), "index.html")).exists())) {
    throw new ExportError("Design not found.");
  }
  const name = (await listProjects(workspace)).find((p) => p.id === project)?.name ?? project;
  const values: Record<string, string> = { project, design, name: plain(name), url: mcpUrl };
  // One pass: a value that has {{x}} in it stays as it is.
  return AGENT_PROMPT.text.replace(/\{\{(\w+)\}\}/g, (all, key: string) => values[key] ?? all);
}
