/** The programs that doi uses. Only git is required. Finding one never starts a model request. */
export interface ToolCheck {
  name: string;
  required: boolean;
  found: boolean;
  use: string;
  recovery: string;
}

const TOOLS: Omit<ToolCheck, "found">[] = [
  { name: "git", required: true, use: "The version history of the workspace", recovery: "Install git from https://git-scm.com, then start doi again." },
  { name: "claude", required: false, use: "A Claude subscription through the official CLI", recovery: "Install Claude Code and run claude auth login, or add an API key in Settings." },
  { name: "codex", required: false, use: "A ChatGPT plan through the official CLI", recovery: "Install the Codex CLI and run codex login, or add an API key in Settings." },
  { name: "gh", required: false, use: "A link from a project to a GitHub repo", recovery: "Install the GitHub CLI from https://cli.github.com and run gh auth login." },
];

export function checkTools(which: (name: string) => string | null = (name) => Bun.which(name)): ToolCheck[] {
  return TOOLS.map((tool) => ({ ...tool, found: which(tool.name) !== null }));
}
