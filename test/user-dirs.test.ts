import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credentialsFile } from "../src/providers/keys.ts";
import { loadConfig } from "../src/config.ts";
import { credentialsPath, ensureUserConfig, firstConfig, userDirs, userPaths } from "../src/user-dirs.ts";

describe("userDirs", () => {
  test("Linux: the XDG folders, else the defaults under the home folder", () => {
    expect(userDirs({}, "linux", "/home/a")).toEqual({ config: "/home/a/.config/doi", data: "/home/a/.local/share/doi" });
    expect(userDirs({ XDG_CONFIG_HOME: "/x/c", XDG_DATA_HOME: "/x/d" }, "linux", "/home/a")).toEqual({ config: "/x/c/doi", data: "/x/d/doi" });
  });

  test("a relative XDG path counts as missing, so the shell folder cannot decide the workspace", () => {
    expect(userDirs({ XDG_CONFIG_HOME: "rel", XDG_DATA_HOME: "./d" }, "linux", "/home/a")).toEqual({ config: "/home/a/.config/doi", data: "/home/a/.local/share/doi" });
  });

  test("Windows: APPDATA and LOCALAPPDATA, else the profile", () => {
    expect(userDirs({ APPDATA: "C:\\Users\\A B\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\A B\\AppData\\Local" }, "win32", "C:\\Users\\A B")).toEqual({
      config: "C:\\Users\\A B\\AppData\\Roaming\\doi",
      data: "C:\\Users\\A B\\AppData\\Local\\doi",
    });
    expect(userDirs({}, "win32", "C:\\Users\\A")).toEqual({ config: "C:\\Users\\A\\AppData\\Roaming\\doi", data: "C:\\Users\\A\\AppData\\Local\\doi" });
  });

  test("a relative Windows path counts as missing too", () => {
    expect(userDirs({ APPDATA: "rel", LOCALAPPDATA: ".\\d" }, "win32", "C:\\Users\\A")).toEqual({ config: "C:\\Users\\A\\AppData\\Roaming\\doi", data: "C:\\Users\\A\\AppData\\Local\\doi" });
  });

  test("credentials stay in the config folder, at the same path on Linux as before", () => {
    expect(credentialsFile({ XDG_CONFIG_HOME: "/x/c" })).toBe("/x/c/doi/credentials.json");
  });

  test("on Windows, a key file from an older doi stays reachable until a new file exists", () => {
    const env = { APPDATA: "C:\\R" };
    const home = "C:\\Users\\A";
    const current = "C:\\R\\doi\\credentials.json";
    const older = "C:\\Users\\A\\.config\\doi\\credentials.json";
    expect(credentialsPath(env, "win32", home, () => false)).toBe(current);
    expect(credentialsPath(env, "win32", home, (p) => p === older)).toBe(older);
    expect(credentialsPath(env, "win32", home, () => true)).toBe(current);
  });

  test("the per-user paths on each system", () => {
    expect(userPaths({ config: "/c/doi", data: "/d/doi" }, "linux")).toEqual({ config: "/c/doi/config.toml", workspace: "/d/doi/workspace" });
    expect(userPaths({ config: "C:\\c\\doi", data: "C:\\d\\doi" }, "win32")).toEqual({ config: "C:\\c\\doi\\config.toml", workspace: "C:\\d\\doi\\workspace" });
  });
});

describe("ensureUserConfig", () => {
  const withDirs = async (run: (dirs: { config: string; data: string }) => Promise<void>) => {
    const root = await mkdtemp(join(tmpdir(), "doi user dirs "));
    try {
      await run({ config: join(root, "c fg", "doi"), data: join(root, "da\"ta", "doi") });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  };

  test("the first start makes private folders and a config that names the same workspace each time", async () => {
    await withDirs(async (dirs) => {
      const path = await ensureUserConfig(dirs);
      expect(path).toBe(join(dirs.config, "config.toml"));
      const workspace = join(dirs.data, "workspace");
      expect((await loadConfig(path)).workspace).toBe(workspace);
      if (process.platform !== "win32") {
        expect((await stat(path)).mode & 0o777).toBe(0o600);
        expect((await stat(dirs.config)).mode & 0o777).toBe(0o700);
        expect((await stat(dirs.data)).mode & 0o777).toBe(0o700);
      }
    });
  });

  test("an existing config stays exactly as it is, with its mode", async () => {
    await withDirs(async (dirs) => {
      const path = await ensureUserConfig(dirs);
      const mine = 'workspace = "/my/own"\nport = 5000\n';
      await Bun.write(path, mine);
      await chmod(path, 0o640);
      expect(await ensureUserConfig(dirs)).toBe(path);
      expect(await Bun.file(path).text()).toBe(mine);
      if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o640);
    });
  });

  test("a config with no workspace line uses the data folder, not the config folder", async () => {
    await withDirs(async (dirs) => {
      const { config, workspace } = userPaths(dirs);
      await ensureUserConfig(dirs);
      await Bun.write(config, "port = 4400\n");
      expect((await loadConfig(config, workspace)).workspace).toBe(workspace);
      // A source checkout has no such default, and stays as it was.
      expect((await loadConfig(config)).workspace).toBe(join(dirs.config, "workspace"));
    });
  });

  test("two starts at once make one config", async () => {
    await withDirs(async (dirs) => {
      const [a, b] = await Promise.all([ensureUserConfig(dirs), ensureUserConfig(dirs)]);
      expect(a).toBe(b);
      expect((await loadConfig(a)).workspace).toBe(join(dirs.data, "workspace"));
    });
  });

  test("a Windows path survives the TOML string", () => {
    expect(Bun.TOML.parse(firstConfig("C:\\Users\\A B\\doi\\workspace"))).toEqual({ workspace: "C:\\Users\\A B\\doi\\workspace" });
  });
});
