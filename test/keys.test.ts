import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../src/config.ts";
import { checkKey, credentialsFile, memoryKeyStore, resolveKey, systemKeyStore, type Keychain } from "../src/providers/keys.ts";

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "doi-keys-"));
  file = join(dir, "doi", "credentials.json");
});
afterEach(() => rm(dir, { recursive: true, force: true }));

/** A keychain in memory, or one that fails like WSL without libsecret. */
function keychain(works = true): Keychain & { data: Map<string, string> } {
  const data = new Map<string, string>();
  const no = () => Promise.reject(Object.assign(new Error("libsecret not available"), { code: "ERR_SECRETS_PLATFORM_ERROR" }));
  return {
    data,
    get: async (o) => (works ? (data.get(`${o.service}/${o.name}`) ?? null) : no()),
    set: async (o) => (works ? void data.set(`${o.service}/${o.name}`, o.value) : no()),
    delete: async (o) => (works ? data.delete(`${o.service}/${o.name}`) : no()),
  };
}

describe("systemKeyStore", () => {
  test("uses the keychain when it works and writes no file", async () => {
    const kc = keychain();
    const store = systemKeyStore(file, kc);
    expect(await store.set("opencode-go", "sk-1")).toBe("keychain");
    expect(kc.data.get("doi/opencode-go")).toBe("sk-1");
    expect(await Bun.file(file).exists()).toBe(false);
    expect(await store.get("opencode-go")).toEqual({ value: "sk-1", where: "keychain" });
    expect(await store.delete("opencode-go")).toBe(true);
    expect(await store.get("opencode-go")).toBeNull();
  });

  test("falls back to a 0600 file when the keychain fails", async () => {
    const store = systemKeyStore(file, keychain(false));
    expect(await store.set("opencode-go", "sk-2")).toBe("file");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, "doi"))).mode & 0o777).toBe(0o700);
    expect(await store.get("opencode-go")).toEqual({ value: "sk-2", where: "file" });
    await store.set("openai", "sk-3");
    expect(await Bun.file(file).json()).toEqual({ "opencode-go": "sk-2", openai: "sk-3" });
    expect(await store.delete("opencode-go")).toBe(true);
    expect(await store.delete("opencode-go")).toBe(false);
    expect(await store.delete("openai")).toBe(true);
    // The last key removes the file.
    expect(await Bun.file(file).exists()).toBe(false);
  });

  test("a key moved to a working keychain leaves the file", async () => {
    await systemKeyStore(file, keychain(false)).set("openai", "old");
    const store = systemKeyStore(file, keychain());
    expect(await store.set("openai", "new")).toBe("keychain");
    expect(await Bun.file(file).exists()).toBe(false);
    expect(await store.get("openai")).toEqual({ value: "new", where: "keychain" });
  });

  test("a broken file counts as no keys", async () => {
    await Bun.write(file, "not json");
    expect(await systemKeyStore(file, keychain(false)).get("openai")).toBeNull();
  });
});

test("credentialsFile follows XDG_CONFIG_HOME", () => {
  expect(credentialsFile({ XDG_CONFIG_HOME: "/x" })).toBe("/x/doi/credentials.json");
});

test("resolveKey: the variable wins, then the store", async () => {
  const config = parseConfig({ providers: { openai: { api_key_env: "MY_KEY" } } }, "/tmp/doi");
  const keys = memoryKeyStore({ openai: "stored" }, "file");
  expect(await resolveKey("openai", config, { MY_KEY: "env" }, keys)).toEqual({ value: "env", from: "env" });
  expect(await resolveKey("openai", config, {}, keys)).toEqual({ value: "stored", from: "file" });
  expect(await resolveKey("anthropic", config, {}, keys)).toBeNull();
});

test("checkKey takes one line of visible characters", () => {
  expect(checkKey("  sk-abc_123  ")).toBe("sk-abc_123");
  for (const bad of ["", "  ", "a b", "a\nb", "é", 42, null, "x".repeat(4097)]) expect(checkKey(bad)).toBeNull();
});
