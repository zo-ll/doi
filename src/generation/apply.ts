import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { GenerateEvent, GenerateRequest, Message, Provider } from "../providers/types.ts";
import { designFile, fileIn } from "../workspace/paths.ts";
import { capabilitiesFor } from "./context.ts";

export type FileChange = Extract<GenerateEvent, { type: "edit" } | { type: "write" }>;

export interface DesignRef {
  workspace: string;
  project: string;
  design: string;
  /** The folder the changes go to, when it is not the design folder (a design system import). */
  dir?: string;
}

export interface ChangeFailure {
  file: string;
  reason: "outside" | "missing" | "no-match" | "many-matches" | "empty";
  message: string;
}

export type ApplyResult = { ok: true; files: string[] } | { ok: false; failures: ChangeFailure[] };

function resolve(ref: DesignRef, file: string): string | null {
  try {
    return ref.dir ? fileIn(ref.dir, file) : designFile(ref.workspace, ref.project, ref.design, file);
  } catch {
    return null;
  }
}

async function readOrNull(path: string): Promise<string | null> {
  const f = Bun.file(path);
  return (await f.exists()) ? f.text() : null;
}

/**
 * Applies all changes of one turn, or none. The changes run in order on copies in memory,
 * so a later edit sees an earlier one. Files are written only when every change matched.
 * If a write fails, the files written before it get their old content back.
 */
export async function applyChanges(ref: DesignRef, changes: FileChange[]): Promise<ApplyResult> {
  const original = new Map<string, string | null>(); // full path → content on disk, null = no file
  const staged = new Map<string, string>(); // full path → new content
  const names = new Map<string, string>(); // full path → file name as the model sent it
  const failures: ChangeFailure[] = [];

  for (const change of changes) {
    const path = resolve(ref, change.file);
    if (!path) {
      failures.push({ file: change.file, reason: "outside", message: `"${change.file}" is outside the design folder.` });
      continue;
    }
    if (!original.has(path)) original.set(path, await readOrNull(path));
    if (!names.has(path)) names.set(path, change.file);
    if (change.type === "write") {
      staged.set(path, change.content);
      continue;
    }
    const current = staged.get(path) ?? original.get(path) ?? null;
    if (current === null) {
      failures.push({ file: change.file, reason: "missing", message: `"${change.file}" does not exist. Use write to create it.` });
    } else if (!change.oldText) {
      failures.push({ file: change.file, reason: "empty", message: `An edit of "${change.file}" has an empty oldText.` });
    } else {
      const count = current.split(change.oldText).length - 1;
      if (count === 1) {
        staged.set(path, current.replace(change.oldText, () => change.newText));
      } else {
        failures.push({
          file: change.file,
          reason: count === 0 ? "no-match" : "many-matches",
          message:
            count === 0
              ? `oldText does not occur in "${change.file}": ${preview(change.oldText)}`
              : `oldText occurs ${count} times in "${change.file}"; it must occur once: ${preview(change.oldText)}`,
        });
      }
    }
  }
  if (failures.length) return { ok: false, failures };

  const written: string[] = [];
  try {
    for (const [path, content] of staged) {
      if (content === original.get(path)) continue;
      await mkdir(dirname(path), { recursive: true });
      written.push(path);
      await Bun.write(path, content);
    }
  } catch (e) {
    for (const path of written) {
      const old = original.get(path);
      try {
        if (old === null || old === undefined) await rm(path, { force: true });
        else await Bun.write(path, old);
      } catch {
        // Keep restoring the other files; the first error is the one to report.
      }
    }
    throw e;
  }
  return { ok: true, files: written.map((p) => names.get(p)!) };
}

function preview(text: string): string {
  const one = text.length > 120 ? `${text.slice(0, 120)}…` : text;
  return JSON.stringify(one);
}

export type TurnEvent =
  | Exclude<GenerateEvent, { type: "done" }>
  | { type: "retry"; attempt: number; failures: ChangeFailure[] }
  | { type: "applied"; files: string[] }
  | { type: "done" };

export class ApplyError extends Error {
  override name = "ApplyError";
  constructor(readonly failures: ChangeFailure[]) {
    super(`The changes could not be applied: ${failures.map((f) => f.message).join(" ")}`);
  }
}

