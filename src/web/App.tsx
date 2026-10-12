import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getJSON, type AppConfig, type Harnesses, type Load, type ProjectSummary, type ProviderStatus } from "./api.ts";
import { Canvas } from "./components/Canvas.tsx";
import { ChatPanel, type CommentRequest, type Selection } from "./components/ChatPanel.tsx";
import { CommentsPanel } from "./components/CommentsPanel.tsx";
import { pinsOf, useComments } from "./comments.ts";
import { Sidebar, type Active } from "./components/Sidebar.tsx";
import { TopBar } from "./components/TopBar.tsx";

const LAST_DESIGN = "doi:last-design";

// Storage can be off (private window, blocked site data); then the app just opens the first design.
function loadLast(): Active | null {
  try {
    const v = JSON.parse(localStorage.getItem(LAST_DESIGN) ?? "null");
    return typeof v?.project === "string" && typeof v?.design === "string" ? v : null;
  } catch {
    return null;
  }
}
function saveLast(a: Active): void {
  try {
    localStorage.setItem(LAST_DESIGN, JSON.stringify(a));
  } catch {
    // ignore
  }
}

function useLoad<T>(url: string): [Load<T>, () => void] {
  const [load, setLoad] = useState<Load<T>>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    // A reload keeps the old data on screen until the new data arrives.
    setLoad((l) => (l.state === "ready" ? l : { state: "loading" }));
    getJSON<T>(url)
      .then((data) => live && setLoad({ state: "ready", data }))
      .catch((e: unknown) => live && setLoad({ state: "error", message: e instanceof Error ? e.message : String(e) }));
    return () => { live = false; };
  }, [url, attempt]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return [load, retry];
}

export function App() {
  const [projects, retryProjects] = useLoad<ProjectSummary[]>("/api/projects");
  const [config] = useLoad<AppConfig>("/api/config");
  const [harnesses] = useLoad<Harnesses>("/api/harnesses");
  const [providers] = useLoad<ProviderStatus[]>("/api/providers");
  const [active, setActive] = useState<Active | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const clearSelection = useCallback(() => setSelection(null), []);
  const [tab, setTab] = useState<"chat" | "comments">("chat");
  const [request, setRequest] = useState<CommentRequest | null>(null);
  const [running, setRunning] = useState(false);
  const requestKey = useRef(0);
  // Bumped when the files of the open design change; the canvas reloads its frames.
  const [revision, setRevision] = useState(0);
  const activeRef = useRef(active);
  activeRef.current = active;
  useEffect(() => {
    // EventSource connects again by itself after an error.
    const events = new EventSource("/api/events");
    events.addEventListener("design-changed", (e) => {
      const change = JSON.parse((e as MessageEvent<string>).data) as { project: string; design: string };
      const a = activeRef.current;
      if (a?.project !== change.project || a.design !== change.design) return;
      setRevision((n) => n + 1);
      setSelection(null); // the old rect may not match the new layout
    });
    return () => events.close();
  }, []);

  const open = useCallback((a: Active) => {
    setActive(a);
    setSelection(null);
    setRequest(null); // a request belongs to the design it was made on
    saveLast(a);
  }, []);

  // When the project list arrives, open the last design again, or else the first one.
  useEffect(() => {
    if (active || projects.state !== "ready") return;
    const last = loadLast();
    const exists = (a: Active) => projects.data.some((p) => p.id === a.project && p.designs.includes(a.design));
    if (last && exists(last)) return open(last);
    const first = projects.data.find((p) => p.designs.length > 0);
    if (first) open({ project: first.id, design: first.designs[0]! });
  }, [projects, active, open]);

  // Open a new or renamed design at once: the old one may be gone. The list catches up.
  const onProjectsChanged = useCallback((next?: Active) => {
    if (next) open(next);
    retryProjects();
  }, [open, retryProjects]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !(e.target instanceof HTMLTextAreaElement)) setSelection(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const comments = useComments(active, revision);
  const commentList = comments.comments.state === "ready" ? comments.comments.data : [];
  const pins = useMemo(() => pinsOf(commentList), [commentList]);
  const openComments = commentList.filter((c) => c.status === "open").length;

  const generate = config.state === "ready" ? config.data.models.generate : null;
  const generateStatus =
    generate && providers.state === "ready" ? (providers.data.find((p) => p.id === generate.provider) ?? null) : null;

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
        onChanged={onProjectsChanged}
      />
      <section className="side-panel" aria-label="Chat and comments">
        <div className="panel-header panel-tabs" role="tablist">
          <button className="panel-tab" role="tab" aria-selected={tab === "chat"} onClick={() => setTab("chat")}>
            Chat
          </button>
          <button
            className="panel-tab"
            role="tab"
            aria-selected={tab === "comments"}
            onClick={() => {
              setTab("comments");
              comments.reload(); // another window may have changed them
            }}
          >
            Comments
            {openComments > 0 && <span className="tab-count" aria-label={`${openComments} open`}>{openComments}</span>}
          </button>
        </div>
        <ChatPanel
          key={active ? `${active.project}/${active.design}` : ""}
          target={active}
          selection={selection}
          model={generate?.model ?? null}
          modelStatus={generateStatus}
          onClearSelection={clearSelection}
          hidden={tab !== "chat"}
          request={request}
          onRequestTaken={() => setRequest(null)}
          onRunningChange={setRunning}
          onCommentsChanged={comments.reload}
        />
        {tab === "comments" && (
          <CommentsPanel
            comments={active ? comments.comments : { state: "ready", data: [] }}
            selection={selection}
            onSelect={(oid) => setSelection({ oid })}
            onAdd={comments.add}
            onStatus={comments.setStatus}
            onRemove={comments.remove}
            onRetry={comments.reload}
            running={running}
            onApply={(list) => {
              setRequest({ key: ++requestKey.current, comments: list.map(({ id, oid, text }) => ({ id, oid, text })) });
              setTab("chat"); // the answer streams there
            }}
          />
        )}
      </section>
      <Canvas
        active={active}
        revision={revision}
        selection={selection}
        pins={pins}
        onSelect={setSelection}
        onClear={clearSelection}
        onPin={(oid) => {
          setSelection({ oid });
          setTab("comments");
        }}
      />
    </div>
  );
}
