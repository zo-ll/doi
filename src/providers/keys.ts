import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { keyEnvFor, type Config, type ProviderId } from "../config.ts";

/**
 * API keys that the user adds in Settings. doi keeps them in the system keychain (Bun.secrets).
 * When the keychain is not available (for example WSL without libsecret), doi keeps them in a
 * file that only the user can read (0600). An environment variable always wins over a stored key.
 */
export type KeyLocation = "keychain" | "file";
export type KeySource = "env" | KeyLocation;

export interface StoredKey {
  value: string;
  where: KeyLocation;
}

export interface KeyStore {
  get(id: ProviderId): Promise<StoredKey | null>;
  /** Stores the key and returns where it went. */
  set(id: ProviderId, value: string): Promise<KeyLocation>;
  /** True when a key was removed. */
  delete(id: ProviderId): Promise<boolean>;
}

const SERVICE = "doi";

export function credentialsFile(env: Record<string, string | undefined> = process.env): string {
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "doi", "credentials.json");
}

export interface Keychain {
  get(o: { service: string; name: string }): Promise<string | null>;
  set(o: { service: string; name: string; value: string }): Promise<void>;
  delete(o: { service: string; name: string }): Promise<boolean>;
}

/** The keychain first, the file when the keychain fails. */
export function systemKeyStore(file = credentialsFile(), keychain: Keychain = Bun.secrets): KeyStore {
  const readFile = async (): Promise<Record<string, string>> => {
    const f = Bun.file(file);
    if (!(await f.exists())) return {};
    try {
      const data = JSON.parse(await f.text());
      return typeof data === "object" && data !== null ? data : {};
    } catch {
      return {};
    }
  };
  const writeKeys = async (keys: Record<string, string>) => {
    if (Object.keys(keys).length === 0) {
      await rm(file, { force: true });
      return;
    }
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    // Write a new file and rename it, so a crash never leaves half a file; mode 0600 from the start.
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(keys, null, 2) + "\n", { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, file);
  };
  const name = (id: ProviderId) => ({ service: SERVICE, name: id });

  return {
    async get(id) {
      try {
        const value = await keychain.get(name(id));
        if (value) return { value, where: "keychain" };
      } catch {
        // No keychain: the file is the store.
      }
      const value = (await readFile())[id];
      return typeof value === "string" && value ? { value, where: "file" } : null;
    },
    async set(id, value) {
      const keys = await readFile();
      try {
        await keychain.set({ ...name(id), value });
        if (id in keys) {
          delete keys[id];
          await writeKeys(keys);
        }
        return "keychain";
      } catch {
        keys[id] = value;
        await writeKeys(keys);
        return "file";
      }
    },
    async delete(id) {
      let removed = false;
      try {
        removed = await keychain.delete(name(id));
      } catch {
        // No keychain.
      }
      const keys = await readFile();
      if (id in keys) {
        delete keys[id];
        await writeKeys(keys);
        removed = true;
      }
      return removed;
    },
  };
}

/** A store in memory, for tests. */
export function memoryKeyStore(initial: Partial<Record<ProviderId, string>> = {}, where: KeyLocation = "keychain"): KeyStore {
  const keys = new Map(Object.entries(initial) as [ProviderId, string][]);
  return {
    get: async (id) => (keys.has(id) ? { value: keys.get(id)!, where } : null),
    set: async (id, value) => (keys.set(id, value), where),
    delete: async (id) => keys.delete(id),
  };
}

let store: KeyStore = systemKeyStore();

export function keyStore(): KeyStore {
  return store;
}

/** Replaces the store, for tests. Returns the old one. */
export function setKeyStore(next: KeyStore): KeyStore {
  const old = store;
  store = next;
  return old;
}

/** The key of an API provider: its environment variable first, then the stored key. */
export async function resolveKey(
  id: ProviderId,
  config: Pick<Config, "providers">,
  env: Record<string, string | undefined> = process.env,
  keys: KeyStore = store,
): Promise<{ value: string; from: KeySource } | null> {
  const name = keyEnvFor(id, config);
  if (name && env[name]) return { value: env[name]!, from: "env" };
  const stored = await keys.get(id);
  return stored ? { value: stored.value, from: stored.where } : null;
}

/** The key for a request, or an error that says how to add one. */
export async function requireKey(id: ProviderId, config: Pick<Config, "providers">, label: string): Promise<string> {
  const key = await resolveKey(id, config);
  if (key) return key.value;
  throw new Error(`No API key for ${label}. Add one in Settings (Models and providers), or set ${keyEnvFor(id, config)}.`);
}

/** A key that a user pasted: one line of visible characters. */
export function checkKey(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const key = raw.trim();
  return key.length > 0 && key.length <= 4096 && /^[\x21-\x7e]+$/.test(key) ? key : null;
}
