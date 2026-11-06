import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { loadConfig, type Config } from "../config.ts";
import { rendererStatus } from "../export/browser.ts";
import { ensureUserConfig, userPaths } from "../user-dirs.ts";
import { version } from "../../package.json";
import { CommandError, EXIT, type ServerCli } from "./cli.ts";
import { findInstance, LOCAL, logFile, portInUse, probe, recordFile, readRecord, removeRecord, type InstanceRecord } from "./instance.ts";
import { checkTools } from "./tools.ts";

const READY_MS = 30_000;

/** The config of a command. A binary uses the per-user file; a source checkout keeps ./config.toml. */
export async function resolveConfig(cli: { config?: string; workspace?: string; port?: number }): Promise<Config> {
  const perUser = !cli.config && process.env.DOI_BINARY ? userPaths() : null;
  const path = perUser?.config ?? cli.config ?? "config.toml";
  let config: Config;
  try {
    if (perUser) await ensureUserConfig();
    config = await loadConfig(path, perUser?.workspace);
  } catch (error) {
    const details = error instanceof z.ZodError
      ? error.issues.map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`).join("; ")
      : error instanceof Error ? error.message : String(error);
    throw new CommandError(EXIT.usage, "invalid_config", `Cannot load config "${resolve(path)}": ${details}`);
  }
  if (cli.workspace) config.workspace = resolve(cli.workspace);
  if (cli.port !== undefined) config.port = cli.port;
  return config;
}

async function launchInfo(record: InstanceRecord, reused: boolean) {
  return {
    ok: true as const,
    reused,
    url: `http://127.0.0.1:${record.port}/`,
    mcp: `http://127.0.0.1:${record.port}/mcp`,
    workspace: record.workspace,
    pid: record.pid,
    instance: record.id,
    version: record.version,
    log: record.log,
    renderer: await rendererStatus(),
  };
}

/** The UI, the API and the MCP endpoint all answer: the only meaning of "ready". */
async function ready(port: number): Promise<boolean> {
  const base = `http://127.0.0.1:${port}`;
  const signal = () => AbortSignal.timeout(3000);
  try {
    if (!(await fetch(`${base}/`, { ...LOCAL, signal: signal() })).ok) return false;
    if (!(await fetch(`${base}/api/projects`, { ...LOCAL, signal: signal() })).ok) return false;
    const mcp = await fetch(`${base}/mcp`, {
      ...LOCAL,
      method: "POST",
      signal: signal(),
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    return mcp.ok;
  } catch {
    return false;
  }
}

/** Starts the server in its own process and returns when it is ready, or throws why it is not. */
export async function start(cli: ServerCli) {
  const config = await resolveConfig(cli);
  const asked = cli.port;
  const existing = await findInstance(config.workspace);
  if (existing) {
    if (asked && asked !== existing.port) {
      throw new CommandError(EXIT.port, "port_conflict", `doi already runs for this workspace on port ${existing.port}, not ${asked}. Stop it with doi stop, or use that port.`);
    }
    return launchInfo(existing, true);
  }
  if (!checkTools().find((t) => t.name === "git")?.found) {
    throw new CommandError(EXIT.tool, "missing_tool", "git is missing. Install git from https://git-scm.com, then start doi again.");
  }
  if (config.port !== 0 && (await portInUse(config.port))) {
    const other = await probe(config.port);
    const who = other ? `doi for the workspace ${other.workspace}` : "another program";
    throw new CommandError(EXIT.port, "port_conflict", `Port ${config.port} is in use by ${who}. Use --port with a free port, or --port 0 to take any free port.`);
  }

  const log = logFile(config.workspace);
  mkdirSync(dirname(log), { recursive: true, mode: 0o700 });
  const out = openSync(log, "a", 0o600);
  const id = crypto.randomUUID();
  const entry = process.env.DOI_BINARY ? [] : [Bun.main];
  const args = [...entry, "serve", "--workspace", config.workspace, "--port", String(config.port), ...(config.configPath ? ["--config", config.configPath] : []), ...(cli.open ? ["--open"] : [])];
  const child = spawn(process.execPath, args, {
    detached: true,
    windowsHide: true,
    stdio: ["ignore", out, out],
    env: { ...process.env, DOI_INSTANCE_ID: id, DOI_LOG: log },
  });
  closeSync(out);
  let ended: number | null | undefined;
  let killedBy: string | null = null;
  child.on("exit", (code, signal) => {
    ended = code;
    killedBy = signal;
  });
  child.on("error", () => void (ended = -1));
  // This command waits for the child's exit event; after that, the server outlives the command.
  const finish = <T>(value: T): T => {
    child.unref();
    return value;
  };

  const file = recordFile(config.workspace);
  const until = Date.now() + READY_MS;
  while (Date.now() < until) {
    if (ended !== undefined) {
      // Two starts at once: the other one has the port, and it serves this workspace.
      const winner = await findInstance(config.workspace);
      if (winner) return finish(await launchInfo(winner, true));
      if (ended === EXIT.port) throw new CommandError(EXIT.port, "port_conflict", `Port ${config.port} is in use. Use --port with a free port, or --port 0.`);
      if (ended === EXIT.usage) throw new CommandError(EXIT.usage, "invalid_config", `doi could not use its config. See ${log}`);
      throw new CommandError(EXIT.readiness, "not_ready", `The server ${killedBy ? `was killed (${killedBy})` : `stopped with code ${ended}`} before it was ready. See ${log}`);
    }
    const record = await readRecord(file);
    if (record?.id === id && (await ready(record.port))) return finish(await launchInfo(record, false));
    await Bun.sleep(100);
  }
  if (child.pid) {
    try {
      process.kill(child.pid); // the process that this command started, and nothing else
    } catch {
      // it ended by itself
    }
  }
  child.unref();
  throw new CommandError(EXIT.readiness, "not_ready", `The server was not ready after ${READY_MS / 1000} s. See ${log}`);
}

export async function status(cli: ServerCli) {
  const config = await resolveConfig(cli);
  const record = await findInstance(config.workspace);
  if (!record) return { ok: true as const, running: false as const, workspace: config.workspace };
  return { ...(await launchInfo(record, true)), running: true as const };
}

/** Stops the doi of this workspace. It acts only after the server itself confirms the identity. */
export async function stop(cli: ServerCli) {
  const config = await resolveConfig(cli);
  const file = recordFile(config.workspace);
  const record = await findInstance(config.workspace, file);
  if (!record) return { ok: true as const, stopped: false as const, workspace: config.workspace };
  try {
    process.kill(record.pid);
  } catch (e) {
    // It ended between the identity check and this signal: that is what the user asked for.
    if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
  }
  const until = Date.now() + 10_000;
  while (Date.now() < until) {
    if (!(await portInUse(record.port, 500))) {
      await removeRecord(file);
      return { ok: true as const, stopped: true as const, workspace: config.workspace, pid: record.pid };
    }
    await Bun.sleep(100);
  }
  throw new CommandError(EXIT.readiness, "not_stopped", `Process ${record.pid} did not stop after 10 s.`);
}

export async function doctor() {
  const tools = checkTools();
  const missing = tools.filter((t) => t.required && !t.found);
  return { ok: missing.length === 0, tools, renderer: await rendererStatus(), exitCode: missing.length ? EXIT.tool : EXIT.ok };
}
