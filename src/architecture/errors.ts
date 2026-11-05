import { z } from "zod";

const groups: Readonly<Record<string, string>> = { nodes: "Box", edges: "Connector", diagrams: "Diagram", comments: "Comment", references: "UI link" };
const fields: Readonly<Record<string, string>> = {
  endLabel: "end label", startLabel: "start label", label: "label", endMarker: "end marker", startMarker: "start marker",
  fontSize: "text size", fill: "fill colour", stroke: "border colour", text: "text colour", colour: "line colour", parent: "group",
  sourceSide: "start side", targetSide: "end side", sourceOffset: "start offset", targetOffset: "end offset", points: "bend points",
  nodes: "boxes", edges: "connectors", comments: "comments", references: "UI links", diagrams: "diagrams",
};
function fieldName(path: PropertyKey[]): string {
  const parts: string[] = [];
  for (let i = 0; i < path.length; i++) {
    const part = String(path[i]), index = path[i + 1];
    if (groups[part] && typeof index === "number") { parts.push(`${groups[part]} ${index + 1}`); i++; }
    else if (!["diagram", "state", "style"].includes(part)) parts.push(fields[part] ?? part);
  }
  return `${path.some((part, index) => typeof part === "string" && groups[part] && typeof path[index + 1] === "number") ? "" : "Diagram "}${parts.join(" ")}`.trim();
}

/** UI errors name the value and rule, not the schema's internal JSON. */
export function architectureErrorMessage(error: unknown): string {
  if (error instanceof z.ZodError) {
    const issue = error.issues[0];
    if (!issue) return "Check the diagram values.";
    let rule = issue.message;
    if (issue.code === "too_small") rule = issue.origin === "string" && issue.minimum === 1 ? "Enter a value." : `Use at least ${issue.minimum}${issue.origin === "string" ? " characters" : issue.origin === "array" ? " items" : ""}.`;
    if (issue.code === "too_big") rule = `Use at most ${issue.maximum}${issue.origin === "string" ? " characters" : issue.origin === "array" ? " items" : ""}.`;
    if (issue.code === "invalid_type") rule = issue.expected === "string" ? "Enter text." : issue.expected === "number" ? "Enter a number." : "Use the required diagram structure.";
    if (issue.code === "invalid_value") rule = issue.path.at(-1) === "version" ? "Use version 1." : "Choose a supported value.";
    if (issue.code === "invalid_format") rule = "Use the required field format.";
    if (issue.code === "unrecognized_keys") rule = "Remove fields that this format does not support.";
    return `${fieldName(issue.path)}: ${rule}`.replace(/\s+/g, " ");
  }
  if (error instanceof SyntaxError) return "The diagram file must contain valid JSON.";
  return error instanceof Error ? error.message.replace(/\s+/g, " ") : "Could not complete this UML action.";
}
