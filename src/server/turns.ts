import { parseModelChoice, type Config, type ModelRef, type ProviderId } from "../config.ts";
import { ApplyError, runTurn, type TurnEvent } from "../generation/apply.ts";
import { assembleContext, capabilitiesFor, ContextTooLargeError, readDesignFiles } from "../generation/context.ts";
import { linkDesignSystemIn } from "../generation/ds-link.ts";
import { designOids, fixDesignOids } from "../generation/oids.ts";
import { touchedOids } from "../generation/touched.ts";
import { SYSTEM_PROMPT } from "../generation/prompts.ts";
import type { Provider } from "../providers/types.ts";
import { appendChat, appendCommit, historyMessages, readChat, turnCommits, type ChatEntry, type TurnComment } from "../workspace/chat.ts";
import type { FileStat } from "../workspace/git.ts";
import { CommentError, readComments, updateComment } from "../workspace/comments.ts";
import { activeDesignSystem, formatDesignSystem } from "../workspace/design-systems.ts";
import { designDir } from "../workspace/paths.ts";
import { repoForTurn } from "../generation/repo-context.ts";
import { saveUploads, type ImageType } from "../workspace/uploads.ts";
import { parseImages } from "./image-body.ts";
import type { DesignWatcher } from "../workspace/watch.ts";
import { designKey, DesignLocks } from "./locks.ts";

export interface TurnDeps {
  config: Config;
  getProvider: (id: ProviderId, config: Config) => Provider;
  /** Holds the live reload of a design while a turn runs on it, so the turn reloads it once. */
  watcher?: Pick<DesignWatcher, "hold" | "release">;
  /** Commits a completed turn (#11). Returns the commit id, or null when nothing changed. */
  commit?: (project: string, design: string, prompt: string) => Promise<string | null>;
  /** Shared with the design rename, so a design cannot move while a turn runs on it. */
  locks?: DesignLocks;
  /** True when the design has open variants; a turn then waits for a pick or a discard. */
  variantsOpen?: (params: { project: string; design: string }) => Promise<boolean>;
  /** The changed lines per file of some commits of a design, for the chat. */
  stats?: (project: string, design: string, shas: string[]) => Promise<Map<string, FileStat[]>>;
}

export interface TurnBody {
  text: string;
  /** The selected element's data-oid, or null. */
  target: string | null;
  /** Images, already scaled by the browser to IMAGE_LIMITS. */
  images: { mediaType: ImageType; data: Uint8Array }[];
  /** Ids of open comments to apply (#17). */
  comments: string[];
  /** A model the user chose for this turn; else the config's edit or generate model. */
  model: ModelRef | null;
}

/** Events on the stream: the turn events, an error event if the turn failed, then the commit. */
export type TurnStreamEvent =
  | TurnEvent
  | { type: "error"; kind: "context" | "apply" | "provider"; message: string }
  /** After `done`: the commit of the turn, or why it failed. The turn itself succeeded. */
  | { type: "commit"; sha: string | null; error?: string; stats?: FileStat[] }
  /** After `applied`: the comments of this turn whose element the turn changed. They are done now. */
  | { type: "comments"; done: string[] };

const MAX_TEXT = 20_000;
const MAX_COMMENTS = 50;
const COMMENT_ID = /^[0-9a-f-]{36}$/;
const OID = /^[A-Za-z0-9_-]{1,100}$/;

function parseBody(raw: unknown): TurnBody | string {
  if (typeof raw !== "object" || raw === null) return "The body must be a JSON object.";
  const { text = "", target, images, comments = [], model } = raw as Record<string, unknown>;
  if (!Array.isArray(comments) || comments.length > MAX_COMMENTS || !comments.every((c) => typeof c === "string" && COMMENT_ID.test(c))) {
    return `comments must be a list of at most ${MAX_COMMENTS} comment ids.`;
  }
  if (typeof text !== "string" || (!text.trim() && !comments.length)) return "text must be a non-empty string.";
  if (text.length > MAX_TEXT) return `text must be at most ${MAX_TEXT} characters.`;
  if (target !== undefined && target !== null && (typeof target !== "string" || !OID.test(target))) {
    return "target must be a data-oid or null.";
  }
  const parsed = parseImages(images);
  if (typeof parsed === "string") return parsed;
  const ref = model === undefined || model === null ? null : parseModelChoice(model);
  if (typeof ref === "string") return ref;
  return { text, target: (target as string | null | undefined) ?? null, images: parsed, comments: [...new Set(comments as string[])], model: ref };
}


