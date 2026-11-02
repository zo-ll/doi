import { isApp } from "../workspace/layout.ts";
import { parseModelChoice, type Config, type ModelRef, type ProviderId } from "../config.ts";
import { ApplyError, runTurn, type TurnEvent } from "../generation/apply.ts";
import { assembleContext, capabilitiesFor, ContextTooLargeError, readDesignFiles } from "../generation/context.ts";
import { linkDesignSystemIn } from "../generation/ds-link.ts";
import { fixDesignOids } from "../generation/oids.ts";
import { activeDesignSystem, formatDesignSystem } from "../workspace/design-systems.ts";
import { repoForTurn } from "../generation/repo-context.ts";
import { SYSTEM_PROMPT } from "../generation/prompts.ts";
import type { Provider } from "../providers/types.ts";
import { appendChat, appendCommit, chatFile, historyMessages, readChat } from "../workspace/chat.ts";
import { designDir } from "../workspace/paths.ts";
import {
  createSet,
  openSet,
  pickVariant,
  removeSet,
  saveSet,
  setDir,
  variantDir,
  VARIANT_COUNT,
  type Variant,
  type VariantSet,
} from "../workspace/variants.ts";
import { designKey, DesignLocks } from "./locks.ts";

export interface VariantDeps {
  config: Config;
  getProvider: (id: ProviderId, config: Config) => Provider;
  locks: DesignLocks;
  /** Commits these paths. Returns the commit id, or null when nothing changed. */
  commit: (paths: string[], message: string) => Promise<string | null>;
}

/** Events of a variants run, as server-sent events. */
export type VariantStreamEvent =
  | { type: "variants"; set: string; variants: { n: number; provider: ProviderId; model: string }[] }
  | { type: "variant"; n: number; event: TurnEvent | { type: "error"; kind: "context" | "apply" | "provider"; message: string } }
  /** All variants ended. `commit` holds the set in the history; null when none succeeded. */
  | { type: "variants-done"; commit: string | null; error?: string };

/** A set as GET sends it: `running` while its turns run. */
export type VariantSetView = VariantSet & { running: boolean };

type Params = { project: string; design: string };

const MAX_TEXT = 20_000;
const OID = /^[A-Za-z0-9_-]{1,100}$/;
/** A model name goes to a CLI as one argument: no leading "-", no spaces. */

const fail = (message: string, status = 400) => Response.json({ error: message }, { status });
const sse = (e: VariantStreamEvent) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;

function parseModels(raw: unknown, count: number, fallback: ModelRef): ModelRef[] | string {
  if (raw === undefined || raw === null) return Array.from({ length: count }, () => fallback);
  if (!Array.isArray(raw) || raw.length !== count) return `models must be a list of ${count} "<provider>:<model>" values.`;
  const out: ModelRef[] = [];
  for (const m of raw) {
    if (typeof m !== "string") return 'Each model must be "<provider>:<model>".';
    const ref = parseModelChoice(m);
    if (typeof ref === "string") return ref;
    out.push(ref);
  }
  return out;
}

