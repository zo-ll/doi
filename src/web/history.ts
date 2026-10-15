import { useCallback, useEffect, useState } from "react";
import { getJSON, historyUrl, sendJSON, type Load, type VersionView } from "./api.ts";
import type { Active } from "./api.ts";

/** The versions of the open design and the one in the preview frame. */
export function useHistory(active: Active | null, revision: number) {
  const [versions, setVersions] = useState<Load<VersionView[]>>({ state: "loading" });
  const [preview, setPreview] = useState<VersionView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);
  const project = active?.project;
  const design = active?.design;

  useEffect(() => {
    setVersions({ state: "loading" });
    setPreview(null);
    setError(null);
  }, [project, design]);

  // A turn makes a new version: the list loads again when the design files change.
  useEffect(() => {
    if (!project || !design) return;
    let live = true;
    getJSON<VersionView[]>(historyUrl(project, design))
      .then((data) => live && setVersions({ state: "ready", data }))
      .catch((e) => live && setVersions({ state: "error", message: (e as Error).message }));
    return () => {
      live = false;
    };
  }, [project, design, revision, reloads]);

  const reload = useCallback(() => setReloads((n) => n + 1), []);

  /** Restores the version in the preview as a new commit. Throws the server's message. */
  const restore = async () => {
    if (!project || !design || !preview) return;
    setBusy(true);
    setError(null);
    try {
      await sendJSON("POST", historyUrl(project, design, `/${preview.sha}/restore`));
      setPreview(null);
    } catch (e) {
      setError((e as Error).message);
      throw e;
    } finally {
      setBusy(false);
      reload();
    }
  };

  /** Brings back the variant set that a pick removed. Throws the server's message. */
  const reopenVariants = async (v: VersionView) => {
    if (!project || !design) return;
    setBusy(true);
    try {
      await sendJSON("POST", historyUrl(project, design, `/${v.sha}/reopen-variants`));
    } finally {
      setBusy(false);
      reload();
    }
  };

  return {
    versions,
    preview,
    busy,
    reopenVariants,
    error,
    reload,
    setPreview: (v: VersionView | null) => {
      setError(null);
      setPreview(v);
    },
    restore,
  };
}

export type VersionKind = "turn" | "pick" | "restore" | "rename" | "create" | "tweak";

/**
 * What made a version, from its commit message. Only the exact forms that doi writes count,
 * so a prompt that starts with "Restore " is still a turn.
 */
export function versionKind(message: string): VersionKind {
  if (/^Restore [0-9a-f]{7}: /.test(message)) return "restore";
  if (/^Pick variant \d+: /.test(message)) return "pick";
  if (/^Rename design [a-z0-9][a-z0-9-]* to [a-z0-9][a-z0-9-]*$/.test(message)) return "rename";
  if (/^Create design [a-z0-9][a-z0-9-]*$/.test(message)) return "create";
  if (/^Tweaks: --[A-Za-z0-9_-]+(, --[A-Za-z0-9_-]+)*$/.test(message)) return "tweak";
  return "turn";
}
