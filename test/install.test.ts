import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "../scripts/install.sh");
const fakeBinary = (version: string, extra = "") => `#!/bin/sh\n${extra}\necho "doi ${version}"\n`;
const sum = (text: string) => createHash("sha256").update(text).digest("hex");

/** One fake release: its files by name. A function answers the request itself. */
type Files = Record<string, string | (() => Response)>;
const releases = new Map<string, Files>();
function release(version: string, arch = "x64", body = fakeBinary(version), os: "linux" | "darwin" = "linux"): Files {
  const name = `doi-${version}-${os}-${arch}`;
  const files: Files = { [name]: body, SHA256SUMS: `${sum(body)}  ${name}\n` };
  releases.set(version, files);
  return files;
}

let server: ReturnType<typeof Bun.serve>;
let root: string;
let home: string;
let dir: string;
let bin: string;

beforeEach(async () => {
  releases.clear();
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const [, version, name] = new URL(req.url).pathname.split("/");
      const file = releases.get(version!.slice(1))?.[name!];
      if (file === undefined) return new Response("no", { status: 404 });
      return typeof file === "function" ? file() : new Response(file);
    },
  });
  root = await mkdtemp(join(tmpdir(), "doi install "));
  home = join(root, "home folder");
  dir = join(root, "the bin");
  bin = join(root, "stubs");
  await mkdir(home, { recursive: true });
  await mkdir(bin, { recursive: true });
});

afterEach(async () => {
  server.stop(true);
  await rm(root, { recursive: true, force: true });
});

