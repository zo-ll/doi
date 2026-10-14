import { useEffect, useState } from "react";
import { getJSON, sendJSON, type Active } from "../api.ts";
import type { Control, Tweaks } from "../../workspace/tweaks.ts";

const tweaksUrl = (a: Active) => `/api/projects/${a.project}/designs/${a.design}/tweaks`;
const numberOf = (value: string) => Number.parseFloat(value);
/** The color input takes #rrggbb only; other colors (oklch, rgb) show as text. */
const HEX6 = /^#[0-9a-f]{6}$/i;
const hex = (v: string) => (HEX6.test(v) ? v : /^#[0-9a-f]{3}$/i.test(v) ? `#${[...v.slice(1)].map((c) => c + c).join("")}` : null);

/**
 * Tweaks (T, #65): controls for the design's CSS variables. A change shows in every frame at
 * once, with no model call; "Save as version" writes styles.css and makes a version.
 */
export function TweaksPanel({ active, revision, values, onChange, onSaved, onClose }: {
  active: Active;
  /** Changes when the design files change: the controls load again. */
  revision: number;
  /** The live values, by variable name. */
  values: Record<string, string>;
  onChange: (values: Record<string, string>) => void;
  /** The values are in styles.css now; `commitError` when no version was made. */
  onSaved: (commit: string | null, commitError?: string) => void;
  onClose: () => void;
}) {
  const [tweaks, setTweaks] = useState<Tweaks | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    getJSON<Tweaks>(tweaksUrl(active))
      .then((t) => live && setTweaks(t))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [active.project, active.design, revision]);

  const set = (c: Control, value: string) => {
    const next = { ...values };
    if (value === c.value) delete next[c.var];
    else next[c.var] = value;
    onChange(next);
  };
  const dirty = Object.keys(values).length > 0;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await sendJSON<{ commit: string | null; commitError?: string; tweaks: Tweaks }>("PUT", tweaksUrl(active), { vars: values });
      setTweaks(r.tweaks);
      onSaved(r.commit, r.commitError);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="tweaks" role="dialog" aria-label="Tweaks">
      <div className="tweaks-head">
        <span className="panel-title">Tweaks</span>
        <span className="spacer" />
        <button className="icon-btn" onClick={onClose} aria-label="Close tweaks" title="Close (T)">
          ×
        </button>
      </div>
      <div className="tweaks-body">
        <p className="tweaks-note">
          {tweaks?.source === "tweaks.json" ? "From tweaks.json, written by the model." : "From the CSS variables in styles.css."} Changes show live, without a model call.
        </p>
        {!tweaks && !error && <div className="skeleton comment-skeleton" aria-label="Loading the tweaks" />}
        {tweaks && tweaks.controls.length === 0 && (
          <p className="tweaks-note">This design has no colors or sizes on :root yet. Ask the model to put its tokens in CSS variables.</p>
        )}
        {tweaks?.controls.map((c) => {
          const value = values[c.var] ?? c.value;
          return (
            <div key={c.var} className="tweak">
              <div className="tweak-head">
                <span className="mono">{c.var}</span>
                <span className="mono muted truncate">{value}</span>
              </div>
              {c.type === "color" &&
                (hex(c.value) ? (
                  <input type="color" className="tweak-color" value={hex(value) ?? hex(c.value)!} onChange={(e) => set(c, e.target.value)} aria-label={c.var} />
                ) : (
                  <input className="input mono tweak-text" value={value} onChange={(e) => set(c, e.target.value)} aria-label={c.var} spellCheck={false} />
                ))}
              {c.type === "slider" && (
                <input
                  type="range"
                  className="tweak-range"
                  min={c.min}
                  max={c.max}
                  step={c.step}
                  value={numberOf(value)}
                  onChange={(e) => set(c, `${Number(e.target.value)}${c.unit}`)}
                  aria-label={c.var}
                />
              )}
              {c.type === "select" && (
                <div className="seg" role="radiogroup" aria-label={c.var}>
                  {c.options.map((o) => (
                    <button key={o} className="seg-item" role="radio" aria-checked={value === o} onClick={() => set(c, o)}>
                      {o}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        {error && (
          <div className="banner banner-err" role="alert">
            <span className="dot dot-err" />
            {error}
          </div>
        )}
      </div>
      <div className="tweaks-foot">
        <button className="btn btn-ghost btn-md" disabled={!dirty || busy} onClick={() => onChange({})}>
          Reset
        </button>
        <span className="spacer" />
        <button className="btn btn-primary btn-md" disabled={!dirty || busy} onClick={() => void save()}>
          Save as version
        </button>
      </div>
    </div>
  );
}
