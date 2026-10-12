import { useCallback, useEffect, useState } from "react";
import { getJSON, sendJSON, variantsUrl, type VariantSetView } from "./api.ts";
import type { Active } from "./components/Sidebar.tsx";

/** The open variant set of the design, or null. `reload` loads it again. */
export function useVariants(active: Active | null) {
  const [set, setSet] = useState<VariantSetView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);
  const project = active?.project;
  const design = active?.design;

  useEffect(() => setSet(null), [project, design]);

  useEffect(() => {
    if (!project || !design) return;
    let live = true;
    getJSON<VariantSetView | null>(variantsUrl(project, design))
      .then((s) => live && setSet(s))
      .catch((e) => live && setError(`The variants cannot load: ${(e as Error).message}`));
    return () => {
      live = false;
    };
  }, [project, design, reloads]);

  const reload = useCallback(() => setReloads((n) => n + 1), []);

  /** Picks variant n, or discards the set. Throws the server's message. */
  const act = async (kind: "pick" | "discard", n?: number) => {
    if (!project || !design || !set) return;
    setError(null);
    try {
      if (kind === "pick") await sendJSON("POST", variantsUrl(project, design, `/${set.id}/pick`), { n });
      else await sendJSON("DELETE", variantsUrl(project, design, `/${set.id}`));
    } catch (e) {
      setError((e as Error).message);
      throw e;
    } finally {
      reload();
    }
  };

  return {
    set,
    error,
    reload,
    pick: (n: number) => act("pick", n),
    discard: () => act("discard"),
  };
}
