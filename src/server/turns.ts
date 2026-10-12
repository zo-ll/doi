import type { Config, ProviderId } from "../config.ts";
import { ApplyError, runTurn, type TurnEvent } from "../generation/apply.ts";
import { assembleContext, capabilitiesFor, ContextTooLargeError, readDesignFiles } from "../generation/context.ts";
import { SYSTEM_PROMPT } from "../generation/prompts.ts";
import type { Provider } from "../providers/types.ts";
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

/**
 * POST /api/projects/:project/designs/:design/turns runs one turn and streams its events as
 * server-sent events. One turn runs per design at a time; a second request gets 409.
 * When the client goes away or cancels the stream, the provider call is aborted.
 */
export function createTurnHandler(deps: TurnDeps) {
  const running = new Set<string>();

  return async (req: Request, params: { project: string; design: string }): Promise<Response> => {
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

    const stream = new ReadableStream<string>({
      async start(controller) {
        const send = (e: TurnStreamEvent) => {
          if (!abort.signal.aborted) controller.enqueue(sse(e));
        };
        try {
          const provider = deps.getProvider(ref.provider, deps.config);
          const context = assembleContext({
            systemPrompt: SYSTEM_PROMPT.text,
            designSystem: null, // M3
            files: await readDesignFiles(dir),
            history: [], // #8
            turn,
            capabilities: capabilitiesFor(provider, ref.model),
          });
          const request = { model: ref.model, system: context.system, messages: context.messages, signal: abort.signal, cwd: dir };
          for await (const e of runTurn(provider, request, { ...params, workspace: deps.config.workspace })) send(e);
        } catch (e) {
          // An abort means the client is gone or stopped the turn: nobody reads an error event.
          if (!abort.signal.aborted) send(errorEvent(e));
        } finally {
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

    return new Response(stream, {
      headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" },
    });
  };
}
