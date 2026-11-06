import { useCallback, useEffect, useState } from "react";
import { commentsUrl, getJSON, sendJSON, type CommentView, type Load } from "./api.ts";
import type { Active } from "./api.ts";
import { useResetOn } from "./reset-on.ts";

/** A pin on the canvas: one element and the numbers of its open comments. */
export interface Pin {
  oid: string;
  numbers: number[];
}

/** Open comments on elements that exist, one pin per element. Numbers count from 1 in list order. */
export function pinsOf(comments: CommentView[]): Pin[] {
  const pins = new Map<string, number[]>();
  comments.forEach((c, i) => {
    if (c.status !== "open" || c.detached) return;
    pins.set(c.oid, [...(pins.get(c.oid) ?? []), i + 1]);
  });
  return [...pins].map(([oid, numbers]) => ({ oid, numbers }));
}

/**
 * The comments of the open design. They load again when the design files change
 * (`revision`), because an element can go away or come back.
 */
export function useComments(active: Active | null, revision: number) {
  const [comments, setComments] = useState<Load<CommentView[]>>({ state: "loading" });
  const [reloads, setReloads] = useState(0);
  const project = active?.project;
  const design = active?.design;

  // A new design starts empty, not with the comments of the old one.
  useResetOn(active ? `${active.project}/${active.design}` : null, () => setComments({ state: "loading" }));

  useEffect(() => {
    if (!project || !design) return;
    let live = true;
    getJSON<CommentView[]>(commentsUrl(project, design))
      .then((data) => live && setComments({ state: "ready", data }))
      .catch((e) => live && setComments({ state: "error", message: (e as Error).message }));
    return () => {
      live = false;
    };
  }, [project, design, revision, reloads]);

  const reload = useCallback(() => setReloads((n) => n + 1), []);

  /** Runs a change, then loads the list again. Throws the server's message. */
  const change = useCallback(
    async (method: "POST" | "PATCH" | "DELETE", id: string | undefined, body?: unknown) => {
      if (!project || !design) return;
      try {
        await sendJSON(method, commentsUrl(project, design, id), body);
      } finally {
        reload();
      }
    },
    [project, design, reload],
  );

  return {
    comments,
    reload,
    add: (oid: string, text: string) => change("POST", undefined, { oid, text }),
    setStatus: (id: string, status: "open" | "done") => change("PATCH", id, { status }),
    edit: (id: string, text: string) => change("PATCH", id, { text }),
    remove: (id: string) => change("DELETE", id),
  };
}
