import type { Config, ProviderId } from "../config.ts";
import { ApplyError, runTurn, type TurnEvent } from "../generation/apply.ts";
import { assembleContext, capabilitiesFor, ContextTooLargeError, readDesignFiles } from "../generation/context.ts";
import { SYSTEM_PROMPT } from "../generation/prompts.ts";
import type { Provider } from "../providers/types.ts";
import { appendChat, historyMessages, readChat } from "../workspace/chat.ts";
import { designDir } from "../workspace/paths.ts";

export interface TurnDeps {
  config: Config;
  getProvider: (id: ProviderId, config: Config) => Provider;
}

export interface TurnBody {
  text: string;
  /** The selected element's data-oid, or null. */
  target: string | null;
}

/** Events on the stream: the turn events, then an error event if the turn failed. */
export type TurnStreamEvent = TurnEvent | { type: "error"; kind: "context" | "apply" | "provider"; message: string };

const MAX_TEXT = 20_000;
const OID = /^[A-Za-z0-9_-]{1,100}$/;

function parseBody(raw: unknown): TurnBody | string {
  if (typeof raw !== "object" || raw === null) return "The body must be a JSON object.";
  const { text, target } = raw as Record<string, unknown>;
  if (typeof text !== "string" || !text.trim()) return "text must be a non-empty string.";
  if (text.length > MAX_TEXT) return `text must be at most ${MAX_TEXT} characters.`;
  if (target !== undefined && target !== null && (typeof target !== "string" || !OID.test(target))) {
    return "target must be a data-oid or null.";
  }
  return { text, target: (target as string | null | undefined) ?? null };
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
  const running = new Set<string>();

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

    const key = `${params.project}/${params.design}`;
    if (running.has(key)) {
      return Response.json({ error: "A turn is already running for this design." }, { status: 409 });
    }
    running.add(key);

    const ref = body.target ? deps.config.models.edit : deps.config.models.generate;
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
          await appendChat(workspace, params.project, {
            role: "user",
            turn: turnId,
            design: params.design,
            at: new Date().toISOString(),
            text: turn.text,
            target: turn.target,
          });
          started = true;
          const provider = deps.getProvider(ref.provider, deps.config);
          const history = historyMessages(entries);
          const context = assembleContext({
            systemPrompt: SYSTEM_PROMPT.text,
            designSystem: null, // M3
            files: await readDesignFiles(dir),
            history,
            turn,
            capabilities: capabilitiesFor(provider, ref.model),
          });
          const request = { model: ref.model, system: context.system, messages: context.messages, signal: abort.signal, cwd: dir };
          for await (const e of runTurn(provider, request, { ...params, workspace })) {
            if (e.type === "text") text += e.delta;
            if (e.type === "usage") {
              usage.inputTokens += e.inputTokens;
              usage.outputTokens += e.outputTokens;
              usage.cachedTokens += e.cachedTokens;
            }
            if (e.type === "applied") e.files.forEach((f) => files.add(f));
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
          running.delete(key);
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
