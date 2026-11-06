import { resolve } from "node:path";
import { z } from "zod";
import { loadConfig, type Config } from "../config.ts";
import { installBrowser, isDownloadChild, runDownloadChild } from "../export/browser.ts";
import { version } from "../../package.json";
import { ensureUserConfig } from "../user-dirs.ts";
import { startServer } from "./app.ts";
import { openCommand, parseCli, USAGE, type Cli } from "./cli.ts";

if (isDownloadChild()) {
  runDownloadChild();
} else {
  let cli: Cli;
  try {
    cli = parseCli(process.argv.slice(2));
  } catch (e) {
    console.error(`${e instanceof Error ? e.message : e}\n\n${USAGE}`);
    process.exit(2);
  }
  if (cli.command === "help") {
    console.log(USAGE);
  } else if (cli.command === "version") {
    console.log(`doi ${version}`);
  } else if (cli.command === "install-browser") {
    await installBrowser();
  } else if (cli.command === "start") {
    let config: Config;
    // The build sets DOI_BINARY: an installed doi works from any folder. A source checkout keeps
    // its own ./config.toml and ./workspace.
    let path = cli.config ?? "config.toml";
    try {
      if (!cli.config && process.env.DOI_BINARY) path = await ensureUserConfig();
      config = await loadConfig(path);
    } catch (error) {
      const details = error instanceof z.ZodError
        ? error.issues.map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`).join("; ")
        : error instanceof Error ? error.message : String(error);
      console.error(`Cannot load config "${resolve(path)}": ${details}`);
      process.exit(2);
    }
    if (cli.workspace) config.workspace = resolve(cli.workspace);
    if (cli.port) config.port = cli.port;
    const { server } = await startServer(config);
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
}
