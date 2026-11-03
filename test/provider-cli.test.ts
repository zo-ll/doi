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
