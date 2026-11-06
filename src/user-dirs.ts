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
 * the XDG base directories. A relative XDG path counts as missing, as the XDG specification says.
 */
export function userDirs(env: Record<string, string | undefined> = process.env, platform: NodeJS.Platform = process.platform, home: string = homedir()): UserDirs {
  if (platform === "win32") {
    const { join } = win32;
    return {
      config: join(env.APPDATA || join(home, "AppData", "Roaming"), "doi"),
      data: join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "doi"),
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
  return `# The config of doi. config.example.toml in the source lists all settings.
workspace = ${JSON.stringify(workspace)}
`;
}

/**
 * Makes the per-user folders and config.toml, once. An existing file stays as it is, so an upgrade
 * or a second start cannot change the user's settings or their workspace. Returns the config path.
 * Windows ignores the modes: the folders inherit the private access of the user's profile.
 */
export async function ensureUserConfig(dirs: UserDirs = userDirs(), platform: NodeJS.Platform = process.platform): Promise<string> {
  const { join } = platform === "win32" ? win32 : posix;
  const workspace = join(dirs.data, "workspace");
  await mkdir(dirs.config, { recursive: true, mode: 0o700 });
  await mkdir(dirs.data, { recursive: true, mode: 0o700 });
  const path = join(dirs.config, "config.toml");
  try {
    await writeFile(path, firstConfig(workspace), { flag: "wx", mode: 0o600 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    return path;
  }
  await chmod(path, 0o600); // a umask can only make it stricter, but a copied file system may not
  return path;
}
