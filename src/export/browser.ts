// Chromium for PNG and PDF export (#47), installed without the Playwright CLI, so that the
// compiled binary (#63) can install it on a computer without Bun or Node.
import { registry } from "playwright-core/lib/coreBundle";

const BROWSERS = ["chromium-headless-shell"];

/**
 * True in the child process that Playwright starts to download a browser. Playwright forks
 * its own entry script; in the compiled binary that runs the binary again with that path.
 */
export const isDownloadChild = (argv = process.argv) => argv.some((a) => a.endsWith("oopBrowserDownload.js"));

/** Runs the download child: it takes its task from the parent process. */
export function runDownloadChild(): void {
  registry.runOopDownloadBrowserMain();
}

/** Downloads the Chromium build that playwright-core needs, into the Playwright cache. */
export async function installBrowser(): Promise<void> {
  const r = registry.registry;
  await r.install(r.resolveBrowsers(BROWSERS, {}), { force: false });
}
