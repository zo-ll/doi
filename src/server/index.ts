import { installBrowser, isDownloadChild, runDownloadChild } from "../export/browser.ts";
import { version } from "../../package.json";
import { startServer } from "./app.ts";
import { CommandError, EXIT, openCommand, parseCli, USAGE, type Cli, type ServerCli } from "./cli.ts";
import { doctor, resolveConfig, start, status, stop } from "./commands.ts";
import { claimRecord, findInstance, recordFile, releaseRecord } from "./instance.ts";

/** Runs the server in this process, for the terminal or for a background start. */
async function runServer(cli: ServerCli): Promise<void> {
  const config = await resolveConfig(cli);
  const file = recordFile(config.workspace);
  const other = await findInstance(config.workspace, file);
  if (other && other.pid !== process.pid) {
    throw new CommandError(EXIT.port, "already_running", `doi already runs for this workspace at http://127.0.0.1:${other.port}/ (process ${other.pid}). One workspace has one server. Use doi stop first.`);
  }
  let started;
  try {
    started = await startServer(config, { instanceId: process.env.DOI_INSTANCE_ID });
  } catch (e) {
    if ((e as { code?: string }).code === "EADDRINUSE" || /EADDRINUSE|port \d+ in use/i.test(String(e))) {
      throw new CommandError(EXIT.port, "port_conflict", `Port ${config.port} is in use. Use --port with a free port.`);
    }
    throw e;
  }
  const { server, instanceId } = started;
  const winner = await claimRecord({ id: instanceId, pid: process.pid, workspace: config.workspace, version, port: server.port!, log: process.env.DOI_LOG ?? null }, file);
  if (winner) {
    started.stop();
    throw new CommandError(EXIT.port, "already_running", `doi already runs for this workspace at http://127.0.0.1:${winner.port}/ (process ${winner.pid}).`);
  }
  const end = () => void releaseRecord(process.pid, file).finally(() => process.exit(0));
  process.once("SIGINT", end);
  process.once("SIGTERM", end);
  const url = server.url.href;
  console.log(`doi is running at ${url}`);
  if (cli.open) {
    try {
      Bun.spawn(openCommand(url), { stdio: ["ignore", "ignore", "ignore"] });
    } catch {
      console.log("Could not open a browser. Open the URL above.");
    }
  }
}

/** Machine output goes to stdout as one JSON object; words for a person go there without --json. */
function report(json: boolean, value: object, words: string): void {
  console.log(json ? JSON.stringify(value) : words);
}

if (isDownloadChild()) {
  runDownloadChild();
} else {
  let cli: Cli | undefined;
  try {
    cli = parseCli(process.argv.slice(2));
    if (cli.command === "help") console.log(USAGE);
    else if (cli.command === "version") console.log(`doi ${version}`);
    else if (cli.command === "install-browser") await installBrowser();
    else if (cli.command === "run" || cli.command === "serve") await runServer(cli);
    else if (cli.command === "start") {
      const info = await start(cli);
      report(cli.json, info, `doi is ${info.reused ? "already running" : "running"} at ${info.url}\nMCP: ${info.mcp}\nWorkspace: ${info.workspace}\nRenderer: ${info.renderer.detail}`);
    } else if (cli.command === "status") {
      const info = await status(cli);
      report(cli.json, info, info.running ? `doi runs at ${info.url}\nMCP: ${info.mcp}\nWorkspace: ${info.workspace}\nRenderer: ${info.renderer.detail}` : `doi does not run for ${info.workspace}`);
      if (!info.running) process.exitCode = EXIT.notRunning;
    } else if (cli.command === "stop") {
      const info = await stop(cli);
      report(cli.json, info, info.stopped ? `doi stopped (process ${info.pid}).` : `doi does not run for ${info.workspace}`);
    } else if (cli.command === "doctor") {
      const { exitCode, ...info } = await doctor();
      const lines = info.tools.map((t) => `${t.found ? "ok     " : t.required ? "MISSING" : "absent "} ${t.name}: ${t.use}${t.found ? "" : `. ${t.recovery}`}`);
      report(cli.json, info, [...lines, `${info.renderer.ready ? "ok     " : "absent "} renderer: ${info.renderer.detail}`].join("\n"));
      process.exitCode = exitCode;
    }
  } catch (e) {
    const json = cli && "json" in cli && cli.json;
    const failure = e instanceof CommandError ? e : null;
    const message = e instanceof Error ? e.message : String(e);
    // Bad usage has no parsed command: it gets the help text.
    if (!cli) console.error(`${message}\n\n${USAGE}`);
    else if (json) console.log(JSON.stringify({ ok: false, code: failure?.code ?? "failed", message }));
    else console.error(message);
    // Exit at once: a server that failed on its port still has a design watcher, which keeps a process alive.
    process.exit(failure?.exitCode ?? (cli ? EXIT.readiness : EXIT.usage));
  }
}
