import type { Diagram } from "./schema.ts";

/** Removing a container keeps its children at the same visible positions. */
export function removeItems(graph: Diagram, ids: ReadonlySet<string>): Diagram {
  const removed = new Set(graph.nodes.filter(n => ids.has(n.id) && !n.locked).map(n => n.id));
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  const nodes = graph.nodes.filter(n => !removed.has(n.id)).map(node => {
    let parent = node.parent;
    let position = node.position;
    while (parent && removed.has(parent)) {
      const group = byId.get(parent);
      if (!group) break;
      position = { x: position.x + group.position.x, y: position.y + group.position.y };
      parent = group.parent;
    }
    return parent === node.parent ? node : { ...node, parent, position };
  });
  return { ...graph, nodes, edges: graph.edges.filter(e => !removed.has(e.source) && !removed.has(e.target) && (!ids.has(e.id) || e.locked)) };
}
export function duplicateItems(graph: Diagram, selected: ReadonlySet<string>): { graph: Diagram; ids: Set<string> } {
  const included = new Set(selected);
  for (let depth = 0; depth < 20; depth++) {
    const before = included.size;
    for (const node of graph.nodes) if (node.parent && included.has(node.parent)) included.add(node.id);
    if (before === included.size) break;
  }
  const originals = graph.nodes.filter(n => included.has(n.id));
  const remap = new Map(originals.map(n => [n.id, crypto.randomUUID()]));
  const copies = originals.map(node => ({ ...structuredClone(node), id: remap.get(node.id) ?? crypto.randomUUID(),
    parent: node.parent ? remap.get(node.parent) ?? node.parent : null, locked: false,
    position: node.parent && remap.has(node.parent) ? { ...node.position } : { x: node.position.x + 24, y: node.position.y + 24 },
  }));
  const edges = graph.edges.filter(e => remap.has(e.source) && remap.has(e.target)).map(edge => ({ ...structuredClone(edge), id: crypto.randomUUID(), source: remap.get(edge.source) ?? edge.source, target: remap.get(edge.target) ?? edge.target, locked: false }));
  return { graph: { ...graph, nodes: [...graph.nodes, ...copies], edges: [...graph.edges, ...edges] }, ids: new Set(copies.map(n => n.id)) };
}