/** The comments of a turn, in the order sent. Each must exist, be open and have its element in the design. */
async function resolveComments(workspace: string, params: { project: string; design: string }, dir: string, ids: string[]): Promise<TurnComment[]> {
  if (!ids.length) return [];
  const all = await readComments(workspace, params.project, params.design);
  const oids = await designOids(await readDesignFiles(dir));
  return ids.map((id) => {
    const c = all.find((x) => x.id === id);
    if (!c) throw new CommentError("A comment of this turn does not exist. Load the comments again.", 400);
    if (c.status !== "open") throw new CommentError(`The comment on "${c.oid}" is done already.`, 400);
    if (!oids.has(c.oid)) throw new CommentError(`The element "${c.oid}" of a comment is not in the design now.`, 400);
    return { id: c.id, oid: c.oid, text: c.text };
  });
}

function errorEvent(e: unknown): TurnStreamEvent {
  const message = e instanceof Error ? e.message : String(e);
  if (e instanceof ContextTooLargeError) return { type: "error", kind: "context", message };
  if (e instanceof ApplyError) return { type: "error", kind: "apply", message };
  return { type: "error", kind: "provider", message };
}

const sse = (e: TurnStreamEvent) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;

/** A stored message, and for an answer that made a commit, its changed lines per file. */
export type ChatEntryView = ChatEntry & { stats?: FileStat[] };

