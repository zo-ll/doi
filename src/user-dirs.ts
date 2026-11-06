import { existsSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

export interface UserDirs {
  /** config.toml and credentials.json. */
  config: string;
  /** The default workspace. */
  data: string;
}

/**
 * The per-user folders of doi. Windows: %APPDATA%\\doi and %LOCALAPPDATA%\\doi. Other systems:
 * the XDG base directories. A relative path counts as missing, as the XDG specification says, so
 * the shell folder cannot decide where the state goes.
 */
export function userDirs(env: Record<string, string | undefined> = process.env, platform: NodeJS.Platform = process.platform, home: string = homedir()): UserDirs {
  if (platform === "win32") {
    const { join, isAbsolute } = win32;
    const base = (value: string | undefined, fallback: string) => (value && isAbsolute(value) ? value : join(home, "AppData", fallback));
    return {
      config: join(base(env.APPDATA, "Roaming"), "doi"),
      data: join(base(env.LOCALAPPDATA, "Local"), "doi"),
    };
  }
  const { join, isAbsolute } = posix;
  const base = (value: string | undefined, fallback: string) => (value && isAbsolute(value) ? value : join(home, fallback));
  return {
    config: join(base(env.XDG_CONFIG_HOME, ".config"), "doi"),
    data: join(base(env.XDG_DATA_HOME, ".local/share"), "doi"),
  };
}

/** A config that names the default workspace. A TOML basic string has the escapes of a JSON string for these characters. */
export function firstConfig(workspace: string): string {
  return `# The config of doi. The "Configure" part of the doi user guide lists all settings.
# Keep this path absolute. A relative path counts from this folder, and it is another workspace.
workspace = ${JSON.stringify(workspace)}
`;
}

/**
 * The credentials file. A key that an older doi stored on Windows, under the profile, stays
 * reachable there; only a new file goes to the config folder. Linux has one path.
 */
export function credentialsPath(env: Record<string, string | undefined> = process.env, platform: NodeJS.Platform = process.platform, home: string = homedir(), exists: (path: string) => boolean = existsSync): string {
  const { join } = platform === "win32" ? win32 : posix;
  const current = join(userDirs(env, platform, home).config, "credentials.json");
  if (platform !== "win32") return current;
  const older = join(env.XDG_CONFIG_HOME || join(home, ".config"), "doi", "credentials.json");
  return !exists(current) && exists(older) ? older : current;
}

/** The per-user config file and the workspace that a file with no `workspace` line uses. */
export function userPaths(dirs: UserDirs = userDirs(), platform: NodeJS.Platform = process.platform): { config: string; workspace: string } {
  const { join } = platform === "win32" ? win32 : posix;
  return { config: join(dirs.config, "config.toml"), workspace: join(dirs.data, "workspace") };
}

/**
 * Makes the per-user folders and config.toml, once. An existing file stays as it is, so an upgrade
 * or a second start cannot change the user's settings or their workspace. Returns the config path.
 * Windows ignores the modes: the folders inherit the private access of the user's profile.
 */
export async function ensureUserConfig(dirs: UserDirs = userDirs(), platform: NodeJS.Platform = process.platform): Promise<string> {
  const { config: path, workspace } = userPaths(dirs, platform);
  await mkdir(dirs.config, { recursive: true, mode: 0o700 });
  await mkdir(dirs.data, { recursive: true, mode: 0o700 });
  try {
    await writeFile(path, firstConfig(workspace), { flag: "wx", mode: 0o600 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    return path;
  }
  await chmod(path, 0o600); // a umask can only make it stricter, but a copied file system may not
  return path;
}
