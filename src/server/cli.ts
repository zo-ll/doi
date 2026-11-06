import { parseArgs } from "node:util";

export const USAGE = `Usage: doi [options]
       doi install-browser

Options:
  --config <file>     The config file (default: the per-user config.toml; from a source checkout, ./config.toml)
  --workspace <dir>   The workspace folder (default: from the config)
  --port <n>          The port on 127.0.0.1 (default: from the config, else 4317)
  --open              Open doi in the browser after the start
  -v, --version       Show the version
  -h, --help          Show this help

Commands:
  install-browser     Install Chromium for PNG and PDF export`;

export type Cli =
  | { command: "start"; config?: string; workspace?: string; port?: number; open: boolean }
  | { command: "install-browser" | "help" | "version" };

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
      version: { type: "boolean", short: "v", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) return { command: "help" };
  if (values.version) return { command: "version" };
  if (positionals.length > 1) throw new Error(`Unknown arguments: ${positionals.join(" ")}`);
  if (positionals[0] === "install-browser") return { command: "install-browser" };
  if (positionals[0] !== undefined) throw new Error(`Unknown command "${positionals[0]}".`);
  let port: number | undefined;
  if (values.port !== undefined) {
    port = Number(values.port);
    if (!/^\d+$/.test(values.port) || port < 1 || port > 65535) throw new Error("--port must be a number from 1 to 65535.");
  }
  if (values.workspace === "") throw new Error("--workspace must be a folder.");
  if (values.config === "") throw new Error("--config must be a file.");
  return { command: "start", config: values.config, workspace: values.workspace, port, open: values.open };
}

/** The command that opens a URL in the default browser on this system. */
export function openCommand(url: string, platform: NodeJS.Platform = process.platform): string[] {
  if (platform === "darwin") return ["open", url];
  if (platform === "win32") return ["cmd", "/c", "start", "", url];
  return ["xdg-open", url];
}
