import { z } from "zod";
import { edgeSchema } from "./edges.ts";
import { itemId, nodeSchema } from "./nodes.ts";

const commentSchema = z.strictObject({
  id: itemId, item: itemId, text: z.string().trim().min(1).max(5000),
  status: z.enum(["open", "done"]).default("open"), createdAt: z.iso.datetime(),
});
export const diagramSchema = z.strictObject({
  id: itemId, name: z.string().trim().min(1).max(200),
  nodes: z.array(nodeSchema).max(2000).default(() => []),
  edges: z.array(edgeSchema).max(4000).default(() => []),
  comments: z.array(commentSchema).max(1000).default(() => []),
}).superRefine((diagram, ctx) => {
  const ids = new Set<string>();
  const nodes = new Map(diagram.nodes.map((node) => [node.id, node]));
  for (const field of ["nodes", "edges", "comments"] satisfies ("nodes" | "edges" | "comments")[]) {
    for (const [index, item] of diagram[field].entries()) {
      if (ids.has(item.id)) ctx.addIssue({ code: "custom", path: [field, index, "id"], message: "Item ids must be unique." });
      ids.add(item.id);
    }
  }
  for (const [index, edge] of diagram.edges.entries()) {
    if (!nodes.has(edge.source) || !nodes.has(edge.target)) {
      ctx.addIssue({ code: "custom", path: ["edges", index], message: "Both connector endpoints must name existing boxes." });
    }
  }
  for (const [index, node] of diagram.nodes.entries()) {
    const seen = new Set([node.id]);
    let parent = node.parent;
    while (parent !== null) {
      const group = nodes.get(parent);
      if (!group || group.shape !== "group" || seen.has(parent) || seen.size > 20) {
        ctx.addIssue({ code: "custom", path: ["nodes", index, "parent"], message: "Use an existing group without a cycle or more than 20 levels." });
        break;
      }
      seen.add(parent);
      parent = group.parent;
    }
  }
});
export const architectureSchema = z.strictObject({
  version: z.literal(1), enabled: z.boolean().default(false),
  diagrams: z.array(diagramSchema).max(50).default(() => []),
}).superRefine(({ diagrams }, ctx) => {
  if (new Set(diagrams.map((d) => d.id)).size !== diagrams.length) {
    ctx.addIssue({ code: "custom", path: ["diagrams"], message: "Diagram ids must be unique." });
  }
});
export const architectureViewSchema = z.strictObject({
  revision: z.string().regex(/^[a-f0-9]{64}$/).nullable(), state: architectureSchema,
});
export type Diagram = z.infer<typeof diagramSchema>;
export type Architecture = z.infer<typeof architectureSchema>;
export type ArchitectureView = z.infer<typeof architectureViewSchema>;
export function createDiagram(name = "System overview"): Diagram {
  return diagramSchema.parse({ id: crypto.randomUUID(), name });
}
export function emptyArchitecture(): Architecture {
  return architectureSchema.parse({ version: 1 });
}
