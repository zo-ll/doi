import type { Config, ProviderId } from "../config.ts";
import { ApplyError, runTurn, type TurnEvent } from "../generation/apply.ts";
import { assembleContext, capabilitiesFor, ContextTooLargeError, readDesignFiles } from "../generation/context.ts";
import { fixDesignOids } from "../generation/oids.ts";
import { SYSTEM_PROMPT } from "../generation/prompts.ts";
import type { Provider } from "../providers/types.ts";
import { appendChat, historyMessages, readChat } from "../workspace/chat.ts";
import { designDir } from "../workspace/paths.ts";
import { IMAGE_LIMITS, IMAGE_TYPES, isImageType, saveUploads, type ImageType } from "../workspace/uploads.ts";
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
}

export interface TurnBody {
  text: string;
  /** The selected element's data-oid, or null. */
  target: string | null;
  /** Images, already scaled by the browser to IMAGE_LIMITS. */
  images: { mediaType: ImageType; data: Uint8Array }[];
}

/** Events on the stream: the turn events, an error event if the turn failed, then the commit. */
export type TurnStreamEvent =
  | TurnEvent
  | { type: "error"; kind: "context" | "apply" | "provider"; message: string }
  /** After `done`: the commit of the turn, or why it failed. The turn itself succeeded. */
  | { type: "commit"; sha: string | null; error?: string };

const MAX_TEXT = 20_000;
const OID = /^[A-Za-z0-9_-]{1,100}$/;

function parseBody(raw: unknown): TurnBody | string {
  if (typeof raw !== "object" || raw === null) return "The body must be a JSON object.";
  const { text, target, images } = raw as Record<string, unknown>;
  if (typeof text !== "string" || !text.trim()) return "text must be a non-empty string.";
  if (text.length > MAX_TEXT) return `text must be at most ${MAX_TEXT} characters.`;
  if (target !== undefined && target !== null && (typeof target !== "string" || !OID.test(target))) {
    return "target must be a data-oid or null.";
  }
  const parsed = parseImages(images);
  if (typeof parsed === "string") return parsed;
  return { text, target: (target as string | null | undefined) ?? null, images: parsed };
}

function parseImages(raw: unknown): TurnBody["images"] | string {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return "images must be a list.";
  if (raw.length > IMAGE_LIMITS.count) return `Send at most ${IMAGE_LIMITS.count} images in one message.`;
  const out: TurnBody["images"] = [];
  for (const img of raw) {
    const { mediaType, data } = (img ?? {}) as Record<string, unknown>;
    if (typeof mediaType !== "string" || !isImageType(mediaType)) {
      return `Images must be ${Object.keys(IMAGE_TYPES).join(", ")}.`;
    }
    if (typeof data !== "string" || !data) return "Each image needs base64 data.";
    const bytes = Buffer.from(data, "base64");
    if (!bytes.length) return "An image is empty.";
    if (bytes.length > IMAGE_LIMITS.bytes) {
      return `An image is larger than ${Math.round(IMAGE_LIMITS.bytes / 1_000_000)} MB. The app scales images down; send the scaled image.`;
    }
    out.push({ mediaType, data: new Uint8Array(bytes) });
  }
  return out;
}

function errorEvent(e: unknown): TurnStreamEvent {
  const message = e instanceof Error ? e.message : String(e);
  if (e instanceof ContextTooLargeError) return { type: "error", kind: "context", message };
  if (e instanceof ApplyError) return { type: "error", kind: "apply", message };
  return { type: "error", kind: "provider", message };
}

const sse = (e: TurnStreamEvent) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;

/** GET /api/projects/:project/designs/:design/chat: the stored messages of one design. */
export async function getChat(workspace: string, params: { project: string; design: string }): Promise<Response> {
  try {
    designDir(workspace, params.project, params.design); // validates both names
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
  return Response.json(await readChat(workspace, params.project, params.design));
}

/**
 * POST /api/projects/:project/designs/:design/turns runs one turn and streams its events as
 * server-sent events. One turn runs per design at a time; a second request gets 409.
 * When the client goes away or cancels the stream, the provider call is aborted.
 * Each turn is stored in the project's chat.jsonl; completed turns are the history of the next.
 */
export function createTurnHandler(deps: TurnDeps) {
  const locks = deps.locks ?? new DesignLocks();

  return async (
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

    const ref = body.target ? deps.config.models.edit : deps.config.models.generate;
    let provider: Provider;
    try {
      provider = deps.getProvider(ref.provider, deps.config);
    } catch (e) {
      return Response.json({ error: (e as Error).message }, { status: 400 });
    }
    if (body.images.length && !capabilitiesFor(provider, ref.model).vision) {
      return Response.json(
        { error: `${ref.provider}:${ref.model} cannot read images. Remove the images, or choose a model with vision in config.toml.` },
        { status: 400 },
      );
    }

    const key = designKey(params.project, params.design);
    if (!locks.tryLock(key)) {
      return Response.json({ error: "A turn is already running for this design." }, { status: 409 });
    }
    deps.watcher?.hold(params);

    const abort = new AbortController();
    const onClientAbort = () => abort.abort();
    req.signal.addEventListener("abort", onClientAbort);
    const turn = body;

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
        let error: string | undefined;
        let started = false;
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
          });
          started = true;
          const history = historyMessages(entries);
          const before = await readDesignFiles(dir);
          const context = assembleContext({
            systemPrompt: SYSTEM_PROMPT.text,
            designSystem: null, // M3
            files: before,
            history,
            turn,
            capabilities: capabilitiesFor(provider, ref.model),
          });
          const request = { model: ref.model, system: context.system, messages: context.messages, signal: abort.signal, cwd: dir };
          for await (let e of runTurn(provider, request, { ...params, workspace })) {
            if (e.type === "text") text += e.delta;
            if (e.type === "usage") {
              usage.inputTokens += e.inputTokens;
              usage.outputTokens += e.outputTokens;
              usage.cachedTokens += e.cachedTokens;
            }
            if (e.type === "applied") {
              // Each meaningful element keeps or gets a unique data-oid, before the commit.
              const fixed = await fixDesignOids(dir, before, await readDesignFiles(dir));
              e = { ...e, files: [...new Set([...e.files, ...fixed])] };
              e.files.forEach((f) => files.add(f));
            }
            if (e.type === "retry") text = ""; // the next attempt answers again
            send(e);
          }
        } catch (e) {
          // An abort means the client is gone or stopped the turn: nobody reads an error event.
          if (abort.signal.aborted) {
            status = "stopped";
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
              prompt: SYSTEM_PROMPT.version,
            }).catch((e) => console.error("Could not write chat.jsonl:", e));
          }
          // Only a completed turn that changed files is a version. A failed turn makes no commit.
          if (status === "done" && files.size > 0 && deps.commit) {
            try {
              send({ type: "commit", sha: await deps.commit(params.project, params.design, turn.text) });
            } catch (e) {
              const message = e instanceof Error ? e.message : String(e);
              console.error("Could not commit the turn:", message);
              send({ type: "commit", sha: null, error: message });
            }
          }
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
}
