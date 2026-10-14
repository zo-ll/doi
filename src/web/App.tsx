import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getJSON,
  type Active,
  type AppConfig,
  type DesignSystemView,
  type Load,
  type ProjectSummary,
  type ProviderStatus,
} from "./api.ts";
import { Canvas } from "./components/Canvas.tsx";
import { ChatPanel, type CommentRequest, type Selection } from "./components/ChatPanel.tsx";
import { CommentsPanel } from "./components/CommentsPanel.tsx";
import { HistoryPanel } from "./components/HistoryPanel.tsx";
import { DesignSystemDialog } from "./components/DesignSystemDialog.tsx";
import { ExportDialog } from "./components/ExportDialog.tsx";
import { ProjectsNav, type WorkspaceState } from "./components/ProjectsNav.tsx";
import { MOD, TopBar, type DesignSystemChip } from "./components/TopBar.tsx";
import { useHistory } from "./history.ts";
import { pinsOf, useComments } from "./comments.ts";
import { taskStatuses } from "./providers.ts";
import { useTheme } from "./theme.ts";
import { useVariants } from "./variants.ts";

const LAST_DESIGN = "doi:last-design";
const PANELS = "doi:panels";

// Storage can be off (private window, blocked site data); then the app uses its defaults.
function read<T>(key: string, check: (v: unknown) => v is T): T | null {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
    return check(v) ? v : null;
  } catch {
    return null;
  }
}
function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore
  }
}
const isActive = (v: unknown): v is Active =>
  typeof (v as Active)?.project === "string" && typeof (v as Active)?.design === "string";
type Panels = { chat: boolean; side: boolean };
const isPanels = (v: unknown): v is Panels => typeof (v as Panels)?.chat === "boolean" && typeof (v as Panels)?.side === "boolean";

function useLoad<T>(url: string | null): [Load<T>, () => void] {
  const [load, setLoad] = useState<Load<T>>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!url) return;
    let live = true;
    // A reload keeps the old data on screen until the new data arrives.
    setLoad((l) => (l.state === "ready" ? l : { state: "loading" }));
    getJSON<T>(url)
      .then((data) => live && setLoad({ state: "ready", data }))
      .catch((e: unknown) => live && setLoad({ state: "error", message: e instanceof Error ? e.message : String(e) }));
    return () => {
      live = false;
    };
  }, [url, attempt]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return [load, retry];
}

/** True when a key press goes to a text field, so single-key shortcuts must not fire. */
export function typing(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));
}

