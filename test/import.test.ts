import { beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { parseConfig, type Config } from "../src/config.ts";
import { formatSources, scanRepo, SCAN_LIMITS } from "../src/generation/repo-scan.ts";
import type { GenerateRequest, Provider, ProviderCapabilities } from "../src/providers/types.ts";
import { importFromRepo, type ImportStreamEvent } from "../src/server/design-systems.ts";
import { DesignLocks } from "../src/server/locks.ts";

const caps: ProviderCapabilities = { vision: true, toolUse: true, promptCache: "explicit", maxContextTokens: 200_000, editsFiles: false };

let repo: string;
let config: Config;
let calls: GenerateRequest[];
let commits: { paths: string[]; message: string }[];
let behave: () => AsyncGenerator<any>;
let locks: DesignLocks;

/** Every file of a folder with its text, to see that the import changes nothing there. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const e of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (e.isFile()) out[relative(dir, join(e.parentPath, e.name))] = await Bun.file(join(e.parentPath, e.name)).text();
  }
  return out;
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "doi-repo-"));
  const w = (p: string, text: string) => Bun.write(join(repo, p), text);
  await w("tailwind.config.js", "module.exports = { theme: { colors: { brand: '#e11d48' } } }");
  await w("src/styles/tokens.css", ":root { --brand: #e11d48; --space-2: 8px; --radius: 6px; }");
  await w("src/app.css", "body { margin: 0 }");
  await w("src/components/Button.tsx", "export const Button = () => <button className='btn'>Go</button>;");
  await w("src/components/Button.test.tsx", "test('x', () => {})");
  await w("src/components/Card.tsx", "export const Card = () => <div className='card' />;");
  await w("node_modules/lib/tokens.css", ":root { --lib: 1px; }");
  await w(".env", "API_KEY=secret");
  await w("config/secrets.json", '{"key":"x"}');
  await w("id_rsa", "PRIVATE");
  await w(".storybook/theme.ts", "export default {}");
  const outside = await mkdtemp(join(tmpdir(), "doi-outside-"));
  await Bun.write(join(outside, "theme.json"), '{"leak":true}');
  await symlink(join(outside, "theme.json"), join(repo, "theme.json"));

  config = parseConfig({ workspace: await mkdtemp(join(tmpdir(), "doi-ws-")), models: { extract: "anthropic:small" } });
  await mkdir(join(config.workspace, "design-systems"), { recursive: true });
  calls = [];
  commits = [];
  locks = new DesignLocks();
  behave = async function* () {
    yield { type: "text", delta: "Found a rose brand color." };
    yield { type: "write", file: "tokens.css", content: ":root { --color-primary: #e11d48; }\n" };
    yield { type: "write", file: "components.css", content: ".ds-button { background: var(--color-primary); }\n" };
    yield { type: "write", file: "components.html", content: '<button class="ds-button">Go</button>\n' };
    yield { type: "write", file: "rules.md", content: "- Use the primary color once per screen.\n" };
    yield { type: "write", file: "notes.js", content: "alert(1)" };
    yield { type: "usage", inputTokens: 900, outputTokens: 100, cachedTokens: 0 };
    yield { type: "done" };
  };
});

const deps = () => ({
  config,
  locks,
  commit: async (paths: string[], message: string) => {
    commits.push({ paths: paths.map((p) => relative(config.workspace, p)), message });
    return "c".repeat(40);
  },
  getProvider: (id: string) =>
    ({
      id,
      capabilities: caps,
      generate(req: GenerateRequest) {
        calls.push(req);
        return behave();
      },
    }) as Provider,
});
const post = (body: unknown) => importFromRepo(deps() as any, new Request("http://x/", { method: "POST", body: JSON.stringify(body) }));
async function events(res: Response): Promise<ImportStreamEvent[]> {
  return (await res.text()).split("\n\n").filter(Boolean).map((b) => JSON.parse(b.split("\n").find((l) => l.startsWith("data: "))!.slice(6)));
}

describe("repo scan", () => {
  test("picks configs, stylesheets with tokens and components; skips tests, vendored, hidden, secret and linked files", async () => {
    const { sources } = await scanRepo(repo);
    expect(sources.map((s) => [s.path, s.kind])).toEqual([
      ["tailwind.config.js", "config"],
      ["src/styles/tokens.css", "styles"],
      ["src/components/Button.tsx", "component"],
      ["src/components/Card.tsx", "component"],
    ]);
    const text = formatSources("shop", sources);
    expect(text).toStartWith('Make a design system from the repo "shop".');
    expect(text).toContain("## src/styles/tokens.css (styles)\n```css\n:root { --brand: #e11d48;");
    for (const secret of ["API_KEY", "PRIVATE", '"key"', "leak", "--lib"]) expect(text).not.toContain(secret);
  });

  test("in a git repo, ignored files stay out", async () => {
    await Bun.write(join(repo, ".gitignore"), "workspace/\n");
    await Bun.write(join(repo, "workspace/designs/home/styles.css"), ":root { --dev: 1px; }");
    await Bun.$`git init -q`.cwd(repo).quiet();
    const { sources } = await scanRepo(repo);
    expect(sources.map((s) => s.path)).toEqual(["tailwind.config.js", "src/styles/tokens.css", "src/components/Button.tsx", "src/components/Card.tsx"]);
    // The scan only reads: git made no index file.
    expect(existsSync(join(repo, ".git", "index"))).toBe(false);
  });

  test("a large file is cut, and the total stays in the limit", async () => {
    const big = ":root {\n" + Array.from({ length: 3000 }, (_, i) => `  --c${i}: #000;`).join("\n") + "\n}";
    await Bun.write(join(repo, "src/styles/big.css"), big);
    const { sources } = await scanRepo(repo);
    const b = sources.find((s) => s.path === "src/styles/big.css")!;
    expect(b.cut).toBe(true);
    expect(b.content.length).toBe(SCAN_LIMITS.perFile);
    expect(sources.reduce((n, s) => n + s.content.length, 0)).toBeLessThanOrEqual(SCAN_LIMITS.total);
    expect(formatSources("x", sources)).toContain("(styles) — cut to the first part");
  });
});

describe("import from a repo", () => {
  test("writes the design system files, drops other files, commits, and never writes into the repo", async () => {
    const before = await snapshot(repo);
    const evs = await events(await post({ name: "rose", repo }));
    expect(evs[0]).toMatchObject({ type: "sources", files: ["tailwind.config.js", "src/styles/tokens.css", "src/components/Button.tsx", "src/components/Card.tsx"] });
    expect(evs.at(-1)).toEqual({ type: "imported", name: "rose", files: ["tokens.css", "components.css", "components.html", "rules.md"], commit: "c".repeat(40) });
    const dir = join(config.workspace, "design-systems", "rose");
    expect((await readdir(dir)).sort()).toEqual(["components.css", "components.html", "rules.md", "tokens.css"]);
    expect(await Bun.file(join(dir, "tokens.css")).text()).toBe(":root { --color-primary: #e11d48; }\n");
    // No staging folder stays behind.
    expect((await readdir(join(config.workspace, "design-systems"))).filter((e) => e.startsWith("."))).toEqual([]);
    expect(commits).toEqual([{ paths: ["design-systems/rose"], message: `Import design system rose from ${relative(join(repo, ".."), repo)}` }]);
    expect(await snapshot(repo)).toEqual(before);
    // The extract prompt and the sources went to the extract model.
    expect(calls[0]!.model).toBe("small");
    expect(calls[0]!.system[0]).toContain("Write these four files");
    expect((calls[0]!.messages[0]!.content[0] as { text: string }).text).toContain("src/components/Card.tsx");
  });

  test("a result without tokens.css makes nothing", async () => {
    behave = async function* () {
      yield { type: "write", file: "rules.md", content: "- x\n" };
      yield { type: "done" };
    };
    const evs = await events(await post({ name: "rose", repo }));
    expect(evs.at(-1)).toMatchObject({ type: "error", kind: "result" });
    expect(await readdir(join(config.workspace, "design-systems"))).toEqual([]);
    expect(commits).toEqual([]);
  });

  test("a write outside the staging folder fails and writes nothing", async () => {
    behave = async function* () {
      yield { type: "write", file: "../../escape.css", content: "x" };
      yield { type: "done" };
    };
    const evs = await events(await post({ name: "rose", repo }));
    expect(evs.at(-1)).toMatchObject({ type: "error", kind: "apply" });
    expect(existsSync(join(config.workspace, "escape.css"))).toBe(false);
    expect(await readdir(join(config.workspace, "design-systems"))).toEqual([]);
  });

  test("bad requests are refused before any model call", async () => {
    await mkdir(join(config.workspace, "design-systems", "taken"));
    const empty = await mkdtemp(join(tmpdir(), "doi-empty-"));
    await Bun.write(join(empty, "README.md"), "# x");
    const cases: [unknown, number, string][] = [
      [{ name: "rose", repo: "relative/path" }, 400, "repo must be an absolute path to a folder."],
      [{ name: "rose", repo: config.workspace }, 400, "repo must be outside the doi workspace."],
      [{ name: "rose", repo: join(repo, "nope") }, 400, "The repo path is not a folder."],
      [{ name: "Rose!", repo }, 400, 'name must use a-z, 0-9 and "-" (at most 60 characters).'],
      [{ name: "taken", repo }, 409, 'A design system "taken" already exists.'],
      [{ name: "rose", repo: empty }, 400, "No design files were found in this repo: no Tailwind config, theme files, stylesheets with tokens or components."],
    ];
    for (const [body, status, error] of cases) {
      const res = await post(body);
      expect([res.status, (await res.json()).error]).toEqual([status, error]);
    }
    locks.tryLock("ds:rose");
    expect((await post({ name: "rose", repo })).status).toBe(409);
    expect(calls).toHaveLength(0);
  });
});
