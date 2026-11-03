/**
 * Provider connection state shared by Settings (ProviderAuth) and the first-use flow.
 *
 * The API key and the OAuth wait live here, so both places use the same routes and the same
 * security rules: the server stores the key; doi never reads a CLI token.
 */
import { useCallback, useEffect, useState } from "react";
import { sendJSON } from "./api.ts";
import { LOGIN_POLL_MS, loginTick, type Login } from "./login.ts";

export interface ProviderAuth {
  /** The key field; it is cleared after a save and never returned by the server. */
  key: string;
  setKey: (value: string) => void;
  busy: boolean;
  error: string | null;
  note: string | null;
  /** The official CLI login that waits for the status check. */
  login: Login;
  /** Saves the key through PUT /api/providers/:id/key. False when there is nothing to save or it failed. */
  saveKey: () => Promise<boolean>;
  removeKey: () => Promise<void>;
  startLogin: () => Promise<void>;
  /** Clears the key, the messages and a pending login: a vendor or method change must not keep them. */
  reset: () => void;
  setError: (value: string | null) => void;
  setNote: (value: string | null) => void;
}

/**
 * The auth state of one provider. A new provider id clears the old key, errors and login wait,
 * because they belong to the provider that the person just left.
 */
export function useProviderAuth(providerId: string | null, ready: boolean, onRecheck: () => void): ProviderAuth {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [login, setLogin] = useState<Login>({ state: "idle" });

  const reset = useCallback(() => {
    setKey("");
    setBusy(false);
    setError(null);
    setNote(null);
    setLogin({ state: "idle" });
  }, []);

  useEffect(() => {
    reset();
  }, [providerId, reset]);

  // While the user logs in in the browser, check the status until the CLI reports a login.
  useEffect(() => {
    if (login.state !== "waiting") return;
    const tick = loginTick(login, ready, Date.now());
    if (!tick.keep) {
      setLogin({ state: "idle" });
      if (tick.note) setNote(tick.note);
      if (tick.error) setError(tick.error);
      return;
    }
    const t = setTimeout(onRecheck, LOGIN_POLL_MS);
    return () => clearTimeout(t);
    // `ready` changes after each status check, so the next check follows.
  }, [login, ready, onRecheck]);

  const run = useCallback(
    async (what: () => Promise<string | null>) => {
      setBusy(true);
      setError(null);
      setNote(null);
      try {
        const message = await what();
        if (message) setNote(message);
        onRecheck();
        return true;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [onRecheck],
  );

  const saveKey = useCallback(() => {
    const value = key.trim();
    if (!providerId || !value) return Promise.resolve(false);
    return run(async () => {
      const { where } = await sendJSON<{ where: "keychain" | "file" }>("PUT", `/api/providers/${providerId}/key`, { key: value });
      setKey("");
      return where === "keychain" ? "Saved in the system keychain." : "No system keychain here. Saved in the doi credentials file (only you can read it).";
    });
  }, [key, providerId, run]);

  const removeKey = useCallback(async () => {
    if (!providerId) return;
    await run(async () => {
      await sendJSON("DELETE", `/api/providers/${providerId}/key`);
      return "Key removed.";
    });
  }, [providerId, run]);

  const startLogin = useCallback(async () => {
    if (!providerId) return;
    setLogin({ state: "starting" });
    setError(null);
    setNote(null);
    try {
      const { url } = await sendJSON<{ url: string | null }>("POST", `/api/providers/${providerId}/login`);
      setLogin({ state: "waiting", url, since: Date.now() });
    } catch (e) {
      setLogin({ state: "idle" });
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [providerId]);

  return { key, setKey, busy, error, note, login, saveKey, removeKey, startLogin, reset, setError, setNote };
}
