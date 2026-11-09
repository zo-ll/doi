// Builds doi as one binary for each target (#63): bun run build [target…]
// Without targets: Linux and Windows on x64 and arm64, plus macOS on arm64. The binaries go to dist/.
import { version } from "../package.json";

const RELEASE = ["bun-linux-x64", "bun-linux-arm64", "bun-windows-x64", "bun-windows-arm64", "bun-darwin-arm64"] as const;
type Target = (typeof RELEASE)[number];

const asked = process.argv.slice(2);
const bad = asked.filter((t) => !(RELEASE as readonly string[]).includes(t));
if (bad.length) {
  console.error(`Unknown target: ${bad.join(", ")}. Targets: ${RELEASE.join(", ")}`);
  process.exit(2);
}
const targets = (asked.length ? asked : RELEASE) as Target[];

/**
 * playwright-core 1.63.0 requires its package.json and browsers.json through a path that it
 * joins at runtime, so the bundler leaves them out and the binary looks for them at the build
 * path. This plugin makes the two requires static. A changed bundle stops the build.
 */
const PLAYWRIGHT_FILES = [
  ['require(import_path9.default.join(packageRoot, "package.json"))', 'require("../package.json")'],
  ['require(import_path20.default.join(packageRoot, "browsers.json"))', 'require("../browsers.json")'],
] as const;

const playwrightFiles: Bun.BunPlugin = {
  name: "playwright-files",
  setup(build) {
    build.onLoad({ filter: /playwright-core[\\/]lib[\\/]coreBundle\.js$/ }, async ({ path }) => {
      let code = await Bun.file(path).text();
      for (const [from, to] of PLAYWRIGHT_FILES) {
        if (code.split(from).length !== 2) throw new Error(`playwright-core changed: "${from}" is not in ${path} once. Update scripts/build.ts.`);
        code = code.replace(from, to);
      }
      return { contents: code, loader: "js" };
    });
  },
};

for (const target of targets) {
  const outfile = `dist/doi-${version}-${target.slice("bun-".length)}${target.includes("windows") ? ".exe" : ""}`;
  const result = await Bun.build({
    entrypoints: ["src/server/index.ts"],
    compile: {
      target,
      outfile,
      // A .env or bunfig.toml in the folder where the user starts doi is not doi's.
      autoloadDotenv: false,
      autoloadBunfig: false,
    },
    minify: true,
    define: { "process.env.NODE_ENV": JSON.stringify("production"), "process.env.DOI_BINARY": JSON.stringify("1") },
    // Playwright loads chromium-bidi only for the BiDi protocol; doi uses Chromium over CDP.
    external: ["chromium-bidi", "chromium-bidi/*"],
    plugins: [playwrightFiles],
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
  console.log(outfile);
}
