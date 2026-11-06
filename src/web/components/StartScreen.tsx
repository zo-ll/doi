import { useEffect, useState } from "react";
import { sendJSON, type Active } from "../api.ts";
import { modelChoices, useComposerImages } from "../composer.ts";
import { shortModel, type TaskStatus } from "../providers.ts";
import { projectNameFrom, START_KINDS, type StartKind } from "../start.ts";
import { IMAGE_LIMITS } from "../../workspace/image-limits.ts";
import type { FirstTurn } from "./ChatPanel.tsx";
import { ModelMenu, TONE_DOT } from "./ModelMenu.tsx";
import { RepoPicker, useGithub } from "./RepoPicker.tsx";
import { MOD } from "./TopBar.tsx";

/** Mounted only when the user opens the repo part, so a start without a repo never asks gh. */
function RepoChoice({ busy, onPick }: { busy: boolean; onPick: (name: string) => void }) {
  const github = useGithub();
  return <RepoPicker github={github} busy={busy} linked={null} onPick={onPick} />;
}

/**
 * The way into a new project: its kind, the first prompt and an optional repo. It creates the
 * project and hands the first message to the chat, which then runs it as a normal turn.
 */
export function StartScreen({ tasks, onStarted, onClose, onOpenSample, onImport, onOpenSettings }: {
  tasks: TaskStatus[];
  /** False when the app could not open the project: the user kept unsaved edits. */
  onStarted: (active: Active, first: FirstTurn) => boolean;
  /** Absent when nothing can open behind this screen. */
  onClose?: () => void;
  /** Absent when the workspace has no sample. */
  onOpenSample?: () => void;
  onImport: () => void;
  onOpenSettings: () => void;
}) {
  const [kind, setKind] = useState<StartKind>("page");
  const [draft, setDraft] = useState("");
  const { images, setImages, imageError, setImageError, addImages } = useComposerImages();
  const [chosen, setChosen] = useState<TaskStatus | null>(null);
  const [modelMenu, setModelMenu] = useState(false);
  const [repoOpen, setRepoOpen] = useState(false);
  const [repo, setRepo] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The project of a failed repo link or a refused discard: another try must not make a second one. */
  const [created, setCreated] = useState<Active | null>(null);

  const current = chosen ?? tasks.find((t) => t.task === "generate") ?? null;
  const choices = modelChoices(tasks);
  const imagesUnread = images.length > 0 && current?.vision === false;
  const visionChoice = choices.some((t) => t.tone === "ok" && t.vision === true);
  const modelProblem = current && (current.tone === "err" || current.tone === "warn") ? current : null;
  const canStart = draft.trim().length > 0 && !imagesUnread && !busy;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (modelMenu) setModelMenu(false);
      else if (!busy) onClose?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy, modelMenu]);

  const start = async (linkRepo: boolean) => {
    const text = draft.trim();
    if (!text || busy || imagesUnread) return;
    setError(null);
    try {
      let project = created;
      if (!project) {
        setBusy("Making the project…");
        const r = await sendJSON<{ id: string; design: string }>("POST", "/api/projects", { name: projectNameFrom(text), kind, free: true });
        project = { project: r.id, design: r.design };
        setCreated(project);
      }
      if (repo && linkRepo) {
        setBusy(`Cloning ${repo}…`);
        await sendJSON("PUT", `/api/projects/${project.project}/repo`, { name: repo });
      }
      if (!onStarted(project, { text, images, model: chosen })) setBusy(null);
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  };

  return (
    <div className="start-screen" role="dialog" aria-modal="true" aria-label="Start a new project">
      <div
        className="start-inner"
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && canStart) {
            e.preventDefault();
            void start(true);
          }
        }}
      >
        <div className="dialog-head">
          <h2>What do you want to make?</h2>
          <span className="spacer" />
          {onClose && (
            <button className="icon-btn" onClick={onClose} aria-label="Close" title="Close (Esc)" disabled={!!busy}>
              ×
            </button>
          )}
        </div>

        <div className="format-cards start-kinds" role="radiogroup" aria-label="Project kind">
          {START_KINDS.map((k) => (
            <button key={k.id} type="button" role="radio" aria-checked={kind === k.id} className="format-card" disabled={!!busy || !!created} onClick={() => setKind(k.id)}>
              <span className="format-title">{k.title}</span>
              <span className="format-sub">{k.sub}</span>
            </button>
          ))}
        </div>

        {created && (
          <p className="muted" role="status">
            The project is made, so its kind and name stay. Start goes on in this project. You can rename it in the drawer.
          </p>
        )}

        {modelProblem && (
          <div className="banner banner-warn" role="status">
            <span className="dot dot-warn" />
            <span className="spacer">
              {modelProblem.model}: {modelProblem.label.toLowerCase()}. {modelProblem.via}
            </span>
            <button className="btn btn-secondary btn-sm" onClick={() => setModelMenu(true)}>
              Use another model
            </button>
          </div>
        )}

        <div
          className="composer"
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes("Files")) e.preventDefault();
          }}
          onDrop={(e) => {
            const files = [...e.dataTransfer.files];
            if (!files.some((f) => f.type.startsWith("image/"))) return;
            e.preventDefault();
            void addImages(files);
          }}
        >
          {images.length > 0 && (
            <div className="composer-chips">
              {images.map((img, i) => (
                <span key={i} className="composer-thumb" title={`Image ${i + 1}`}>
                  <img src={img.url} alt={`Image ${i + 1} to send`} />
                  <button aria-label={`Remove image ${i + 1}`} onClick={() => setImages((list) => list.filter((_, j) => j !== i))}>
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          {imageError && (
            <p className="field-error composer-error" role="alert">
              {imageError}
            </p>
          )}
          {imagesUnread && current && (
            <p className="field-error composer-error" role="alert">
              {shortModel(current.model)} cannot read images. Remove the images, or pick a model with vision.{" "}
              {visionChoice && (
                <button className="link-btn" onClick={() => setModelMenu(true)}>
                  Pick a model
                </button>
              )}
            </p>
          )}
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onPaste={(e) => {
              const files = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));
              if (files.length) {
                e.preventDefault();
                void addImages(files);
              }
            }}
            placeholder={START_KINDS.find((k) => k.id === kind)!.placeholder}
            rows={4}
            disabled={!!busy}
            aria-label="First prompt"
          />
          <div className="composer-actions">
            <label className={`btn btn-ghost btn-md${busy || images.length >= IMAGE_LIMITS.count ? " is-disabled" : ""}`}>
              Attach
              <input
                type="file"
                className="visually-hidden"
                accept="image/png,image/jpeg,image/webp,image/gif"
                multiple
                disabled={!!busy || images.length >= IMAGE_LIMITS.count}
                onChange={(e) => {
                  void addImages([...(e.target.files ?? [])]);
                  e.target.value = "";
                }}
              />
            </label>
            <span className="spacer" />
            {current && (
              <button className={`model-chip${chosen ? " is-chosen" : ""}`} onClick={() => setModelMenu((o) => !o)} aria-expanded={modelMenu} title={`${current.provider}:${current.model}`}>
                <span className={`dot ${TONE_DOT[current.tone]}`} />
                <span className="truncate">{shortModel(current.model)}</span>
              </button>
            )}
            <button className="btn btn-primary btn-md" onClick={() => void start(true)} disabled={!canStart} title={`Start (${MOD}↵)`}>
              Start
            </button>
          </div>
          {modelMenu && (
            <ModelMenu
              choices={choices}
              chosen={chosen}
              onChoose={(t) => {
                setChosen(t);
                setImageError(null);
                setModelMenu(false);
              }}
              onClose={() => setModelMenu(false)}
              onOpenSettings={onOpenSettings}
            />
          )}
        </div>

        {busy && (
          <div className="export-progress" role="status">
            <span className="spinner" />
            {busy}
          </div>
        )}
        {error && (
          <div className="banner banner-err" role="alert">
            <span className="dot dot-err" />
            <span className="spacer">{error}</span>
            {repo && created && (
              <button className="btn btn-secondary btn-sm" onClick={() => void start(false)}>
                Start without the repo
              </button>
            )}
          </div>
        )}

        <div className="start-repo">
          {repo ? (
            <div className="repo-linked">
              <span className="dot dot-ok" />
              <strong className="mono spacer truncate">{repo}</strong>
              <button className="btn btn-ghost btn-md" disabled={!!busy} onClick={() => setRepo(null)}>
                Remove
              </button>
            </div>
          ) : repoOpen ? (
            <RepoChoice
              busy={!!busy}
              onPick={(name) => {
                setRepo(name);
                setRepoOpen(false);
              }}
            />
          ) : (
            <button className="link-btn" disabled={!!busy} onClick={() => setRepoOpen(true)}>
              Link the app's repo (optional)
            </button>
          )}
        </div>

        <div className="start-foot">
          <span className="muted">The project takes its name from your prompt. You can rename it in the drawer.</span>
          <span className="spacer" />
          <button className="btn btn-ghost btn-md" disabled={!!busy} onClick={onImport}>
            Import…
          </button>
          {onOpenSample && (
            <button className="btn btn-ghost btn-md" disabled={!!busy} onClick={onOpenSample}>
              Open the sample
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