export function App() {
  const [theme, toggleTheme] = useTheme();
  const [projects, retryProjects] = useLoad<ProjectSummary[]>("/api/projects");
  const [config] = useLoad<AppConfig>("/api/config");
  const [providers] = useLoad<ProviderStatus[]>("/api/providers");
  const [workspace, retryWorkspace] = useLoad<WorkspaceState>("/api/workspace");
  const [active, setActive] = useState<Active | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const clearSelection = useCallback(() => setSelection(null), []);
  const [navOpen, setNavOpen] = useState(false);
  const [panels, setPanels] = useState<Panels>(() => read(PANELS, isPanels) ?? { chat: true, side: true });
  const [sideTab, setSideTab] = useState<"comments" | "history">("comments");
  const [dsOpen, setDsOpen] = useState(false);
  /** The open Export dialog and its first choice: "Hand off" opens it at the agent prompt. */
  const [exportOpen, setExportOpen] = useState<null | "file" | "handoff">(null);
  const [request, setRequest] = useState<CommentRequest | null>(null);
  const [running, setRunning] = useState(false);
  const [page, setPage] = useState("index.html");
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
    setPage("index.html");
    write(LAST_DESIGN, a);
  }, []);

  // When the project list arrives, open the last design again, or else the first one.
  useEffect(() => {
    if (active || projects.state !== "ready") return;
    const last = read(LAST_DESIGN, isActive);
    const exists = (a: Active) => projects.data.some((p) => p.id === a.project && p.designs.includes(a.design));
    if (last && exists(last)) return open(last);
    const first = projects.data.find((p) => p.designs.length > 0);
    if (first) open({ project: first.id, design: first.designs[0]! });
  }, [projects, active, open]);

  // Open a new or renamed design at once: the old one may be gone. The list catches up.
  const onProjectsChanged = useCallback(
    (next?: Active) => {
      if (next) open(next);
      retryProjects();
      retryWorkspace();
    },
    [open, retryProjects, retryWorkspace],
  );

  // The preview lives in the history hook below; Esc reads the latest close through a ref.
  const closePreview = useRef<() => void>(() => {});
  const togglePanel = useCallback((key: keyof Panels) => {
    setPanels((p) => {
      const next = { ...p, [key]: !p[key] };
      write(PANELS, next);
      return next;
    });
  }, []);
  const toggleNav = useCallback(() => {
    setNavOpen((o) => {
      if (!o) retryWorkspace(); // the git state may have changed since
      return !o;
    });
  }, [retryWorkspace]);

  const comments = useComments(active, revision);
  const variants = useVariants(active);
  const history = useHistory(active, revision);
  // Bumped after a pick: the chat loads again and shows the picked answer.
  const [chatEpoch, setChatEpoch] = useState(0);
  const commentList = comments.comments.state === "ready" ? comments.comments.data : [];
  const pins = useMemo(() => pinsOf(commentList), [commentList]);
  const openComments = commentList.filter((c) => c.status === "open").length;

  const [pages] = useLoad<string[]>(active ? `/api/projects/${active.project}/designs/${active.design}/pages?r=${revision}` : null);
  const activeProject = active && projects.state === "ready" ? (projects.data.find((p) => p.id === active.project) ?? null) : null;
  const projectName = active ? (activeProject?.name ?? active.project) : null;
  const dsName = activeProject?.designSystem ?? null;
  const [ds] = useLoad<DesignSystemView>(dsName ? `/api/design-systems/${dsName}` : null);
  const dsChip: DesignSystemChip | null | undefined = !activeProject
    ? undefined
    : !dsName
      ? null
      : {
          name: dsName,
          swatches: ds.state === "ready" ? ds.data.tokens.filter((t) => t.group === "color").slice(0, 3).map((t) => t.resolved) : [],
        };

  const generate = config.state === "ready" ? config.data.models.generate : null;
  const modelChoices =
    config.state === "ready" ? [...new Set(Object.values(config.data.models).map((m) => `${m.provider}:${m.model}`))] : [];
  const generateStatus =
    generate && providers.state === "ready" ? (providers.data.find((p) => p.id === generate.provider) ?? null) : null;
  const tasks = config.state === "ready" ? taskStatuses(config.data.models, providers.state === "ready" ? providers.data : null) : [];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (e.key === "Escape" && !(e.target instanceof HTMLTextAreaElement)) {
        setSelection(null);
        if (!document.querySelector('[aria-modal="true"]')) closePreview.current();
      }
      if (!mod) return;
      const key = e.key.toLowerCase();
      const act: Record<string, () => void> = {
        p: toggleNav,
        "[": () => togglePanel("chat"),
        "]": () => togglePanel("side"),
        d: () => activeProject && setDsOpen(true),
        e: () => active && setExportOpen("file"),
      };
      if (e.shiftKey && key === "h") act.h = () => active && setExportOpen("handoff");
      const run = act[key];
      if (run) {
        e.preventDefault();
        run();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleNav, togglePanel, activeProject, active]);

  closePreview.current = () => history.preview && history.setPreview(null);
  const versionList = history.versions.state === "ready" ? history.versions.data : null;
  const versionCount = versionList ? versionList.length : null;
  // Versions are numbered from the oldest (v1); the list comes newest first.
  const previewIndex = history.preview && versionList ? versionList.findIndex((v) => v.sha === history.preview!.sha) : -1;
  const previewLabel =
    history.preview && versionList && previewIndex >= 0
      ? `v${versionList.length - previewIndex} · ${new Date(history.preview.at).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`
      : "an old version";
  const showSide = useCallback(
    (tab: "comments" | "history") => {
      setSideTab(tab);
      if (!panels.side) togglePanel("side");
    },
    [panels.side, togglePanel],
  );

  return (
    <div className="app">
      <TopBar
        projectName={projectName}
        design={active?.design ?? null}
        isDeck={!!(active && activeProject?.decks.includes(active.design))}
        pages={pages.state === "ready" ? pages.data : [page]}
        page={page}
        onPage={setPage}
        version={versionCount}
        busy={running}
        navOpen={navOpen}
        onNav={toggleNav}
        designSystem={dsChip}
        onDesignSystem={() => setDsOpen(true)}
        tweaksOpen={false}
        onExport={active ? () => setExportOpen("file") : undefined}
        onHandoff={active ? () => setExportOpen("handoff") : undefined}
        tasks={tasks}
        onUsage={() => {}}
        onSettings={() => {}}
        theme={theme}
        onTheme={toggleTheme}
      />
      {exportOpen && active && (
        <ExportDialog
          project={active.project}
          design={active.design}
          initial={exportOpen === "handoff" ? "prompt" : "folder"}
          onClose={() => setExportOpen(null)}
        />
      )}
      {dsOpen && activeProject && (
        <DesignSystemDialog
          project={activeProject}
          editorUrl={config.state === "ready" ? config.data.editorUrl : "vscode://file{path}"}
          onClose={() => setDsOpen(false)}
          onChanged={retryProjects}
        />
      )}

      <div className="app-body">
        {panels.chat && (
          <aside className="chat-pane" aria-label="Chat">
            <div className="panel-header">
              <span className="panel-title">Chat</span>
              <span className="spacer" />
              <button className="collapse-btn" onClick={() => togglePanel("chat")} title={`Collapse chat (${MOD}[)`} aria-label="Collapse chat">
                {MOD}[
              </button>
            </div>
            <div className="pane-body">
              <ChatPanel
                key={active ? `${active.project}/${active.design}/${chatEpoch}` : ""}
                target={active}
                selection={selection}
                model={generate?.model ?? null}
                modelStatus={generateStatus}
                onClearSelection={clearSelection}
                request={request}
                onRequestTaken={() => setRequest(null)}
                onRunningChange={setRunning}
                onCommentsChanged={comments.reload}
                modelRef={generate ? `${generate.provider}:${generate.model}` : null}
                models={modelChoices}
                variantsOpen={variants.set !== null}
                onVariantsChanged={variants.reload}
              />
            </div>
          </aside>
        )}

        {navOpen && (
          <ProjectsNav
            projects={projects}
            active={active}
            workspace={workspace}
            onOpen={open}
            onRetry={retryProjects}
            onChanged={onProjectsChanged}
            onClose={() => setNavOpen(false)}
          />
        )}

        <Canvas
          active={active}
          page={page}
          revision={revision}
          selection={selection}
          pins={pins}
          onSelect={setSelection}
          onClear={clearSelection}
          preview={history.preview}
          previewBusy={history.busy}
          previewError={history.error}
          onRestorePreview={() => {
            history.restore().catch(() => {}); // the bar shows the error
          }}
          previewLabel={previewLabel}
          onClosePreview={() => history.setPreview(null)}
          variants={variants.set}
          variantsError={variants.error}
          onPickVariant={(n) => {
            variants.pick(n).then(() => setChatEpoch((e) => e + 1), () => {});
          }}
          onDiscardVariants={() => {
            variants.discard().catch(() => {});
          }}
          onPin={(oid) => {
            setSelection({ oid });
            showSide("comments");
          }}
          onComment={() => showSide("comments")}
          onOpenHistory={() => showSide("history")}
        />
        {!panels.chat && (
          <button className="btn btn-secondary reopen-btn reopen-chat" onClick={() => togglePanel("chat")} title={`Show chat (${MOD}[)`}>
            Chat
          </button>
        )}
        {!panels.side && (
          <button className="btn btn-secondary reopen-btn reopen-side" onClick={() => togglePanel("side")} title={`Show comments and history (${MOD}])`}>
            Comments · History
          </button>
        )}

        {panels.side && (
          <aside className="side-pane" aria-label="Comments and history">
            <div className="tabs" role="tablist">
              <button className="tab" role="tab" aria-selected={sideTab === "comments"} onClick={() => {
                setSideTab("comments");
                comments.reload(); // another window may have changed them
              }}>
                Comments
                {openComments > 0 && <span className="count" aria-label={`${openComments} open`}>{openComments}</span>}
              </button>
              <button className="tab" role="tab" aria-selected={sideTab === "history"} onClick={() => {
                setSideTab("history");
                history.reload();
              }}>
                History
              </button>
              <button className="collapse-btn" onClick={() => togglePanel("side")} title={`Collapse (${MOD}])`} aria-label="Collapse panel">
                {MOD}]
              </button>
            </div>
            <div className="pane-body">
              {sideTab === "history" && (
                <HistoryPanel
                  versions={active ? history.versions : { state: "ready", data: [] }}
                  preview={history.preview?.sha ?? null}
                  onPreview={history.setPreview}
                  onRetry={history.reload}
                />
              )}
              {sideTab === "comments" && (
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
                    if (!panels.chat) togglePanel("chat"); // the answer streams there
                  }}
                />
              )}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
