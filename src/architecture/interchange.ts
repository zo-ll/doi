import { z } from "zod";
import { diagramSchema, type Diagram } from "./schema.ts";
export const MAX_DIAGRAM_FILE_BYTES = 4 * 1024 * 1024;
const fileSchema = z.strictObject({ format: z.literal("doi-diagram"), version: z.literal(1), diagram: diagramSchema });
export function diagramFile(graph: Diagram): string {
  const text = JSON.stringify(fileSchema.parse({ format: "doi-diagram", version: 1, diagram: graph }), null, 2) + "\n";
  if (new TextEncoder().encode(text).byteLength > MAX_DIAGRAM_FILE_BYTES) throw new Error("The diagram file exceeds 4 MB.");
  return text;
}
export function readDiagramFile(text: string): Diagram {
  if (new TextEncoder().encode(text).byteLength > MAX_DIAGRAM_FILE_BYTES) throw new Error("The diagram file exceeds 4 MB.");
  const raw: unknown = JSON.parse(text);
  return fileSchema.parse(raw).diagram;
}
