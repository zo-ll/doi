/**
 * A node URL names one element of a design, as a Figma link names a node:
 * `http://127.0.0.1:4317/?project=<id>&design=<id>&page=<file>&node=<data-oid>`.
 * The app shows it for each selection and keeps the address bar on it; opening it opens the
 * design and the page and selects the element. An agent can read the same values and call the
 * MCP tool `get_element`.
 */
export interface NodeRef {
  project: string;
  design: string;
  page: string;
  node: string | null;
}

const NAME = /^[a-z0-9][a-z0-9-]*$/; // the same rule as assertName() on the server
const OID = /^[A-Za-z0-9_-]{1,100}$/;
/** A page file of the design: a relative path to an .html file, without "..". */
const PAGE = /^(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._/-]{1,200}\.html?$/;

/** The query of a node URL; the default page and a missing node are left out. */
export function nodeQuery(ref: NodeRef): string {
  const q = new URLSearchParams({ project: ref.project, design: ref.design });
  if (ref.page !== "index.html") q.set("page", ref.page);
  if (ref.node) q.set("node", ref.node);
  return `?${q}`;
}

/** The full node URL on this server. */
export function nodeUrl(origin: string, ref: NodeRef): string {
  return `${origin}/${nodeQuery(ref)}`;
}

/** The values of a node URL's query, or null when it names no valid design. Bad parts are left out. */
export function parseNodeQuery(search: string): NodeRef | null {
  const q = new URLSearchParams(search);
  const project = q.get("project") ?? "";
  const design = q.get("design") ?? "";
  if (!NAME.test(project) || !NAME.test(design)) return null;
  const page = q.get("page") ?? "index.html";
  const node = q.get("node");
  return { project, design, page: PAGE.test(page) ? page : "index.html", node: node && OID.test(node) ? node : null };
}
