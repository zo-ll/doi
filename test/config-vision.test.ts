import { expect, test } from "bun:test";
import { parseConfig } from "../src/config.ts";
import { configView } from "../src/server/settings.ts";

test("/api/config says per task whether its model can read images", () => {
  const config = parseConfig({
    models: {
      generate: "opencode-go:deepseek-v4.1-flash",
      edit: "claude-code:claude-sonnet-5-5",
      extract: "google:gemini-3-pro",
    },
  });
  // DeepSeek on OpenCode Go uses the chat format without vision; Claude reads images;
  // doi has no Gemini adapter yet, so it cannot tell.
  expect(configView(config).vision).toEqual({ generate: false, edit: true, extract: null });
});