export function createVariantHandlers(deps: VariantDeps) {
  const workspace = deps.config.workspace;
  /** Sets whose turns run now. A set in set.json as "running" but not here was cut by a restart. */
  const running = new Set<string>();

  async function check(params: Params): Promise<string | Response> {
    let dir: string;
    try {
      dir = designDir(workspace, params.project, params.design);
    } catch (e) {
      return fail((e as Error).message);
    }
    if (!(await Bun.file(`${dir}/index.html`).exists())) return fail("Design not found.", 404);
    return dir;
  }

  /** The open set, with variants that were cut by a restart marked as stopped. */
  async function current(params: Params): Promise<VariantSetView | null> {
    const set = await openSet(workspace, params.project, params.design);
    if (!set) return null;
    const live = running.has(set.id);
    if (!live) {
      for (const v of set.variants) if (v.status === "running") Object.assign(v, { status: "stopped" });
    }
    return { ...set, running: live };
  }

  /** GET …/designs/:design/variants: the open set, or null. */
  async function get(params: Params): Promise<Response> {
    const dir = await check(params);
    if (dir instanceof Response) return dir;
    return Response.json(await current(params));
  }

  /** POST …/designs/:design/variants { text, target?, count, models? }: runs the turns and streams them. */
  async function post(req: Request, params: Params, server?: Pick<Bun.Server<unknown>, "timeout">): Promise<Response> {
    const dir = await check(params);
    if (dir instanceof Response) return dir;
    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
      if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error();
    } catch {
      return fail("The body must be a JSON object.");
    }
    const { text, target = null, count } = body;
    if (typeof text !== "string" || !text.trim()) return fail("text must be a non-empty string.");
    if (text.length > MAX_TEXT) return fail(`text must be at most ${MAX_TEXT} characters.`);
    if (target !== null && (typeof target !== "string" || !OID.test(target))) return fail("target must be a data-oid or null.");
    if (typeof count !== "number" || !Number.isInteger(count) || count < VARIANT_COUNT.min || count > VARIANT_COUNT.max) {
      return fail(`count must be ${VARIANT_COUNT.min} to ${VARIANT_COUNT.max}.`);
    }
    const fallback = target ? deps.config.models.edit : deps.config.models.generate;
    const models = parseModels(body.models, count, fallback);
    if (typeof models === "string") return fail(models);
    const providers: Provider[] = [];
    for (const m of models) {
      try {
        providers.push(deps.getProvider(m.provider, deps.config));
      } catch (e) {
        return fail((e as Error).message);
      }
    }

    if (await openSet(workspace, params.project, params.design)) {
      return fail("This design has open variants. Pick one or discard them first.", 409);
    }
    const key = designKey(params.project, params.design);
    if (!deps.locks.tryLock(key)) return fail("A turn is already running for this design.", 409);

    let set: VariantSet;
    let history;
    let before;
    let ds;
    try {
      ds = await activeDesignSystem(workspace, params.project);
      history = historyMessages(await readChat(workspace, params.project, params.design));
      before = await readDesignFiles(dir);
      set = await createSet(workspace, params.project, params.design, {
        prompt: text,
        target: target as string | null,
        promptVersion: SYSTEM_PROMPT.version,
        variants: models.map((m, i) => ({
          n: i + 1,
          provider: m.provider,
          model: m.model,
          status: "running",
          text: "",
          usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
          files: [],
        })),
      });
    } catch (e) {
      deps.locks.unlock(key);
      throw e;
    }
    running.add(set.id);

    const abort = new AbortController();
    const onClientAbort = () => abort.abort();
    req.signal.addEventListener("abort", onClientAbort);

    const stream = new ReadableStream<string>({
      async start(controller) {
        const send = (e: VariantStreamEvent) => {
          if (!abort.signal.aborted) controller.enqueue(sse(e));
        };
        send({ type: "variants", set: set.id, variants: set.variants.map(({ n, provider, model }) => ({ n, provider, model })) });

        const runOne = async (v: Variant, provider: Provider) => {
          const vdir = variantDir(workspace, params.project, params.design, set.id, v.n);
          try {
            const readsFiles = provider.capabilities.editsFiles;
            const repo = await repoForTurn(workspace, params.project, readsFiles);
            const context = assembleContext({
              systemPrompt: SYSTEM_PROMPT.text,
              designSystem: ds ? formatDesignSystem(ds) : null,
              repo: repo?.text ?? null,
              app: await isApp(workspace, params.project, params.design),
              files: before,
              history,
              turn: { text, target: target as string | null },
              capabilities: capabilitiesFor(provider, v.model),
            });
            const request = {
              model: v.model,
              system: context.system,
              messages: context.messages,
              signal: abort.signal,
              cwd: vdir,
              ...(repo && readsFiles ? { readDirs: [repo.dir] } : {}),
            };
            for await (let e of runTurn(provider, request, { ...params, workspace, dir: vdir })) {
              if (e.type === "text") v.text += e.delta;
              if (e.type === "retry") v.text = "";
              if (e.type === "usage") {
                v.usage.inputTokens += e.inputTokens;
                v.usage.outputTokens += e.outputTokens;
                v.usage.cachedTokens += e.cachedTokens;
              }
              if (e.type === "applied") {
                const fixed = await fixDesignOids(vdir, before, await readDesignFiles(vdir));
                const linked = ds ? await linkDesignSystemIn(vdir, await readDesignFiles(vdir), ds) : [];
                e = { ...e, files: [...new Set([...e.files, ...fixed, ...linked])] };
                v.files = e.files;
              }
              send({ type: "variant", n: v.n, event: e });
            }
            v.status = "done";
          } catch (e) {
            if (abort.signal.aborted) v.status = "stopped";
            else {
              v.status = "error";
              v.error = e instanceof Error ? e.message : String(e);
              const kind = e instanceof ContextTooLargeError ? "context" : e instanceof ApplyError ? "apply" : "provider";
              send({ type: "variant", n: v.n, event: { type: "error", kind, message: v.error } });
            }
          }
          await saveSet(workspace, params.project, params.design, set).catch((e) => console.error("Could not save the variant set:", e));
        };

        try {
          await Promise.all(set.variants.map((v, i) => runOne(v, providers[i]!)));
          // A set without a good variant has nothing to pick.
          if (!set.variants.some((v) => v.status === "done")) {
            await removeSet(workspace, params.project, params.design, set.id);
            send({ type: "variants-done", commit: null, error: "No variant was made." });
          } else {
            try {
              const sha = await deps.commit([setDir(workspace, params.project, params.design, set.id)], `Variants: ${text}`);
              send({ type: "variants-done", commit: sha });
            } catch (e) {
              send({ type: "variants-done", commit: null, error: e instanceof Error ? e.message : String(e) });
            }
          }
        } finally {
          running.delete(set.id);
          deps.locks.unlock(key);
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
    // Models can be quiet for longer than Bun's idle timeout (10 s).
    server?.timeout(req, 0);
    return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" } });
  }

  /** Runs `job` on the open set `id` with the design locked. */
  async function withSet(params: Params & { set: string }, job: (set: VariantSet) => Promise<Response>): Promise<Response> {
    const dir = await check(params);
    if (dir instanceof Response) return dir;
    const key = designKey(params.project, params.design);
    if (!deps.locks.tryLock(key)) return fail("A turn is running for this design. Wait for it to end.", 409);
    try {
      const set = await openSet(workspace, params.project, params.design);
      if (!set || set.id !== params.set) return fail("These variants are not open.", 404);
      return await job(set);
    } finally {
      deps.locks.unlock(key);
    }
  }

  /**
   * POST …/variants/:set/pick { n }: variant n becomes the design. The chat gets the prompt and
   * that variant's answer. The set folder goes away; its commit keeps all variants in the history.
   */
  function pick(req: Request, params: Params & { set: string }): Promise<Response> {
    return withSet(params, async (set) => {
      let n: unknown;
      try {
        n = ((await req.json()) as { n?: unknown }).n;
      } catch {
        return fail("The body must be JSON.");
      }
      const v = set.variants.find((x) => x.n === n);
      if (!v) return fail("No such variant.");
      if (v.status !== "done") return fail(`Variant ${v.n} did not finish, so it cannot be picked.`);
      await pickVariant(workspace, params.project, params.design, set.id, v.n);
      const turn = crypto.randomUUID();
      const at = new Date().toISOString();
      await appendChat(workspace, params.project, { role: "user", turn, design: params.design, at, text: set.prompt, target: set.target });
      await appendChat(workspace, params.project, {
        role: "assistant",
        turn,
        design: params.design,
        at,
        text: v.text,
        status: "done",
        provider: v.provider,
        model: v.model,
        usage: v.usage,
        files: v.files,
        variant: v.n,
        prompt: set.promptVersion,
      });
      await removeSet(workspace, params.project, params.design, set.id);
      const paths = [designDir(workspace, params.project, params.design), setDir(workspace, params.project, params.design, set.id), chatFile(workspace, params.project)];
      try {
        const sha = await deps.commit(paths, `Pick variant ${v.n}: ${set.prompt}`);
        if (sha) await appendCommit(workspace, params.project, { turn, design: params.design, sha });
        return Response.json({ commit: sha });
      } catch (e) {
        return Response.json({ commit: null, commitError: e instanceof Error ? e.message : String(e) });
      }
    });
  }

  /** DELETE …/variants/:set: removes the set. Its commit keeps the variants in the history. */
  function discard(params: Params & { set: string }): Promise<Response> {
    return withSet(params, async (set) => {
      await removeSet(workspace, params.project, params.design, set.id);
      try {
        return Response.json({ commit: await deps.commit([setDir(workspace, params.project, params.design, set.id)], `Discard variants: ${set.prompt}`) });
      } catch (e) {
        return Response.json({ commit: null, commitError: e instanceof Error ? e.message : String(e) });
      }
    });
  }

  return { get, post, pick, discard, isOpen: async (p: Params) => (await openSet(workspace, p.project, p.design)) !== null };
}
