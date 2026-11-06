import { createHash } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import { z } from "zod";
import { userDirs } from "../user-dirs.ts";

/** What a running doi says about itself at GET /api/instance. */
export interface InstanceInfo {
  id: string;
  pid: number;
  workspace: string;
  version: string;
}

/** The file of one running doi. It finds the server; only the server's own answer proves identity. */
export interface InstanceRecord extends InstanceInfo {
  port: number;
  log: string | null;
}

const infoSchema = z.object({ id: z.string(), pid: z.number(), workspace: z.string(), version: z.string() });
const recordSchema = infoSchema.extend({ port: z.number(), log: z.string().nullable() });

/** One file per workspace, so two workspaces can run side by side. */
const stem = (workspace: string) => createHash("sha256").update(workspace).digest("hex").slice(0, 16);
export const recordFile = (workspace: string, dataDir = userDirs().data) => join(dataDir, "instances", `${stem(workspace)}.json`);
export const logFile = (workspace: string, dataDir = userDirs().data) => join(dataDir, "logs", `${stem(workspace)}.log`);

export async function writeRecord(record: InstanceRecord, file = recordFile(record.workspace)): Promise<void> {
  await mkdir(join(file, ".."), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
  await rename(tmp, file);
}

export async function readRecord(file: string): Promise<InstanceRecord | null> {
  try {
    return recordSchema.parse(await Bun.file(file).json());
  } catch {
    return null; // missing or broken: there is no record
  }
}

export const removeRecord = (file: string) => rm(file, { force: true });

/** Asks a port what runs there. null: nothing answers, or it is not doi. */
export async function probe(port: number, timeoutMs = 1500): Promise<InstanceInfo | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/instance`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok ? infoSchema.parse(await res.json()) : null;
  } catch {
    return null;
  }
}

/** True when anything accepts a connection on the port: doi or another program. */
export function portInUse(port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port, timeout: timeoutMs });
    const answer = (used: boolean) => {
      socket.destroy();
      resolve(used);
    };
    socket.once("connect", () => answer(true));
    socket.once("error", () => answer(false));
    socket.once("timeout", () => answer(false));
  });
}

/**
 * The running doi of this workspace. A record only counts when the server on its port gives the
 * same id, process and workspace, so a reused port or process id cannot match. A stale record goes.
 */
export async function findInstance(workspace: string, file = recordFile(workspace)): Promise<InstanceRecord | null> {
  const record = await readRecord(file);
  if (!record) return null;
  const live = await probe(record.port);
  if (live && live.id === record.id && live.pid === record.pid && live.workspace === workspace) return record;
  // A server that is still starting has written no record yet, so this record is an old one.
  await removeRecord(file);
  return null;
}
