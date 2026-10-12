import { useCallback, useEffect, useState } from "react";
import { getJSON, historyUrl, sendJSON, type Load, type VersionView } from "./api.ts";
import type { Active } from "./components/Sidebar.tsx";

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

  return {
    versions,
    preview,
    busy,
    error,
    reload,
    setPreview: (v: VersionView | null) => {
      setError(null);
      setPreview(v);
    },
    restore,
  };
}
