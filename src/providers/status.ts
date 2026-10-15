import { keyEnvFor, PROVIDERS, type Config, type ProviderId } from "../config.ts";
import { keyStore, resolveKey, type KeySource, type KeyStore } from "./keys.ts";
import { isImplemented } from "./registry.ts";

/**
 * Where a provider's credentials come from.
 * - api_key: an environment variable named in config.toml, or a key the user added in Settings
 *   (system keychain, else a 0600 file). The variable wins.
 * - cli: a subscription through the official CLI. doi only asks the CLI for its login state;
 *   it never reads, copies or stores the CLI's tokens.
 * - local: a local server (Ollama), no credentials.
 */
export type CredentialSource = "api_key" | "cli" | "local";

export interface ProviderStatus {
  id: ProviderId;
  source: CredentialSource;
  ready: boolean;
  /** Why the provider is not ready, or what it uses when it is. Never contains secrets. */
  detail: string;
  implemented: boolean;
  /** api_key only: where the key comes from, null when there is none. Never the key. */
  keyFrom?: KeySource | null;
  /** api_key only: the environment variable that wins over a stored key. */
  keyEnv?: string;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface StatusDeps {
  env: Record<string, string | undefined>;
  which: (bin: string) => string | null;
  run: (cmd: string[]) => Promise<RunResult>;
  fetch: (url: string) => Promise<{ ok: boolean }>;
  keys: KeyStore;
}

const CLI_TIMEOUT_MS = 10_000;

/** The only detail a ready CLI backend reports: its login state, never the plan or the login method. */
export const LOGGED_IN = "Logged in";

/** The host of a URL, without user information that can hold a credential. */
export function safeHost(url: string): string {
  try {
    // "localhost:11434" parses with "localhost" as the scheme and an empty host.
    return new URL(url).host || "the configured base_url";
  } catch {
    return "the configured base_url";
  }
}

export const defaultDeps: StatusDeps = {
  env: process.env,
  which: (bin) => Bun.which(bin),
  async run(cmd) {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", timeout: CLI_TIMEOUT_MS });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  },
  fetch: (url) => fetch(url, { signal: AbortSignal.timeout(1000) }),
  get keys() {
    return keyStore();
  },
};

async function claudeCode(deps: StatusDeps): Promise<Pick<ProviderStatus, "ready" | "detail">> {
  if (!deps.which("claude")) return { ready: false, detail: "Claude Code CLI not found on PATH" };
  const { code, stdout } = await deps.run(["claude", "auth", "status", "--json"]);
  if (code !== 0) return { ready: false, detail: "claude auth status failed" };
  try {
    // Read only the login state; the output also has account details that must not reach the UI.
    const { loggedIn } = JSON.parse(stdout) as { loggedIn?: boolean };
    if (!loggedIn) return { ready: false, detail: "Not logged in. Run: claude auth login" };
    return { ready: true, detail: LOGGED_IN };
  } catch {
    return { ready: false, detail: "Cannot read claude auth status" };
  }
}

async function codex(deps: StatusDeps): Promise<Pick<ProviderStatus, "ready" | "detail">> {
  if (!deps.which("codex")) return { ready: false, detail: "Codex CLI not found on PATH" };
  // Only the exit code is used: the output names the login method, an account detail.
  const { code } = await deps.run(["codex", "login", "status"]);
  if (code !== 0) return { ready: false, detail: "Not logged in. Run: codex login" };
  return { ready: true, detail: LOGGED_IN };
}

const KEY_DETAIL: Record<KeySource | "none", (env: string) => string> = {
  env: (env) => `Key from ${env}`,
  keychain: () => "Key in the system keychain",
  file: () => "Key in the doi credentials file (0600)",
  none: (env) => `No API key. Add one, or set ${env}`,
};

async function statusOf(id: ProviderId, config: Config, deps: StatusDeps): Promise<ProviderStatus> {
  const implemented = isImplemented(id);
  if (id === "claude-code") return { id, source: "cli", implemented, ...(await claudeCode(deps)) };
  if (id === "codex") return { id, source: "cli", implemented, ...(await codex(deps)) };
  if (id === "ollama") {
    const base = config.providers.ollama?.base_url ?? "http://localhost:11434";
    const ok = await deps.fetch(`${base}/api/tags`).then((r) => r.ok, () => false);
    const host = safeHost(base);
    return { id, source: "local", implemented, ready: ok, detail: ok ? host : `No Ollama server at ${host}` };
  }
  const env = keyEnvFor(id, config)!;
  const key = await resolveKey(id, config, deps.env, deps.keys).catch(() => null);
  const from = key?.from ?? null;
  return { id, source: "api_key", implemented, ready: Boolean(key), detail: KEY_DETAIL[from ?? "none"](env), keyFrom: from, keyEnv: env };
}

export function providerStatus(config: Config, deps: StatusDeps = defaultDeps): Promise<ProviderStatus[]> {
  return Promise.all(PROVIDERS.map((id) => statusOf(id, config, deps)));
}