function describeFailures(failures: ChangeFailure[]): string {
  return failures.map((f) => `- ${f.message}`).join("\n");
}

/** What the model said and proposed in a failed attempt, as text for the next attempt. */
function attemptSummary(text: string, changes: FileChange[], toolUse: boolean): Message {
  const calls = changes.map((c) => (c.type === "edit" ? `edit ${c.file}` : `write ${c.file}`)).join(", ");
  return { role: "assistant", content: [{ type: "text", text: `${text}\n\n(${toolUse ? "Tool calls" : "SEARCH/REPLACE blocks"}: ${calls})`.trim() }] };
}

/** A failure message of applyChanges in the words of SEARCH/REPLACE blocks. */
const inBlockWords = (failures: string) =>
  failures
    .replaceAll("has an empty oldText", "has an empty SEARCH section")
    .replaceAll(/^- oldText /gm, "- The SEARCH section ")
    .replaceAll("Use write to create it.", "Use a block with an empty SEARCH section to create it.");

/** What runTurn asks after failed changes, in the words of the model's change format. */
function retryRequest(attempt: number, failures: string, files: string, toolUse: boolean): string {
  if (!toolUse) failures = inBlockWords(failures);
  if (attempt === 1) {
    const copy = toolUse ? "Copy each oldText exactly from the current files." : "Copy each SEARCH section exactly from the current files.";
    return `None of your changes were applied, because these failed:\n${failures}\n\nThe design files are unchanged. Send all the changes of this turn again. ${copy}`;
  }
  const whole = toolUse
    ? `Use write with the full new content for ${files}, not edit.`
    : `For ${files}, use a block with an empty SEARCH section and the full new content in the REPLACE section.`;
  return `None of your changes were applied again:\n${failures}\n\n${whole} Send all the other changes of this turn again too.`;
}

/**
 * Runs one turn and applies its changes. If a change fails, nothing is applied and the model
 * gets the errors one time. After a second failure, it must rewrite the failing files whole.
 * Providers with `editsFiles` change the files themselves: their events pass through, and
 * `applied` lists the files they reported. Every completed turn ends with `applied` and `done`.
 */
/**
 * One id per design chat: the same for every turn of a design, different between designs and
 * workspaces. A hash, so the provider never sees project or design names.
 */
export function sessionId(ref: Pick<DesignRef, "workspace" | "project" | "design">): string {
  const h = createHash("sha256").update(`doi-session\0${ref.workspace}\0${ref.project}\0${ref.design}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export async function* runTurn(provider: Provider, req: GenerateRequest, ref: DesignRef): AsyncGenerator<TurnEvent> {
  req = { ...req, session: req.session ?? sessionId(ref) };
  if (provider.capabilities.editsFiles) {
    // The CLI already changed the files. Its edit and write events say which ones.
    const files = new Set<string>();
    for await (const e of provider.generate(req)) {
      if (e.type === "done") continue;
      if (e.type === "edit" || e.type === "write") files.add(e.file);
      yield e;
    }
    yield { type: "applied", files: [...files] };
    yield { type: "done" };
    return;
  }

  const toolUse = capabilitiesFor(provider, req.model).toolUse;
  let messages = req.messages;
  for (let attempt = 1; ; attempt++) {
    const changes: FileChange[] = [];
    let text = "";
    for await (const e of provider.generate({ ...req, messages })) {
      if (e.type === "done") continue;
      if (e.type === "edit" || e.type === "write") changes.push(e);
      if (e.type === "text") text += e.delta;
      yield e;
    }

    const result = await applyChanges(ref, changes);
    if (result.ok) {
      yield { type: "applied", files: result.files };
      yield { type: "done" };
      return;
    }
    if (attempt === 3) throw new ApplyError(result.failures);

    yield { type: "retry", attempt, failures: result.failures };
    const files = [...new Set(result.failures.map((f) => f.file))].map((f) => `"${f}"`).join(", ");
    const ask = retryRequest(attempt, describeFailures(result.failures), files, toolUse);
    messages = [...messages, attemptSummary(text, changes, toolUse), { role: "user", content: [{ type: "text", text: ask }] }];
  }
}
