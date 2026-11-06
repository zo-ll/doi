import { createHash } from "node:crypto";
import { link, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import { z } from "zod";
import { userDirs } from "../user-dirs.ts";
import { CommandError, EXIT } from "./cli.ts";

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

/** Windows paths ignore case, so C:\\ws and c:\\ws are one workspace. 8.3 short names are not handled. */
export const workspaceKey = (workspace: string, platform: NodeJS.Platform = process.platform) => (platform === "win32" ? workspace.toLowerCase() : workspace);

/** One file per workspace, so two workspaces can run side by side. */
const stem = (workspace: string) => createHash("sha256").update(workspaceKey(workspace)).digest("hex").slice(0, 16);
export const recordFile = (workspace: string, dataDir = userDirs().data) => join(dataDir, "instances", `${stem(workspace)}.json`);
export const logFile = (workspace: string, dataDir = userDirs().data) => join(dataDir, "logs", `${stem(workspace)}.log`);

async function writeTemp(record: InstanceRecord, file: string): Promise<string> {
  await mkdir(join(file, ".."), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
  return tmp;
}

/** Replaces the record. Only for a process that already owns it, or for tests. */
export async function writeRecord(record: InstanceRecord, file = recordFile(record.workspace)): Promise<void> {
  await rename(await writeTemp(record, file), file);
}

/**
 * Creates the file only when it does not exist. `link` also shows a reader a whole file. A folder
 * without hard links (a network share, FAT) falls back to an exclusive write; a reader that comes
 * during that write sees a broken file, which counts as no record, and it tries again.
 */
async function exclusive(tmp: string, record: InstanceRecord, file: string): Promise<void> {
  try {
    await link(tmp, file);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "EPERM" && code !== "EACCES" && code !== "ENOTSUP" && code !== "ENOSYS") throw e;
    await writeFile(file, JSON.stringify(record, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  }
}

/**
 * Makes this process the one server of its workspace. `link` fails when the file exists, so only
 * one of many servers can win, and a reader sees a whole file. The same process may renew its
 * record: `bun --hot` runs this again after a reload. Returns the other server when one is live.
 */
export async function claimRecord(record: InstanceRecord, file = recordFile(record.workspace)): Promise<InstanceRecord | null> {
  const tmp = await writeTemp(record, file);
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await exclusive(tmp, record, file);
        return null;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
      const current = await readRecord(file);
      if (!current) {
        // A file that cannot be read claims nothing. It must not block every later start.
        await removeRecord(file);
        continue;
      }
      if (current.pid === record.pid) {
        await writeRecord(record, file);
        return null;
      }
      const other = await findInstance(record.workspace, file);
      if (other) return other;
    }
    throw new CommandError(EXIT.readiness, "not_ready", `Another start changes ${file}. Try again.`);
  } finally {
    await rm(tmp, { force: true });
  }
}

/** Removes the record only when it is this process's own: a stopping server must not hide another. */
export async function releaseRecord(pid: number, file: string): Promise<void> {
  if ((await readRecord(file))?.pid === pid) await removeRecord(file);
}

export async function readRecord(file: string): Promise<InstanceRecord | null> {
  try {
    return recordSchema.parse(await Bun.file(file).json());
  } catch {
    return null; // missing or broken: there is no record
  }
}

export const removeRecord = (file: string) => rm(file, { force: true });

/**
 * A loopback request never goes through a proxy from the environment: Bun reads HTTP_PROXY for each
 * fetch, and a failed probe would look like a server that does not run.
 */
export const LOCAL = { proxy: false } as unknown as RequestInit;

/** Asks a port what runs there. "none": nothing, or not doi. "timeout": no answer in time, so nothing is known. */
export async function ask(port: number, timeoutMs = 1500): Promise<InstanceInfo | "none" | "timeout"> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/instance`, { ...LOCAL, signal: AbortSignal.timeout(timeoutMs) });
    return res.ok ? infoSchema.parse(await res.json()) : "none";
  } catch (e) {
    return e instanceof DOMException && e.name === "TimeoutError" ? "timeout" : "none";
  }
}

export async function probe(port: number, timeoutMs = 1500): Promise<InstanceInfo | null> {
  const answer = await ask(port, timeoutMs);
  return typeof answer === "string" ? null : answer;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
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
  const live = await ask(record.port);
  if (live === "timeout" && processAlive(record.pid) && (await portInUse(record.port))) {
    // A stalled server keeps its identity: without the record, nothing could stop it later.
    throw new CommandError(EXIT.readiness, "unreachable", `The record ${file} names process ${record.pid} on port ${record.port}, which does not answer. Try again in a moment. If doi is gone, remove that file.`);
  }
  if (typeof live !== "string" && live.id === record.id && live.pid === record.pid && workspaceKey(live.workspace) === workspaceKey(workspace)) return record;
  // A server writes its record only after it listens, so this record is an old one.
  await removeRecord(file);
  return null;
}
