import { cp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { HarnessId } from "../config.ts";
import { createClaudeCode } from "../providers/claude-code.ts";
import type { HandoffBundle, Harness, RunHandle } from "./types.ts";

export const HANDOFF_DIR = ".design-handoff";
export const HANDOFF_PROMPT = `Implement the design in ${HANDOFF_DIR}/ and follow ${HANDOFF_DIR}/HANDOFF.md.`;

function cliHarness(id: HarnessId, bin: string, headless: string[]): Harness {
  return {
    id,
    bin,
    headless,
    async detect() {
      return Bun.which(bin) !== null;
    },
    async handoff(bundle: HandoffBundle, repoPath: string): Promise<RunHandle> {
      const target = join(repoPath, HANDOFF_DIR);
      await mkdir(target, { recursive: true });
      await cp(bundle.dir, target, { recursive: true });
      const proc = Bun.spawn([bin, ...headless, HANDOFF_PROMPT], {
        cwd: repoPath,
        stdout: "inherit",
        stderr: "inherit",
      });
      return { pid: proc.pid, exited: proc.exited };
    },
  };
}

// Flags change between releases. Verify each one before M4.
export const harnesses: Record<HarnessId, Harness> = {
  "claude-code": { ...cliHarness("claude-code", "claude", ["-p"]), asProvider: (config) => createClaudeCode(config) },
  codex: cliHarness("codex", "codex", ["exec"]),
  opencode: cliHarness("opencode", "opencode", ["run"]),
  "gemini-cli": cliHarness("gemini-cli", "gemini", ["-p"]),
  aider: cliHarness("aider", "aider", ["--message"]),
};

export async function detectHarnesses(): Promise<Record<HarnessId, boolean>> {
  const entries = await Promise.all(
    Object.values(harnesses).map(async (h) => [h.id, await h.detect()] as const),
  );
  return Object.fromEntries(entries) as Record<HarnessId, boolean>;
}
