import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { bunSpawn, lines, readProcessResult } from "../src/providers/cli.ts";

test("the process reader collects stderr and exit status from a real child process", async () => {
  const proc = bunSpawn([
    process.execPath,
    "-e",
    "console.log('ready'); console.error('diagnostic'); process.exitCode = 7;",
  ], tmpdir());
  const completion = readProcessResult(proc);
  try {
    proc.stdin.end();
    const output: string[] = [];
    for await (const line of lines(proc.stdout)) output.push(line);
    expect(output).toEqual(["ready"]);
    expect(await completion).toEqual({ ok: true, code: 7, stderr: "diagnostic\n" });
  } finally {
    proc.kill();
    await completion;
  }
});

test("an exited child cannot wait for a descendant's inherited stderr", async () => {
  const child = `
    const { spawn } = require("node:child_process");
    const descendant = spawn(process.execPath, ["-e", "await Bun.sleep(4000)"], { stdio: ["ignore", "ignore", "inherit"] });
    console.error("last diagnostic");
    console.log(descendant.pid);
    process.exit(0);
  `;
  const started = performance.now();
  const proc = bunSpawn([process.execPath, "-e", child], tmpdir());
  const completion = readProcessResult(proc);
  let descendant: number | undefined;
  try {
    proc.stdin.end();
    const pid = Number(await new Response(proc.stdout).text());
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("The child returned no descendant PID.");
    descendant = pid;
    expect(await completion).toEqual({ ok: true, code: 0, stderr: "last diagnostic\n" });
    expect(performance.now() - started).toBeLessThan(2000);
    expect(proc.stderr.locked).toBe(false);
  } finally {
    proc.kill();
    if (descendant !== undefined) {
      try {
        process.kill(descendant);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
      }
    }
    await completion;
  }
});
