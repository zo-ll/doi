import type { HarnessId } from "../config.ts";
import type { Provider } from "../providers/types.ts";

export interface HandoffBundle {
  /** Folder with design/, screenshots/, HANDOFF.md and tokens.css. */
  dir: string;
}

export interface RunHandle {
  pid: number;
  exited: Promise<number>;
}

export interface Harness {
  id: HarnessId;
  /** The CLI binary to look for on PATH. */
  bin: string;
  /** Headless command, without the prompt. Check flags against the CLI docs before use. */
  headless: string[];
  detect(): Promise<boolean>;
  handoff(bundle: HandoffBundle, repoPath: string): Promise<RunHandle>;
  /** Only for CLIs that stream structured output. In v1, Claude Code only (M5). */
  asProvider?(): Provider;
}
