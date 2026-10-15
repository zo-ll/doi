import type { ProviderId } from "../config.ts";
import { lines } from "./cli.ts";

/**
 * OAuth login for the subscription backends, through the official CLIs only. The CLI opens the
 * browser and keeps the token. doi reads only a https URL from the CLI output, so that the UI can
 * show it when no browser opens. doi never reads, copies or stores the token, and never sends
 * the rest of the output (it can name the account) to the UI.
 */
export const LOGIN_COMMANDS: Partial<Record<ProviderId, string[]>> = {
  "claude-code": ["claude", "auth", "login"],
  codex: ["codex", "login"],
};

export interface LoginProc {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(): void;
}

export interface LoginDeps {
  which: (bin: string) => string | null;
  spawn: (cmd: string[]) => LoginProc;
  /** How long to wait for a URL before the route answers without one. */
  urlWaitMs?: number;
  /** A login that the user does not finish stops after this time. */
  maxMs?: number;
}

export const defaultLoginDeps: LoginDeps = {
  which: (bin) => Bun.which(bin),
  spawn(cmd) {
    // stdin stays open and empty: the CLI waits for the browser callback, not for typed input.
    const proc = Bun.spawn(cmd, { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    return { stdout: proc.stdout, stderr: proc.stderr, exited: proc.exited, kill: () => proc.kill() };
  },
};

export type LoginResult = { ok: true; url: string | null } | { ok: false; error: string };

const URL_RE = /https:\/\/[^\s"'<>)\]]+/;

/** The first https URL in a line of CLI output, or null. */
export function loginUrl(line: string): string | null {
  const m = URL_RE.exec(line);
  if (!m) return null;
  try {
    return new URL(m[0]).protocol === "https:" ? m[0] : null;
  } catch {
    return null;
  }
}

interface Running {
  url: Promise<LoginResult>;
}
const running = new Map<ProviderId, Running>();

/** Starts the CLI login, or joins the one that runs. Answers with the login URL when the CLI prints one. */
export function startLogin(id: ProviderId, deps: LoginDeps = defaultLoginDeps): Promise<LoginResult> {
  const cmd = LOGIN_COMMANDS[id];
  if (!cmd) return Promise.resolve({ ok: false, error: "This provider has no OAuth login. Use an API key." });
  const now = running.get(id);
  if (now) return now.url;
  if (!deps.which(cmd[0]!)) return Promise.resolve({ ok: false, error: `${cmd[0]} is not on PATH. Install the CLI first.` });

  const proc = deps.spawn(cmd);
  const stop = setTimeout(() => proc.kill(), deps.maxMs ?? 10 * 60_000);
  const url = new Promise<LoginResult>((resolve) => {
    const wait = setTimeout(() => resolve({ ok: true, url: null }), deps.urlWaitMs ?? 8_000);
    const read = async (stream: ReadableStream<Uint8Array>) => {
      for await (const line of lines(stream)) {
        const found = loginUrl(line);
        if (found) {
          clearTimeout(wait);
          resolve({ ok: true, url: found });
        }
      }
    };
    void read(proc.stdout).catch(() => {});
    void read(proc.stderr).catch(() => {});
    void proc.exited.then((code) => {
      clearTimeout(wait);
      clearTimeout(stop);
      running.delete(id);
      // A resolve after the URL was found changes nothing.
      resolve(code === 0 ? { ok: true, url: null } : { ok: false, error: `${cmd.join(" ")} stopped with exit code ${code}.` });
    });
  });
  running.set(id, { url });
  return url;
}
