/**
 * The login wait of the official CLIs, shared by Settings (ProviderAuth) and the first-use flow.
 * The CLI keeps the token; doi only asks for the status again until the CLI reports a login.
 */

/** While a login runs, doi asks for the status this often. */
export const LOGIN_POLL_MS = 3_000;
/** A login that is not done after this long stops waiting. */
export const LOGIN_WAIT_MS = 5 * 60_000;

export type Login = { state: "idle" } | { state: "starting" } | { state: "waiting"; url: string | null; since: number };

export type LoginTick =
  /** Wait again after LOGIN_POLL_MS. */
  | { keep: true }
  /** Stop waiting; the flow goes back to idle. */
  | { keep: false; note?: string; error?: string };

/** What a running login does now: it is done, it timed out, or it waits for the next status check. */
export function loginTick(login: Login, ready: boolean, now: number): LoginTick {
  if (login.state !== "waiting") return { keep: false };
  if (ready) return { keep: false, note: "Logged in." };
  if (now - login.since > LOGIN_WAIT_MS) return { keep: false, error: "No login after 5 minutes. Try again." };
  return { keep: true };
}