/** GET /api/projects/:project/designs/:design/chat: the stored messages of one design. */
export async function getChat(
  workspace: string,
  params: { project: string; design: string },
  stats?: TurnDeps["stats"],
): Promise<Response> {
  try {
    designDir(workspace, params.project, params.design); // validates both names
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
  const entries: ChatEntryView[] = await readChat(workspace, params.project, params.design);
  if (stats) {
    const commits = await turnCommits(workspace, params.project, params.design);
    const counts = await stats(params.project, params.design, [...commits.values()]);
    for (const e of entries) {
      const sha = e.role === "assistant" ? commits.get(e.turn) : undefined;
      const s = sha ? counts.get(sha) : undefined;
      if (s) e.stats = s;
    }
  }
  return Response.json(entries);
}

/**
 * POST /api/projects/:project/designs/:design/turns runs one turn and streams its events as
 * server-sent events. One turn runs per design at a time; a second request gets 409.
 * When the client goes away or cancels the stream, the provider call is aborted.
 * Each turn is stored in the project's chat.jsonl; completed turns are the history of the next.
 */
export function createTurnHandler(deps: TurnDeps) {
  const locks = deps.locks ?? new DesignLocks();
  /** The running turn of each design. `byUser`: the user stopped it (DELETE …/turns), not a closed connection. */
  const running = new Map<string, { abort: AbortController; byUser: boolean }>();

  const handler = async (
    req: Request,
    params: { project: string; design: string },
    server?: Pick<Bun.Server<unknown>, "timeout">,
  ): Promise<Response> => {
    let dir: string;
    try {
      dir = designDir(deps.config.workspace, params.project, params.design);
    } catch (e) {
      return Response.json({ error: (e as Error).message }, { status: 400 });
    }
    if (!(await Bun.file(`${dir}/index.html`).exists())) {
      return Response.json({ error: "Design not found." }, { status: 404 });
    }

    let body: TurnBody | string;
    try {
      body = parseBody(await req.json());
    } catch {
      body = "The body must be JSON.";
    }
    if (typeof body === "string") return Response.json({ error: body }, { status: 400 });

    const ref = body.model ?? (body.target ? deps.config.models.edit : deps.config.models.generate);
    let provider: Provider;
    try {
      provider = deps.getProvider(ref.provider, deps.config);
    } catch (e) {
      return Response.json({ error: (e as Error).message }, { status: 400 });
    }
    if (body.images.length && !capabilitiesFor(provider, ref.model).vision) {
      return Response.json(
        { error: `${ref.provider}:${ref.model} cannot read images. Remove the images, or pick a model with vision in the model menu of the chat.` },
        { status: 400 },
      );
    }

    let comments: TurnComment[];
    try {
      comments = await resolveComments(deps.config.workspace, params, dir, body.comments);
    } catch (e) {
      if (e instanceof CommentError) return Response.json({ error: e.message }, { status: e.status });
      throw e;
    }

    if (await deps.variantsOpen?.(params)) {
      return Response.json({ error: "This design has open variants. Pick one or discard them first." }, { status: 409 });
    }

    const key = designKey(params.project, params.design);
    if (!locks.tryLock(key)) {
      return Response.json({ error: "A turn is already running for this design." }, { status: 409 });
    }
    deps.watcher?.hold(params);

    const abort = new AbortController();
    const onClientAbort = () => abort.abort();
    req.signal.addEventListener("abort", onClientAbort);
    const run = { abort, byUser: false };
    running.set(key, run);
    const turn = { ...body, comments };

    const workspace = deps.config.workspace;
    const turnId = crypto.randomUUID();
    const stream = new ReadableStream<string>({
      async start(controller) {
        const send = (e: TurnStreamEvent) => {
          if (!abort.signal.aborted) controller.enqueue(sse(e));
        };
        let text = "";
        const usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
        const files = new Set<string>();
        let status: "done" | "error" | "stopped" = "done";
        let stop: "user" | undefined;
        let error: string | undefined;
        let started = false;
        let commentsDone: string[] = [];
        // A comment is done when the turn changed its element. The file goes into the commit.
        const markDone = async (list: TurnComment[], before: Awaited<ReturnType<typeof readDesignFiles>>) => {
          const touched = await touchedOids(before, await readDesignFiles(dir), list.map((c) => c.oid));
          const done: string[] = [];
          for (const c of list.filter((c) => touched.has(c.oid))) {
            try {
              await updateComment(workspace, params.project, params.design, c.id, { status: "done" });
              done.push(c.id);
            } catch (e) {
              // The user deleted it meanwhile; the other comments still count.
              if (!(e instanceof CommentError)) throw e;
            }
          }
          return done;
        };
        try {
          // Read the history before this turn's own user line is in the file.
          const entries = await readChat(workspace, params.project, params.design);
          const images = await saveUploads(workspace, params.project, turnId, turn.images);
          await appendChat(workspace, params.project, {
            role: "user",
            turn: turnId,
            design: params.design,
            at: new Date().toISOString(),
            text: turn.text,
            target: turn.target,
            ...(images.length ? { images } : {}),
            ...(turn.comments.length ? { comments: turn.comments } : {}),
          });
          started = true;
          const history = historyMessages(entries);
          const before = await readDesignFiles(dir);
          const ds = await activeDesignSystem(workspace, params.project);
          const readsFiles = provider.capabilities.editsFiles;
          const repo = await repoForTurn(workspace, params.project, readsFiles);
          const context = assembleContext({
            systemPrompt: SYSTEM_PROMPT.text,
            designSystem: ds ? formatDesignSystem(ds) : null,
            repo: repo?.text ?? null,
            files: before,
            history,
            turn,
            capabilities: capabilitiesFor(provider, ref.model),
          });
          const request = {
            model: ref.model,
            system: context.system,
            messages: context.messages,
            signal: abort.signal,
            cwd: dir,
            ...(repo && readsFiles ? { readDirs: [repo.dir] } : {}),
          };
          for await (let e of runTurn(provider, request, { ...params, workspace })) {
            if (e.type === "text") text += e.delta;
            if (e.type === "usage") {
              usage.inputTokens += e.inputTokens;
              usage.outputTokens += e.outputTokens;
              usage.cachedTokens += e.cachedTokens;
            }
            let after: TurnStreamEvent | null = null;
            if (e.type === "applied") {
              // Each meaningful element keeps or gets a unique data-oid, before the commit.
              const fixed = await fixDesignOids(dir, before, await readDesignFiles(dir));
              // Pages link the design system's stylesheets instead of copying them.
              const linked = ds ? await linkDesignSystemIn(dir, await readDesignFiles(dir), ds) : [];
              e = { ...e, files: [...new Set([...e.files, ...fixed, ...linked])] };
              e.files.forEach((f) => files.add(f));
              if (turn.comments.length) {
                commentsDone = await markDone(turn.comments, before);
                after = { type: "comments", done: commentsDone };
              }
            }
            if (e.type === "retry") text = ""; // the next attempt answers again
            send(e);
            if (after) send(after);
          }
        } catch (e) {
          // An abort means the client is gone or stopped the turn: nobody reads an error event.
          if (abort.signal.aborted) {
            status = "stopped";
            if (run.byUser) stop = "user";
          } else {
            status = "error";
            const event = errorEvent(e);
            error = event.type === "error" ? event.message : String(e);
            send(event);
          }
        } finally {
          if (started) {
            await appendChat(workspace, params.project, {
              role: "assistant",
              turn: turnId,
              design: params.design,
              at: new Date().toISOString(),
              text,
              status,
              provider: ref.provider,
              model: ref.model,
              usage,
              files: [...files],
              ...(error ? { error } : {}),
              ...(stop ? { stop } : {}),
              ...(commentsDone.length ? { commentsDone } : {}),
              prompt: SYSTEM_PROMPT.version,
            }).catch((e) => console.error("Could not write chat.jsonl:", e));
          }
          // Only a completed turn that changed files is a version. A failed turn makes no commit.
          if (status === "done" && files.size > 0 && deps.commit) {
            try {
              const message = turn.text.trim() || `Apply ${turn.comments.length} comment${turn.comments.length === 1 ? "" : "s"}`;
              const sha = await deps.commit(params.project, params.design, message);
              // The version history names the model of this commit through this line.
              if (sha) await appendCommit(workspace, params.project, { turn: turnId, design: params.design, sha });
              const counts = sha && deps.stats ? (await deps.stats(params.project, params.design, [sha]).catch(() => null))?.get(sha) : undefined;
              send({ type: "commit", sha, ...(counts ? { stats: counts } : {}) });
            } catch (e) {
              const message = e instanceof Error ? e.message : String(e);
              console.error("Could not commit the turn:", message);
              send({ type: "commit", sha: null, error: message });
            }
          }
          if (running.get(key) === run) running.delete(key);
          locks.unlock(key);
          deps.watcher?.release(params);
          req.signal.removeEventListener("abort", onClientAbort);
          try {
            controller.close();
          } catch {
            // Already closed by a cancel.
          }
        }
      },
      cancel() {
        abort.abort();
      },
    });

    // A model can be quiet for longer than Bun's idle timeout (10 s), for example while it
    // writes a long tool call. The stream ends with the turn, so this request has no timeout.
    server?.timeout(req, 0);
    return new Response(stream, {
      headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" },
    });
  };

  /**
   * DELETE …/turns: the user stops the design's running turn. The answer is stored with
   * `stop: "user"`; a turn that ends because its connection closed (a reload, a closed tab)
   * is stored without it.
   */
  const stop = (params: { project: string; design: string }): Response => {
    let key: string;
    try {
      designDir(deps.config.workspace, params.project, params.design);
      key = designKey(params.project, params.design);
    } catch (e) {
      return Response.json({ error: (e as Error).message }, { status: 400 });
    }
    const run = running.get(key);
    if (!run) return new Response(null, { status: 204 });
    run.byUser = true;
    run.abort.abort();
    return new Response(null, { status: 204 });
  };

  return Object.assign(handler, { stop });
}
