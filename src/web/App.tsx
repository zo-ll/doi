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
import { ChatPanel, type AppliedComment, type Selection } from "./components/ChatPanel.tsx";
import { CommentsPanel } from "./components/CommentsPanel.tsx";
import { Confirm } from "./components/Confirm.tsx";
import { HistoryPanel } from "./components/HistoryPanel.tsx";
import { DesignSystemDialog } from "./components/DesignSystemDialog.tsx";
import { ExportDialog } from "./components/ExportDialog.tsx";
import { HandoffDialog } from "./components/HandoffDialog.tsx";
import { SettingsDialog } from "./components/SettingsDialog.tsx";
import { UsageDialog } from "./components/UsageDialog.tsx";
import { TweaksPanel } from "./components/TweaksPanel.tsx";
import { RepoDialog } from "./components/RepoDialog.tsx";
import { ExportArchiveDialog, ImportArchiveDialog } from "./components/ArchiveDialogs.tsx";
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
  const [theme, toggleTheme, themeChoice, chooseTheme] = useTheme();
  const [projects, retryProjects] = useLoad<ProjectSummary[]>("/api/projects");
  const [config, retryConfig] = useLoad<AppConfig>("/api/config");
  const [providers, retryProviders] = useLoad<ProviderStatus[]>("/api/providers");
  const [workspace, retryWorkspace] = useLoad<WorkspaceState>("/api/workspace");
  const [active, setActive] = useState<Active | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const clearSelection = useCallback(() => setSelection(null), []);
  const [navOpen, setNavOpen] = useState(false);
  const [panels, setPanels] = useState<Panels>(() => read(PANELS, isPanels) ?? { chat: true, side: true });
  const [sideTab, setSideTab] = useState<"comments" | "history">("comments");
  const [dsOpen, setDsOpen] = useState(false);
  const [repoOpen, setRepoOpen] = useState(false);
  /** The export dialog for one project or the workspace (#114). */
  const [archive, setArchive] = useState<null | { kind: "project"; project: string } | { kind: "workspace" }>(null);
  const [importFile, setImportFile] = useState<File | null>(null);
  const importInput = useRef<HTMLInputElement>(null);
  /** The open Export dialog and its first choice: "Hand off" opens it at the agent prompt. */
  const [exportOpen, setExportOpen] = useState<null | "file" | "handoff">(null);
  /** Comments the user marked "apply": they go with the next turn. */
  const [applied, setApplied] = useState<AppliedComment[]>([]);
  const [running, setRunning] = useState(false);
  /** The restore question for the previewed version is open. */
  const [askRestore, setAskRestore] = useState(false);
  /** Bumped to open the new-comment form (N, or the Comment tool). */
  const [newComment, setNewComment] = useState(0);
  const [tweaksOpen, setTweaksOpen] = useState(false);
  /** Live tweak values, by CSS variable; they show in the frames until saved or reset. */
  const [liveVars, setLiveVars] = useState<Record<string, string>>({});
  /** A short message at the bottom left of the canvas. */
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(t);
  }, [toast]);
  /** A full screen over the app: settings or usage. */
  const [screen, setScreen] = useState<null | "settings" | "usage">(null);
  const [page, setPage] = useState("index.html");
  // Bumped when the files of the open design change; the canvas reloads its frames.
  const [revision, setRevision] = useState(0);
  const activeRef = useRef(active);
  activeRef.current = active;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const showSideRef = useRef<(tab: "comments" | "history") => void>(() => {});

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
    setApplied([]); // applied comments belong to the design they were made on
    setLiveVars({});
    setPage("index.html");
    write(LAST_DESIGN, a);
  }, []);

  /** Projects deleted in this session: the old list can still name them until it loads again. */
  const deleted = useRef(new Set<string>());
  // When the project list arrives, open the last design again, or else the first one.
  useEffect(() => {
    if (projects.state !== "ready") return;
    // A list without the project is the new one: the guard is done (the id can come back later).
    for (const id of deleted.current) if (!projects.data.some((p) => p.id === id)) deleted.current.delete(id);
    if (active) return;
    const list = projects.data.filter((p) => !deleted.current.has(p.id));
    const last = read(LAST_DESIGN, isActive);
    const exists = (a: Active) => list.some((p) => p.id === a.project && p.designs.includes(a.design));
    if (last && exists(last)) return open(last);
    const first = list.find((p) => p.designs.length > 0);
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
  // A comment that a turn marked done, or that someone deleted, leaves the next turn.
  useEffect(() => {
    if (comments.comments.state !== "ready") return;
    const open = new Set(comments.comments.data.filter((c) => c.status === "open" && !c.detached).map((c) => c.id));
    setApplied((now) => (now.every((c) => open.has(c.id)) ? now : now.filter((c) => open.has(c.id))));
  }, [comments.comments]);
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

  const tasks = config.state === "ready" ? taskStatuses(config.data.models, providers.state === "ready" ? providers.data : null) : [];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Chrome sends a keydown without a key when the user picks a datalist or autofill entry.
      if (typeof e.key !== "string") return;
      const mod = e.metaKey || e.ctrlKey;
      if (e.key === "Escape" && !(e.target instanceof HTMLTextAreaElement)) {
        setSelection(null);
        if (!document.querySelector('[aria-modal="true"]')) closePreview.current();
      }
      const key = e.key.toLowerCase();
      if (!mod && !e.altKey && key === "t" && !typing(e) && activeRef.current && !document.querySelector('[aria-modal="true"]')) {
        e.preventDefault();
        setTweaksOpen((o) => !o);
        return;
      }
      if (!mod && !e.altKey && key === "n" && !typing(e) && selectionRef.current) {
        e.preventDefault();
        showSideRef.current("comments");
        setNewComment((k) => k + 1);
        return;
      }
      if (!mod) return;
      const act: Record<string, () => void> = {
        p: toggleNav,
        "[": () => togglePanel("chat"),
        "]": () => togglePanel("side"),
        d: () => activeProject && setDsOpen(true),
        e: () => active && setExportOpen("file"),
        ",": () => setScreen("settings"),
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
  showSideRef.current = showSide;

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
        repo={activeProject ? (activeProject.repo?.name ?? null) : undefined}
        onRepo={() => setRepoOpen(true)}
        tweaksOpen={tweaksOpen}
        onTweaks={active ? () => setTweaksOpen((o) => !o) : undefined}
        onExport={active ? () => setExportOpen("file") : undefined}
        onHandoff={active ? () => setExportOpen("handoff") : undefined}
        tasks={tasks}
        onUsage={() => setScreen("usage")}
        onSettings={() => setScreen("settings")}
        theme={theme}
        onTheme={toggleTheme}
      />
      {exportOpen === "file" && active && <ExportDialog project={active.project} design={active.design} onClose={() => setExportOpen(null)} />}
      {exportOpen === "handoff" && active && (
        <HandoffDialog
          project={active.project}
          design={active.design}
          version={versionCount}
          pages={pages.state === "ready" ? pages.data.length : 1}
          openComments={openComments}
          hasDesignSystem={!!dsName}
          onClose={() => setExportOpen(null)}
        />
      )}
      <input
        ref={importInput}
        type="file"
        accept=".zip,application/zip"
        className="visually-hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) {
            setScreen(null); // the import dialog must not open under Settings
            setImportFile(f);
          }
        }}
      />
      {archive && (
        <ExportArchiveDialog
          kind={archive.kind}
          project={archive.kind === "project" ? archive.project : undefined}
          projectName={archive.kind === "project" ? projects.state === "ready" ? projects.data.find((p) => p.id === archive.project)?.name : undefined : undefined}
          ui={{ theme: themeChoice, panels, lastDesign: active }}
          onClose={() => setArchive(null)}
        />
      )}
      {importFile && (
        <ImportArchiveDialog
          file={importFile}
          onClose={() => setImportFile(null)}
          onImported={(r, ui) => {
            setImportFile(null);
            setScreen(null);
            setNavOpen(false);
            if (r.settingsApplied) retryConfig();
            if (ui) {
              chooseTheme(ui.theme);
              if (ui.panels) {
                setPanels(ui.panels);
                write(PANELS, ui.panels);
              }
            }
            // Open the imported design: its last design when the preferences came along, else the first one.
            const to = (id: string) => r.projects.find((p) => p.from === id)?.to;
            const last = ui?.lastDesign && to(ui.lastDesign.project) ? { project: to(ui.lastDesign.project)!, design: ui.lastDesign.design } : null;
            const first = r.manifest.projects.find((p) => p.designs.length);
            const next = last ?? (first ? { project: to(first.id)!, design: first.designs[0]! } : null);
            if (next) open(next);
            retryProjects();
            retryWorkspace();
            setToast(`Imported ${r.projects.length === 1 ? r.projects[0]!.name : `${r.projects.length} projects`}${r.history ? " with history" : ""}${r.settingsError ? `. Settings not applied: ${r.settingsError}` : ""}`);
          }}
        />
      )}
      {repoOpen && activeProject && <RepoDialog project={activeProject} onChanged={retryProjects} onClose={() => setRepoOpen(false)} />}
      {dsOpen && activeProject && (
        <DesignSystemDialog
          project={activeProject}
          projects={projects.state === "ready" ? projects.data : []}
          extract={tasks.find((t) => t.task === "extract") ?? null}
          editorUrl={config.state === "ready" ? config.data.editorUrl : "vscode://file{path}"}
          onClose={() => setDsOpen(false)}
          onChanged={retryProjects}
        />
      )}

      {askRestore && history.preview && versionList && (
        <Confirm
          title={`Restore ${previewLabel.split(" · ")[0]}?`}
          body={`doi creates v${versionList.length + 1} with the files from ${previewLabel.split(" · ")[0]}. v${versionList.length} and all earlier versions stay in the history. Comments do not change.`}
          action={`Restore ${previewLabel.split(" · ")[0]}`}
          busy={history.busy}
          error={history.error}
          onCancel={() => setAskRestore(false)}
          onConfirm={() => {
            history.restore().then(
              () => setAskRestore(false),
              () => {}, // the dialog shows the error
            );
          }}
        />
      )}

      {screen === "settings" && config.state === "ready" && (
        <SettingsDialog
          config={config.data}
          providers={providers}
          workspace={workspace}
          themeChoice={themeChoice}
          onTheme={chooseTheme}
          onRecheck={retryProviders}
          onSaved={retryConfig}
          onClose={() => setScreen(null)}
          onExportWorkspace={() => {
            setScreen(null);
            setArchive({ kind: "workspace" });
          }}
          onImport={() => importInput.current?.click()}
        />
      )}
      {screen === "usage" && config.state === "ready" && (
        <UsageDialog config={config.data} providers={providers} projects={projects.state === "ready" ? projects.data : []} onClose={() => setScreen(null)} />
      )}

      <div className="app-body">
        {panels.chat && (
          <aside className="chat-pane" aria-label="Chat">
            <ChatPanel
              key={active ? `${active.project}/${active.design}/${chatEpoch}` : ""}
              target={active}
              selection={selection}
              tasks={tasks}
              onClearSelection={clearSelection}
              applied={applied}
              onUnapply={(id) => setApplied((list) => list.filter((c) => c.id !== id))}
              onAppliedSent={() => setApplied([])}
              onRunningChange={setRunning}
              onCommentsChanged={comments.reload}
              variantsOpen={variants.set !== null}
              onVariantsChanged={variants.reload}
              onDiscardVariants={() => {
                variants.discard().catch(() => {});
              }}
              onCollapse={() => togglePanel("chat")}
              repo={activeProject?.repo?.name ?? null}
              onOpenSettings={() => setScreen("settings")}
            />
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
            onDeleted={(project) => {
              deleted.current.add(project);
              // The open design went with its project: the app opens the first design left.
              if (active?.project === project) setActive(null);
              onProjectsChanged();
            }}
            onClose={() => setNavOpen(false)}
            onExport={(project) => {
              setNavOpen(false);
              setArchive({ kind: "project", project });
            }}
            onImport={() => {
              setNavOpen(false);
              importInput.current?.click();
            }}
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
          onRestorePreview={() => setAskRestore(true)}
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
          onComment={() => {
            showSide("comments");
            setNewComment((k) => k + 1);
          }}
          onOpenHistory={() => showSide("history")}
          liveVars={liveVars}
          overlay={
            <>
              {tweaksOpen && active && !variants.set && (
                <TweaksPanel
                  active={active}
                  revision={revision}
                  values={liveVars}
                  onChange={setLiveVars}
                  onSaved={(commit, commitError) => {
                    setLiveVars({});
                    setToast(
                      commitError
                        ? `Saved to styles.css, but no version was made: ${commitError}`
                        : commit
                          ? `Design updated · v${(versionCount ?? 0) + 1}`
                          : "Saved to styles.css. Nothing changed.",
                    );
                  }}
                  onClose={() => setTweaksOpen(false)}
                />
              )}
              {toast && (
                <div className="toast" role="status">
                  <span className="dot dot-accent" />
                  {toast}
                </div>
              )}
            </>
          }
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
                  onRestore={() => setAskRestore(true)}
                  busy={history.busy}
                  onReopen={(v) => {
                    history.reopenVariants(v).then(
                      () => {
                        history.setPreview(null);
                        variants.reload();
                        setToast("The variants are back. Pick one on the canvas.");
                      },
                      (e: Error) => setToast(e.message),
                    );
                  }}
                  onRetry={history.reload}
                />
              )}
              {sideTab === "comments" && (
                <CommentsPanel
                  comments={active ? comments.comments : { state: "ready", data: [] }}
                  selection={selection}
                  newKey={newComment}
                  applied={applied.map((c) => c.id)}
                  onSelect={(oid) => setSelection({ oid })}
                  onAdd={comments.add}
                  onEdit={comments.edit}
                  onStatus={comments.setStatus}
                  onRemove={comments.remove}
                  onRetry={comments.reload}
                  onToggleApply={(c, n) => {
                    setApplied((now) =>
                      now.some((x) => x.id === c.id) ? now.filter((x) => x.id !== c.id) : [...now, { id: c.id, oid: c.oid, text: c.text, n }],
                    );
                    if (!panels.chat) togglePanel("chat"); // the chips show in the composer
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
