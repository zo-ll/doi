import { type TaskStatus } from "../providers.ts";
import { MOD } from "./TopBar.tsx";

export const TONE_DOT = { ok: "dot-ok", warn: "dot-warn", err: "dot-err", unknown: "" } as const;

/** The model menu of a composer: the models from the config, for this design's turns. */
export function ModelMenu({ choices, chosen, onChoose, onClose, onOpenSettings }: {
  choices: TaskStatus[];
  chosen: TaskStatus | null;
  /** null goes back to the models of the config. */
  onChoose: (model: TaskStatus | null) => void;
  onClose: () => void;
  onOpenSettings: () => void;
}) {
  return (
    <>
      <div className="popover-layer" onMouseDown={onClose} />
      <div className="menu model-menu" role="menu" aria-label="Model">
        <div className="menu-label">Model for this design · from config.toml</div>
        {chosen && (
          <button
            className="menu-item"
            role="menuitem"
            onClick={() => onChoose(null)}
          >
            Use the config: generate and edit models
          </button>
        )}
        {choices.map((t) => {
          const on = chosen ? chosen.provider === t.provider && chosen.model === t.model : false;
          return (
            <button
              key={`${t.provider}:${t.model}`}
              className="menu-item"
              role="menuitemradio"
              aria-checked={on}
              disabled={t.tone !== "ok"}
              onClick={() => onChoose(t)}
            >
              <span className={`dot ${TONE_DOT[t.tone]}`} />
              <span className="model-menu-name">
                <span className="mono truncate">{t.model}</span>
                {t.vision === false && <span className="model-menu-note">No images</span>}
              </span>
              <span className="meta">
                {t.provider}
                {on ? " ✓" : ""}
              </span>
            </button>
          );
        })}
        <div className="menu-sep" />
        <button
          className="menu-item"
          onClick={() => {
            onClose();
            onOpenSettings();
          }}
        >
          Models and providers…<span className="meta">{MOD},</span>
        </button>
      </div>
    </>
  );
}
