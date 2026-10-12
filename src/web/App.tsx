import { useCallback, useEffect, useState } from "react";
import { getJSON, type AppConfig, type Harnesses, type Load, type ProjectSummary } from "./api.ts";
import { Canvas } from "./components/Canvas.tsx";
import { ChatPanel, type Selection } from "./components/ChatPanel.tsx";
import { Sidebar, type Active } from "./components/Sidebar.tsx";
import { TopBar } from "./components/TopBar.tsx";

function useLoad<T>(url: string): [Load<T>, () => void] {
  const [load, setLoad] = useState<Load<T>>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setLoad({ state: "loading" });
    getJSON<T>(url)
      .then((data) => live && setLoad({ state: "ready", data }))
      .catch((e: unknown) => live && setLoad({ state: "error", message: e instanceof Error ? e.message : String(e) }));
    return () => { live = false; };
  }, [url, attempt]);
  return [load, () => setAttempt((n) => n + 1)];
}

export function App() {
  const [projects, retryProjects] = useLoad<ProjectSummary[]>("/api/projects");
  const [config] = useLoad<AppConfig>("/api/config");
  const [harnesses] = useLoad<Harnesses>("/api/harnesses");
  const [active, setActive] = useState<Active | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);

  // Open the first design when the project list arrives. #12 adds "reopen the last design".
  useEffect(() => {
    if (active || projects.state !== "ready") return;
    const first = projects.data.find((p) => p.designs.length > 0);
    if (first) setActive({ project: first.id, design: first.designs[0]! });
  }, [projects, active]);

  const open = useCallback((a: Active) => {
    setActive(a);
    setSelection(null);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !(e.target instanceof HTMLTextAreaElement)) setSelection(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const projectName =
    active && projects.state === "ready" ? (projects.data.find((p) => p.id === active.project)?.name ?? active.project) : null;

  return (
    <div className="app">
      <TopBar project={projectName} design={active?.design ?? null} config={config} harnesses={harnesses} />
      <Sidebar
        projects={projects}
        active={active}
        workspace={config.state === "ready" ? config.data.workspace : null}
        onOpen={open}
        onRetry={retryProjects}
      />
      <ChatPanel
        selection={selection}
        model={config.state === "ready" ? config.data.models.generate.model : null}
        disabled={!active}
        onClearSelection={() => setSelection(null)}
      />
      <Canvas active={active} selection={selection} onSelect={setSelection} />
    </div>
  );
}
