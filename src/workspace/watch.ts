import { watch, type FSWatcher } from "node:fs";
import { mkdirSync } from "node:fs";
import { join, sep } from "node:path";

export interface DesignChange {
  project: string;
  design: string;
}

export interface DesignWatcher {
  /** Calls `listener` for each changed design. Returns a function that removes it. */
  subscribe(listener: (change: DesignChange) => void): () => void;
  /** Calls `listener` with the project when its UML file changes (an agent, another window, the app itself). */
  subscribeArchitecture(listener: (project: string) => void): () => void;
  /** Holds the changes of a design while a turn runs on it; `release` sends them as one. */
  hold(change: DesignChange): void;
  release(change: DesignChange): void;
  close(): void;
}

const NAME = /^[a-z0-9][a-z0-9-]*$/;

/**
 * "p/designs/d/styles.css" → { project: "p", design: "d" }. Other paths are not design files.
 * Hidden files (".comments.json") are not part of the page, so they do not reload it.
 */
export function designOf(relativePath: string): DesignChange | null {
  const parts = relativePath.split(/[\\/]/);
  const [project, designs, design] = parts;
  if (parts.length < 4 || designs !== "designs" || !NAME.test(project ?? "") || !NAME.test(design ?? "")) return null;
  if (parts.slice(3).some((part) => part.startsWith("."))) return null;
  return { project: project!, design: design! };
}

/** "p/architecture.json" → "p". A temporary file of the atomic write does not count; its rename does. */
export function architectureOf(relativePath: string): string | null {
  const parts = relativePath.split(/[\\/]/);
  return parts.length === 2 && parts[1] === "architecture.json" && NAME.test(parts[0] ?? "") ? parts[0]! : null;
}

/**
 * Watches workspace/projects. Many changes to one design within `debounceMs` give one event,
 * so a turn that writes several files reloads its frames once.
 */
export function watchDesigns(workspace: string, debounceMs = 100): DesignWatcher {
  const root = join(workspace, "projects");
  mkdirSync(root, { recursive: true });
  const listeners = new Set<(change: DesignChange) => void>();
  const umlListeners = new Set<(project: string) => void>();
  const umlTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const held = new Map<string, number>(); // key → hold count
  const pending = new Set<string>(); // changed while held

  const keyOf = (c: DesignChange) => `${c.project}/${c.design}`;
  const emit = (key: string) => {
    const [project, design] = key.split("/") as [string, string];
    for (const listener of listeners) listener({ project, design });
  };
  const schedule = (key: string) => {
    if (held.has(key)) {
      pending.add(key);
      return;
    }
    clearTimeout(timers.get(key));
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        emit(key);
      }, debounceMs),
    );
  };

  const watcher: FSWatcher = watch(root, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    const path = String(filename).split(sep).join("/");
    const change = designOf(path);
    if (change) schedule(keyOf(change));
    const project = architectureOf(path);
    if (project) {
      clearTimeout(umlTimers.get(project));
      umlTimers.set(project, setTimeout(() => { umlTimers.delete(project); for (const listener of umlListeners) listener(project); }, debounceMs));
    }
  });
  // A watch error (the folder was removed) must not crash the server; reloads stop until a restart.
  watcher.on("error", (e) => console.error("Design watcher stopped:", e));

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeArchitecture(listener) {
      umlListeners.add(listener);
      return () => umlListeners.delete(listener);
    },
    hold(change) {
      const key = keyOf(change);
      held.set(key, (held.get(key) ?? 0) + 1);
    },
    release(change) {
      const key = keyOf(change);
      const n = (held.get(key) ?? 1) - 1;
      if (n > 0) {
        held.set(key, n);
        return;
      }
      held.delete(key);
      if (pending.delete(key)) schedule(key);
    },
    close() {
      watcher.close();
      for (const t of [...timers.values(), ...umlTimers.values()]) clearTimeout(t);
      listeners.clear();
      umlListeners.clear();
    },
  };
}

/** GET /api/events: design and UML changes as server-sent events, until the client goes away. */
export function designEvents(watcher: DesignWatcher, req: Request, server?: Pick<Bun.Server<unknown>, "timeout">): Response {
  let unsubscribe = () => {}, unsubscribeUml = () => {};
  const stream = new ReadableStream<string>({
    start(controller) {
      // A comment line, so the client sees the stream open at once.
      controller.enqueue(": connected\n\n");
      unsubscribe = watcher.subscribe((change) => {
        try {
          controller.enqueue(`event: design-changed\ndata: ${JSON.stringify(change)}\n\n`);
        } catch {
          unsubscribe();
        }
      });
      unsubscribeUml = watcher.subscribeArchitecture((project) => {
        try {
          controller.enqueue(`event: architecture-changed\ndata: ${JSON.stringify({ project })}\n\n`);
        } catch {
          unsubscribeUml();
        }
      });
      req.signal.addEventListener("abort", () => {
        unsubscribe();
        unsubscribeUml();
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      });
    },
    cancel() {
      unsubscribe();
      unsubscribeUml();
    },
  });
  // The stream stays open while the app is open.
  server?.timeout(req, 0);
  return new Response(stream, {
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" },
  });
}
