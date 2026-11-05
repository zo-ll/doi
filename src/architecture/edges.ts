import { z } from "zod";
import { colourSchema, itemId, lineStyleSchema, pointSchema, sideSchema } from "./nodes.ts";

export const markerSchema = z.enum(["none", "arrow", "open-arrow", "triangle", "diamond", "diamond-filled", "circle"]);
export const relationshipSchema = z.enum(["association", "directed", "dependency", "inheritance", "realization", "aggregation", "composition"]);
export const edgeSchema = z.strictObject({
  id: itemId, source: itemId, target: itemId,
  sourceSide: sideSchema.default("right"), targetSide: sideSchema.default("left"),
  sourceOffset: z.number().min(0).max(1).default(0.5), targetOffset: z.number().min(0).max(1).default(0.5),
  route: z.enum(["straight", "elbow", "curved"]).default("elbow"),
  points: z.array(pointSchema).max(64).default(() => []),
  label: z.string().max(500).default(""),
  startLabel: z.string().max(500).default(""), endLabel: z.string().max(500).default(""),
  startMarker: markerSchema.default("none"), endMarker: markerSchema.default("arrow"),
  line: lineStyleSchema.default("solid"), colour: colourSchema,
  width: z.number().min(0.5).max(8).default(1.5),
  locked: z.boolean().default(false),
});
export type DiagramEdge = z.infer<typeof edgeSchema>;
export type Marker = z.infer<typeof markerSchema>;
export type Relationship = z.infer<typeof relationshipSchema>;
type Preset = Pick<DiagramEdge, "startMarker" | "endMarker" | "line">;
const presets: Readonly<Record<Relationship, Readonly<Preset>>> = {
  association: { startMarker: "none", endMarker: "none", line: "solid" },
  directed: { startMarker: "none", endMarker: "arrow", line: "solid" },
  dependency: { startMarker: "none", endMarker: "open-arrow", line: "dashed" },
  inheritance: { startMarker: "none", endMarker: "triangle", line: "solid" },
  realization: { startMarker: "none", endMarker: "triangle", line: "dashed" },
  aggregation: { startMarker: "diamond", endMarker: "none", line: "solid" },
  composition: { startMarker: "diamond-filled", endMarker: "none", line: "solid" },
};

export function applyRelationship(edge: DiagramEdge, relationship: Relationship): DiagramEdge {
  return { ...edge, ...presets[relationship] };
}
export function createEdge(source: string, target: string): DiagramEdge {
  return edgeSchema.parse({ id: crypto.randomUUID(), source, target });
}
