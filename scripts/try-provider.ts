// Manual check of a provider adapter with a real key. Prints every GenerateEvent.
// Usage: bun scripts/try-provider.ts [provider:model] [prompt]
import { loadConfig, parseModelRef } from "../src/config.ts";
import { getProvider } from "../src/providers/registry.ts";

const ref = parseModelRef(process.argv[2] ?? "anthropic:claude-haiku-5-5");
const prompt = process.argv[3] ?? "Make a small landing page for a coffee shop.";
const provider = getProvider(ref.provider, await loadConfig());

const files = {
  "index.html": '<!doctype html>\n<html>\n<head><link rel="stylesheet" href="styles.css"></head>\n<body>\n</body>\n</html>\n',
  "styles.css": "body { font-family: system-ui; }\n",
};
const system = [
  "You design web pages as plain HTML and CSS. Use the edit tool for changes to existing files and the write tool for new files. Put a data-oid attribute on each meaningful element.",
  Object.entries(files).map(([name, text]) => `--- ${name} ---\n${text}`).join("\n"),
];

for await (const event of provider.generate({
  model: ref.model,
  system,
  messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
})) {
  if (event.type === "text") process.stdout.write(event.delta);
  else console.log("\n", JSON.stringify(event).slice(0, 400));
}