async function install(args: string[] = [], env: Record<string, string> = {}) {
  const proc = Bun.spawn(["sh", SCRIPT, "--dir", dir, ...args], {
    cwd: root,
    env: { HOME: home, PATH: `${bin}:${process.env.PATH}`, DOI_INSTALL_BASE_URL: `http://127.0.0.1:${server.port}`, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
}
const installed = () => Bun.file(join(dir, "doi"));
const leftovers = async () => (await readdir(dir).catch(() => [] as string[])).filter((f) => f !== "doi");
async function stub(name: string, body: string) {
  await Bun.write(join(bin, name), `#!/bin/sh\n${body}\n`);
  await Bun.$`chmod +x ${join(bin, name)}`;
}
const machine = (arch: string, os = "Linux") => stub("uname", `case "$1" in -s) echo ${os} ;; -m) echo ${arch} ;; esac`);

describe.skipIf(process.platform === "win32")("a new install", () => {
  test("verifies, installs in a folder with spaces, runs from an unrelated folder, and leaves no temp files", async () => {
    await machine("x86_64");
    release("1.2.3");
    const result = await install(["--version", "1.2.3"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Installed doi 1.2.3");
    expect(await leftovers()).toEqual([]);
    expect((await Bun.$`${join(dir, "doi")} --version`.cwd(home).text()).trim()).toBe("doi 1.2.3");
    expect(await Bun.file(join(home, ".profile")).text()).toContain(dir);
    expect(result.stdout).toContain(`Added ${dir} to your PATH in ${join(home, ".profile")}.`);
  });

  test("takes a v in the version, and the environment form for curl | sh", async () => {
    await machine("x86_64");
    release("1.2.3");
    expect((await install(["--version", "v1.2.3"])).code).toBe(0);
    await rm(join(dir, "doi"));
    expect((await install([], { DOI_VERSION: "1.2.3" })).code).toBe(0);
  });

  test("latest uses only a release tag URL", async () => {
    await machine("x86_64");
    release("1.2.3");
    const curl = Bun.which("curl");
    if (!curl) throw new Error("curl is necessary for the latest release test");
    const redirects = [
      "",
      "https://github.com/zo-ll/doi/releases",
      "https://github.com/zo-ll/doi/releases/tag/",
      "https://example.com/releases/tag/v1.2.3",
      "/releases/tag/v1.2.3",
      "/another/doi/releases/tag/v1.2.3",
      "//example.com/zo-ll/doi/releases/tag/v1.2.3",
    ];
    for (const url of redirects) {
      await stub("curl", `case "$*" in *releases/latest*) printf '%s' '${url}' ;; *) exec '${curl}' "$@" ;; esac`);
      const result = await install();
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("cannot find the latest release of zo-ll/doi");
      expect(result.stdout).not.toContain("Downloading");
      expect(await installed().exists()).toBe(false);
    }
    for (const url of ["https://github.com/zo-ll/doi/releases/tag/v1.2.3", "/zo-ll/doi/releases/tag/v1.2.3"]) {
      await stub("curl", `case "$*" in *releases/latest*) printf '%s' '${url}' ;; *) exec '${curl}' "$@" ;; esac`);
      const result = await install();
      expect(result.code).toBe(0);
      expect((await Bun.$`${join(dir, "doi")} --version`.text()).trim()).toBe("doi 1.2.3");
    }
  });

  test("wget accepts a repository-relative latest redirect without curl", async () => {
    await machine("x86_64");
    release("1.2.3");
    const wget = Bun.which("wget");
    if (!wget) throw new Error("wget is necessary for the relative redirect test");
    for (const name of ["sh", "sed", "tail", "tr", "sha256sum", "shasum", "cut", "mkdir", "mktemp", "rm", "awk", "chmod", "mv"]) {
      const path = Bun.which(name);
      if (path) await Bun.$`ln -s ${path} ${join(bin, name)}`;
    }
    await stub("wget", `case "$*" in *releases/latest*) printf '  Location: /zo-ll/doi/releases/tag/v1.2.3\\r\\n' >&2 ;; *) exec '${wget}' "$@" ;; esac`);
    const result = await install([], { PATH: bin });
    expect(result.code).toBe(0);
    expect((await Bun.$`${join(dir, "doi")} --version`.text()).trim()).toBe("doi 1.2.3");
  });

  test("the CPU picks the artifact", async () => {
    await machine("aarch64");
    release("1.2.3", "arm64");
    expect((await install(["--version", "1.2.3"])).code).toBe(0);
    await machine("riscv64");
    const other = await install(["--version", "1.2.3"]);
    expect(other.code).toBe(1);
    expect(other.stderr).toContain("riscv64");
  });

  test("macOS installs native Intel and Apple silicon binaries and configures a fresh zsh profile", async () => {
    await stub("sysctl", "exit 1");
    await stub("ldd", "echo 'musl libc'");
    for (const arch of ["x64", "arm64"]) {
      await machine(arch === "x64" ? "x86_64" : "arm64", "Darwin");
      release("1.2.3", arch, undefined, "darwin");
      const result = await install(["--version", "1.2.3"]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain(`for macOS ${arch}`);
      expect((await Bun.$`${join(dir, "doi")} --version`.text()).trim()).toBe("doi 1.2.3");
      for (const rc of [".profile", ".zprofile"]) expect(await Bun.file(join(home, rc)).text()).toContain(dir);
      const data = join(home, ".local/share/doi/workspace/kept.txt");
      await Bun.write(data, "my design");
      expect((await install(["--uninstall"])).code).toBe(0);
      expect(await installed().exists()).toBe(false);
      expect(await Bun.file(data).text()).toBe("my design");
      for (const rc of [".profile", ".zprofile"]) expect(await Bun.file(join(home, rc)).text()).not.toContain("doi installer");
    }
  });

  test("a Rosetta shell selects the native Apple silicon binary", async () => {
    await machine("x86_64", "Darwin");
    await stub("sysctl", '[ "$2" = sysctl.proc_translated ] || exit 1; echo 1');
    release("1.2.3", "arm64", undefined, "darwin");
    const result = await install(["--version", "1.2.3"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("for macOS arm64");
  });

  test("a release without a macOS binary gives a clear message and preserves the old install", async () => {
    await machine("arm64", "Darwin");
    release("1.2.3", "arm64", undefined, "darwin");
    expect((await install(["--version", "1.2.3"])).code).toBe(0);
    release("2.0.0");
    const result = await install(["--version", "2.0.0"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("version 2.0.0 has no macOS arm64 binary");
    expect((await Bun.$`${join(dir, "doi")} --version`.text()).trim()).toBe("doi 1.2.3");
    expect(await leftovers()).toEqual([]);
  });

  test("an unsupported system gets no binary", async () => {
    await machine("x86_64", "FreeBSD");
    const result = await install(["--version", "1.2.3"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("no binary for FreeBSD");
    expect(await installed().exists()).toBe(false);
  });

  test("musl libc gets a clear message", async () => {
    await machine("x86_64");
    await stub("ldd", "echo 'musl libc (x86_64)'");
    const result = await install(["--version", "1.2.3"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("musl");
  });

  test("the PATH line goes in once, and not when the folder is on PATH or with --no-modify-path", async () => {
    await machine("x86_64");
    release("1.2.3");
    await Bun.write(join(home, ".bashrc"), "# mine\n");
    await install(["--version", "1.2.3"]);
    await install(["--version", "1.2.3"]);
    for (const rc of [".profile", ".bashrc"]) {
      const lines = (await Bun.file(join(home, rc)).text()).split("\n").filter((l) => l.includes("doi installer"));
      expect(lines).toHaveLength(1);
    }
    expect(await Bun.file(join(home, ".zshrc")).exists()).toBe(false);
    await rm(join(home, ".profile"));
    const off = await install(["--version", "1.2.3", "--no-modify-path"]);
    expect(off.stdout).toContain("Add ");
    expect(await Bun.file(join(home, ".profile")).exists()).toBe(false);
    const on = await install(["--version", "1.2.3"], { PATH: `${dir}:${bin}:${process.env.PATH}` });
    expect(on.stdout).not.toContain("Added ");
    expect(await Bun.file(join(home, ".profile")).exists()).toBe(false);
  });
});

describe.skipIf(process.platform === "win32")("a failed install or upgrade changes nothing", () => {
  const data = () => join(home, ".local/share/doi/workspace/kept.txt");
  async function withOld() {
    await machine("x86_64");
    release("1.0.0");
    expect((await install(["--version", "1.0.0"])).code).toBe(0);
    await Bun.write(data(), "my design");
  }
  async function expectOldKept(result: { code: number }) {
    expect(result.code).toBe(1);
    expect((await Bun.$`${join(dir, "doi")} --version`.text()).trim()).toBe("doi 1.0.0");
    expect(await leftovers()).toEqual([]);
    expect(await Bun.file(data()).text()).toBe("my design");
  }

  test("a good upgrade replaces only the binary", async () => {
    await withOld();
    release("2.0.0");
    expect((await install(["--version", "2.0.0"])).code).toBe(0);
    expect((await Bun.$`${join(dir, "doi")} --version`.text()).trim()).toBe("doi 2.0.0");
    expect(await Bun.file(data()).text()).toBe("my design");
  });

  test("a wrong checksum", async () => {
    await withOld();
    const files = release("2.0.0");
    files["doi-2.0.0-linux-x64"] = fakeBinary("2.0.0", "# changed");
    const result = await install(["--version", "2.0.0"]);
    expect(result.stderr).toContain("does not match");
    await expectOldKept(result);
  });

  test("checksums that do not list the file", async () => {
    await withOld();
    release("2.0.0").SHA256SUMS = "abc  another-file\n";
    await expectOldKept(await install(["--version", "2.0.0"]));
  });

  test("an interrupted download", async () => {
    await withOld();
    const files = release("2.0.0");
    files["doi-2.0.0-linux-x64"] = () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("#!/bin/sh\n"));
          setTimeout(() => controller.error(new Error("cut")), 50);
        },
      });
      return new Response(stream, { headers: { "content-length": "100000" } });
    };
    const result = await install(["--version", "2.0.0"]);
    expect(result.stderr).toContain("Nothing changed");
    await expectOldKept(result);
  });

  test("a missing version", async () => {
    await withOld();
    const result = await install(["--version", "9.9.9"]);
    expect(result.stderr).toContain("9.9.9");
    await expectOldKept(result);
  });

  test("a binary that does not run, or that reports another version", async () => {
    await withOld();
    release("2.0.0", "x64", "#!/bin/sh\nexit 7\n");
    await expectOldKept(await install(["--version", "2.0.0"]));
    release("2.0.0", "x64", fakeBinary("3.3.3"));
    const result = await install(["--version", "2.0.0"]);
    expect(result.stderr).toContain("doi 3.3.3");
    await expectOldKept(result);
  });

  test("a version with shell characters is refused before any download", async () => {
    await withOld();
    const result = await install(["--version", "1;touch x"]);
    expect(result.stderr).toContain("not a version");
    await expectOldKept(result);
  });
});

describe.skipIf(process.platform === "win32")("shell files", () => {
  const shell = (rc: string, code: string) => Bun.$`sh -c ${`. "${rc}"; ${code}`}`.env({ PATH: "/usr/bin:/bin", HOME: home }).quiet().nothrow();

  test("a folder name cannot run a command or break a shell file", async () => {
    await machine("x86_64");
    release("1.2.3");
    const proof = join(root, "proof");
    for (const name of [`d$(touch "${proof}")x`, 'dq"x', "s'q", "a b"]) {
      dir = join(root, name);
      const result = await install(["--version", "1.2.3"]);
      expect(result.code).toBe(0);
      const rc = join(home, ".profile");
      const run = await shell(rc, 'printf "%s" "$PATH"');
      expect(run.exitCode).toBe(0);
      expect(run.text().split(":")).toContain(dir);
      expect(await Bun.file(proof).exists()).toBe(false);
      expect((await install(["--uninstall"])).code).toBe(0);
      expect(await Bun.file(rc).text()).not.toContain(dir);
    }
  });

  test("a folder with a line break is refused", async () => {
    dir = join(root, "a\nb");
    const result = await install(["--version", "1.2.3"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("line break");
  });

  test.skipIf(process.getuid?.() === 0)("a shell file that cannot change does not fail the install or the uninstall", async () => {
    await machine("x86_64");
    release("1.2.3");
    const rc = join(home, ".profile");
    await Bun.write(rc, "# mine\n");
    await Bun.$`chmod 444 ${rc}`;
    const result = await install(["--version", "1.2.3"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("cannot write");
    expect(result.stdout).not.toContain("Added ");
    expect(result.stdout).toContain("Installed doi 1.2.3");
    expect(await installed().exists()).toBe(true);

    await Bun.$`chmod 644 ${rc}`;
    await install(["--version", "1.2.3"]);
    await Bun.$`chmod 444 ${rc}`;
    const out = await install(["--uninstall"]);
    expect(out.code).toBe(0);
    expect(out.stderr).toContain("cannot write");
    expect(await installed().exists()).toBe(false);
    expect((await readdir(home)).filter((f) => f.includes("doi-tmp"))).toEqual([]);
  });

  test("an uninstall of one folder leaves the PATH line of another", async () => {
    await machine("x86_64");
    release("1.2.3");
    const other = join(root, "other bin");
    await install(["--version", "1.2.3"]);
    await install(["--version", "1.2.3", "--dir", other]);
    await install(["--uninstall"]);
    const text = await Bun.file(join(home, ".profile")).text();
    expect(text).toContain(other);
    expect(text).not.toContain(dir);
  });

  test("login shell files get the line when they exist", async () => {
    await machine("x86_64");
    release("1.2.3");
    await Bun.write(join(home, ".bash_profile"), "# mine\n");
    await Bun.write(join(home, ".zprofile"), "# mine\n");
    await install(["--version", "1.2.3"]);
    for (const rc of [".bash_profile", ".zprofile"]) expect(await Bun.file(join(home, rc)).text()).toContain(dir);
  });

  test("with no HOME, --dir still works, and without it the message says what to do", async () => {
    await machine("x86_64");
    release("1.2.3");
    const clean = { PATH: `${bin}:${process.env.PATH}`, DOI_INSTALL_BASE_URL: `http://127.0.0.1:${server.port}` };
    const withDir = Bun.spawn(["sh", SCRIPT, "--dir", dir, "--version", "1.2.3"], { env: clean, stdout: "pipe", stderr: "pipe" });
    expect(await withDir.exited).toBe(0);
    expect(await installed().exists()).toBe(true);
    const without = Bun.spawn(["sh", SCRIPT, "--version", "1.2.3"], { env: clean, stdout: "pipe", stderr: "pipe" });
    expect(await without.exited).toBe(1);
    expect(await new Response(without.stderr).text()).toContain("HOME is not set");
    const removed = Bun.spawn(["sh", SCRIPT, "--dir", dir, "--uninstall"], { env: clean, stdout: "pipe", stderr: "pipe" });
    expect(await removed.exited).toBe(0);
    const message = await new Response(removed.stdout).text();
    expect(message).toContain("Your designs, config and credentials stay.");
    expect(message).not.toContain("/.local/share/doi");
    expect(message).not.toContain("/.config/doi");
    expect(await installed().exists()).toBe(false);
  });

  test("the uninstall message names the folder that doi uses, also with a relative XDG path", async () => {
    const result = await install(["--uninstall"], { XDG_DATA_HOME: "relative", XDG_CONFIG_HOME: "/abs/cfg" });
    expect(result.stdout).toContain(join(home, ".local/share/doi"));
    expect(result.stdout).toContain("/abs/cfg/doi");
    expect(result.stdout).not.toContain("relative");
  });
});

test.skipIf(process.platform === "win32")("uninstall removes the binary and the PATH line, and keeps the user's data and lines", async () => {
  await machine("x86_64");
  release("1.2.3");
  await Bun.write(join(home, ".bashrc"), "# mine\n");
  await install(["--version", "1.2.3"]);
  const data = join(home, ".local/share/doi/workspace/kept.txt");
  const config = join(home, ".config/doi/config.toml");
  await Bun.write(data, "my design");
  await Bun.write(config, "port = 1\n");
  const result = await install(["--uninstall"]);
  expect(result.code).toBe(0);
  expect(await installed().exists()).toBe(false);
  expect(await Bun.file(join(home, ".bashrc")).text()).toBe("# mine\n");
  expect(await Bun.file(join(home, ".profile")).text()).not.toContain("doi installer");
  expect(await Bun.file(data).text()).toBe("my design");
  expect(await Bun.file(config).text()).toBe("port = 1\n");
  expect(result.stdout).toContain(".local/share/doi");
  expect((await install(["--uninstall"])).code).toBe(0);
});
