import { z } from "zod";

export const itemId = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
const coordinate = z.number().min(-100_000).max(100_000);
export const pointSchema = z.strictObject({ x: coordinate, y: coordinate });
export const colourSchema = z.string().regex(/^(?:#[\da-f]{3,4}|#[\da-f]{6}|#[\da-f]{8}|transparent)$/i).nullable().default(null);
export const lineStyleSchema = z.enum(["solid", "dashed", "dotted"]);
export const shapeSchema = z.enum(["box", "class", "rounded", "ellipse", "diamond", "note", "text", "actor", "group"]);
export const sideSchema = z.enum(["top", "right", "bottom", "left"]);
const nameSchema = z.string().trim().min(1).max(200);
const pageSchema = z.string().max(200).regex(/^[A-Za-z0-9][A-Za-z0-9_./-]*\.html?$/i)
  .refine((page) => page.split("/").every((part) => part !== "." && part !== ".."), "The page must stay inside the design.");
export const uiReferenceSchema = z.strictObject({
  design: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  page: pageSchema,
  node: itemId.nullable().default(null),
});
const sizeSchema = z.strictObject({
  width: z.number().min(32).max(4096).default(180),
  height: z.number().min(32).max(4096).default(90),
});
const styleSchema = z.strictObject({
  fill: colourSchema, stroke: colourSchema, text: colourSchema,
  fontSize: z.number().min(10).max(48).default(13),
  line: lineStyleSchema.default("solid"),
});

export const nodeSchema = z.strictObject({
  id: itemId,
  shape: shapeSchema.default("box"),
  name: nameSchema,
  position: pointSchema,
  size: sizeSchema.prefault({}),
  parent: itemId.nullable().default(null),
  locked: z.boolean().default(false),
  content: z.string().max(20_000).default(""),
  stereotype: z.string().max(200).default(""),
  attributes: z.string().max(5000).default(""),
  operations: z.string().max(5000).default(""),
  style: styleSchema.prefault({}),
  references: z.array(uiReferenceSchema).max(30).default(() => []),
});

export type DiagramNode = z.infer<typeof nodeSchema>;
export type Point = z.infer<typeof pointSchema>;
export type Shape = z.infer<typeof shapeSchema>;
export type Side = z.infer<typeof sideSchema>;

export function createNode(shape: Shape, position: Point, name = "New box"): DiagramNode {
  return nodeSchema.parse({ id: crypto.randomUUID(), shape, position, name,
    size: shape === "group" ? { width: 420, height: 300 } : shape === "class" ? { width: 220, height: 170 } : undefined });
}
