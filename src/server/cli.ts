import { parseArgs } from "node:util";

/** Exit codes. An agent can act on them, and they stay the same between versions. */
export const EXIT = { ok: 0, notRunning: 1, usage: 2, tool: 3, readiness: 4, port: 5 } as const;

export const USAGE = `Usage: doi [options]
       doi start | status | stop [options] [--json]
       doi doctor [--json]
       doi install-browser

Options:
  --config <file>     The config file (default: the per-user config.toml; from a source checkout, ./config.toml)
  --workspace <dir>   The workspace folder (default: from the config)
  --port <n>          The port on 127.0.0.1 (default: from the config, else 4317)
  --open              Open doi in the browser after the start
  --json              Print one JSON object on stdout, and nothing else there
  -v, --version       Show the version
  -h, --help          Show this help

Commands:
  (no command)        Run doi in this terminal until you stop it
  start               Start doi in the background. Returns when the UI, API and MCP are ready
  status              Show the doi of this workspace. Exit code 1 when it does not run
  stop                Stop the doi of this workspace, and no other process
  doctor              Check git, the model CLIs, gh and the renderer. No model request
  install-browser     Install Chromium for PNG and PDF export

Exit codes: 0 done, 1 not running, 2 bad usage or config, 3 missing tool, 4 not ready, 5 port conflict`;

export type Cli =
  | { command: "run" | "serve" | "start" | "status" | "stop"; config?: string; workspace?: string; port?: number; open: boolean; json: boolean }
  | { command: "doctor"; json: boolean }
  | { command: "install-browser" | "help" | "version" };

/** A command that works on one server: its config, workspace and port. */
export type ServerCli = Extract<Cli, { open: boolean }>;

const COMMANDS = ["serve", "start", "status", "stop"] as const;

/** The command line of doi (without the program name). Throws a message for bad input. */
export function parseCli(argv: string[]): Cli {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: "string" },
      workspace: { type: "string" },
      port: { type: "string" },
      open: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      version: { type: "boolean", short: "v", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) return { command: "help" };
  if (values.version) return { command: "version" };
  if (positionals.length > 1) throw new Error(`Unknown arguments: ${positionals.join(" ")}`);
  const word = positionals[0];
  if (word === "install-browser") return { command: "install-browser" };
  if (word === "doctor") return { command: "doctor", json: values.json };
  const command = COMMANDS.find((c) => c === word) ?? "run";
  if (word !== undefined && command === "run") throw new Error(`Unknown command "${word}".`);
  let port: number | undefined;
  if (values.port !== undefined) {
    port = Number(values.port);
    // Port 0 takes any free port. Only the background start can report the port that it got.
    const zero = port === 0 && (command === "start" || command === "serve");
    if (!/^\d+$/.test(values.port) || (port < 1 && !zero) || port > 65535) throw new Error("--port must be a number from 1 to 65535.");
  }
  if (values.workspace === "") throw new Error("--workspace must be a folder.");
  if (values.config === "") throw new Error("--config must be a file.");
  return { command, config: values.config, workspace: values.workspace, port, open: values.open, json: values.json };
}

/** The command that opens a URL in the default browser on this system. */
export function openCommand(url: string, platform: NodeJS.Platform = process.platform): string[] {
  if (platform === "darwin") return ["open", url];
  if (platform === "win32") return ["cmd", "/c", "start", "", url];
  return ["xdg-open", url];
}
