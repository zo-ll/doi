// Manual check of a provider with real credentials. Prints every GenerateEvent.
// Usage: bun scripts/try-provider.ts [provider:model] [prompt] [--abort-after <ms>]
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, parseModelRef } from "../src/config.ts";
import { SYSTEM_PROMPT } from "../src/generation/prompts.ts";
import { getProvider } from "../src/providers/registry.ts";

const args = process.argv.slice(2);
const abortIdx = args.indexOf("--abort-after");
const abortAfter = abortIdx >= 0 ? Number(args.splice(abortIdx, 2)[1]) : null;

const ref = parseModelRef(args[0] ?? "anthropic:claude-haiku-5-5");
const prompt = args[1] ?? "Make a small landing page for a coffee shop.";
const provider = getProvider(ref.provider, await loadConfig());

// A throwaway design folder. CLI backends edit it directly; API providers only read it from the prompt.
const cwd = await mkdtemp(join(tmpdir(), "doi-try-"));
const files: Record<string, string> = {
  "index.html": '<!doctype html>\n<html>\n<head><link rel="stylesheet" href="styles.css"></head>\n<body>\n</body>\n</html>\n',
  "styles.css": "body { font-family: system-ui; }\n",
};
for (const [name, text] of Object.entries(files)) await Bun.write(join(cwd, name), text);

const system = [
  SYSTEM_PROMPT.text,
  Object.entries(files).map(([name, text]) => `--- ${name} ---\n${text}`).join("\n"),
];

const controller = new AbortController();
const started = performance.now();
if (abortAfter !== null) setTimeout(() => controller.abort(), abortAfter);

try {
  for await (const event of provider.generate({
    model: ref.model,
    system,
    messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
    signal: controller.signal,
    cwd,
  })) {
    if (event.type === "text") process.stdout.write(event.delta);
    else console.log("\n", JSON.stringify(event).slice(0, 400));
  }
} catch (e) {
  const ms = Math.round(performance.now() - started);
  if (controller.signal.aborted) console.log(`\nStopped after ${ms} ms (abort sent at ${abortAfter} ms).`);
  else throw e;
}
console.log(`\nDesign folder: ${cwd}\nFiles: ${(await readdir(cwd)).join(", ")}`);
