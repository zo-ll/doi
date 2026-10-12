import { cp, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ProviderId } from "../config.ts";
import type { Usage } from "./chat.ts";
import { withFileLock } from "./file-lock.ts";
import { assertName, designDir } from "./paths.ts";
import { projectDir } from "./project-file.ts";

/** One variant of a set: a copy of the design that one turn changed. */
export interface Variant {
  n: number;
  provider: ProviderId;
  model: string;
  status: "running" | "done" | "error" | "stopped";
  text: string;
  usage: Usage;
  files: string[];
  error?: string;
}

/** N variants of one design from one prompt. At most one set per design is open. */
export interface VariantSet {
  id: string;
  prompt: string;
  target: string | null;
  createdAt: string;
  /** The system prompt version. */
  promptVersion: string;
  variants: Variant[];
}

export const VARIANT_COUNT = { min: 2, max: 4 } as const;
const SET_ID = /^[0-9a-z-]{1,40}$/;

/** projects/<p>/variants/<design>: outside designs/, so the sidebar and the watcher skip it. */
export function variantsRoot(workspace: string, project: string, design: string): string {
  assertName("project", project);
  assertName("design", design);
  return join(projectDir(workspace, project), "variants", design);
}

export function setDir(workspace: string, project: string, design: string, set: string): string {
  if (!SET_ID.test(set)) throw new Error(`Invalid variant set "${set}".`);
  return join(variantsRoot(workspace, project, design), set);
}

export function variantDir(workspace: string, project: string, design: string, set: string, n: number): string {
  if (!Number.isInteger(n) || n < 1 || n > VARIANT_COUNT.max) throw new Error(`Invalid variant ${n}.`);
  return join(setDir(workspace, project, design, set), String(n));
}

const setFile = (workspace: string, project: string, design: string, set: string) =>
  join(setDir(workspace, project, design, set), "set.json");

/** Hidden files (comments) belong to the design, not to its page. */
const visible = (src: string) => !src.split(/[\\/]/).at(-1)!.startsWith(".");

/** The open set of a design, or null. */
export async function openSet(workspace: string, project: string, design: string): Promise<VariantSet | null> {
  let entries: string[];
  try {
    entries = (await readdir(variantsRoot(workspace, project, design), { withFileTypes: true }))
      .filter((e) => e.isDirectory() && SET_ID.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    return null;
  }
  for (const id of entries.reverse()) {
    const file = Bun.file(setFile(workspace, project, design, id));
    if (!(await file.exists())) continue;
    try {
      return (await file.json()) as VariantSet;
    } catch {
      // A set.json cut by a crash: the set cannot be used. Discard removes it.
      return { id, prompt: "", target: null, createdAt: "", promptVersion: "", variants: [] };
    }
  }
  return null;
}

/** Copies the design into a new set, once for each variant. */
export async function createSet(
  workspace: string,
  project: string,
  design: string,
  input: Omit<VariantSet, "id" | "createdAt">,
): Promise<VariantSet> {
  const now = new Date();
  // Sortable and unique enough: one set per design is open at a time.
  const id = `${now.toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${crypto.randomUUID().slice(0, 6)}`;
  const set: VariantSet = { ...input, id, createdAt: now.toISOString() };
  const src = designDir(workspace, project, design);
  for (const v of set.variants) {
    const dst = variantDir(workspace, project, design, id, v.n);
    await mkdir(dst, { recursive: true });
    await cp(src, dst, { recursive: true, filter: visible });
  }
  await saveSet(workspace, project, design, set);
  return set;
}

export function saveSet(workspace: string, project: string, design: string, set: VariantSet): Promise<void> {
  const path = setFile(workspace, project, design, set.id);
  return withFileLock(path, async () => {
    const tmp = `${path}.${crypto.randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(set, null, 2) + "\n");
    await rename(tmp, path);
  });
}

/** Removes a set folder. */
export async function removeSet(workspace: string, project: string, design: string, set: string): Promise<void> {
  await rm(setDir(workspace, project, design, set), { recursive: true, force: true });
}

/**
 * Makes variant `n` the design: its files replace the page files of the design. Hidden files
 * of the design (comments) stay.
 */
export async function pickVariant(workspace: string, project: string, design: string, set: string, n: number): Promise<void> {
  const src = variantDir(workspace, project, design, set, n);
  if (!existsSync(src)) throw new Error(`Variant ${n} does not exist.`);
  const dst = designDir(workspace, project, design);
  for (const e of await readdir(dst)) {
    if (!e.startsWith(".")) await rm(join(dst, e), { recursive: true, force: true });
  }
  await cp(src, dst, { recursive: true, filter: visible });
}

/** Moves the variants of a renamed design. */
export async function renameVariants(workspace: string, project: string, from: string, to: string): Promise<string[]> {
  const a = variantsRoot(workspace, project, from);
  const b = variantsRoot(workspace, project, to);
  if (!existsSync(a)) return [];
  await mkdir(join(b, ".."), { recursive: true });
  await rename(a, b);
  return [a, b];
}
