import { useEffect, useMemo, useRef, useState } from "react";
import { getJSON, type AppConfig, type Load, type ProjectSummary, type ProviderStatus, type UsageEntry } from "../api.ts";
import { providerName } from "../providers.ts";
import { formatCount, summarize, type Billing, type Group } from "../usage.ts";

const RANGES: { days: number | null; label: string }[] = [
  { days: 7, label: "Last 7 days" },
  { days: 30, label: "Last 30 days" },
  { days: 90, label: "Last 90 days" },
  { days: null, label: "All time" },
];
const GROUPS: { id: Group; label: string }[] = [
  { id: "project", label: "Project" },
  { id: "design", label: "Design" },
  { id: "model", label: "Model" },
  { id: "day", label: "Day" },
];
const usd = (n: number) => `$${n < 10 ? n.toFixed(2) : n.toFixed(0)}`;
const shortDate = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString(undefined, { day: "numeric", month: "short" });

/** Usage (#62): tokens and estimated cost per project, design, model and day, from the chat history. */
export function UsageDialog({ config, providers, projects, onClose }: {
  config: AppConfig;
  providers: Load<ProviderStatus[]>;
  projects: ProjectSummary[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [entries, setEntries] = useState<Load<UsageEntry[]>>({ state: "loading" });
  const [days, setDays] = useState<number | null>(30);
  const [group, setGroup] = useState<Group>("model");

  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  useEffect(() => {
    let live = true;
    getJSON<UsageEntry[]>("/api/usage")
      .then((data) => live && setEntries({ state: "ready", data }))
      .catch((e: Error) => live && setEntries({ state: "error", message: e.message }));
    return () => {
      live = false;
    };
  }, []);

  const sources = providers.state === "ready" ? providers.data : [];
  // Without the provider status, a turn's billing is not known: no cost, and not "no price".
  const billing = (id: string): Billing => {
    const s = sources.find((p) => p.id === id)?.source;
    return s === "cli" ? "subscription" : s === "local" ? "local" : s === "api_key" ? "api" : "unknown";
  };
  const summary = useMemo(
    () =>
      entries.state === "ready"
        ? summarize(entries.data, billing, config.prices, group, days, Date.now(), {
            project: (id) => projects.find((p) => p.id === id)?.name ?? id,
            provider: providerName,
          })
        : null,
    [entries, group, days, config.prices, sources, projects],
  );
  const max = summary ? Math.max(1, ...summary.days.map((d) => d.subscription + d.api + d.local + d.unknown)) : 1;
  const hasLocal = !!summary?.days.some((d) => d.local > 0);
  const hasUnknown = !!summary?.days.some((d) => d.unknown > 0);

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog usage-dialog" role="dialog" aria-modal="true" aria-label="Usage" tabIndex={-1} ref={ref}>
        <div className="usage-inner">
          <div className="dialog-head">
            <h2>Usage</h2>
            <span className="spacer" />
            <select className="select usage-range" value={String(days)} onChange={(e) => setDays(e.target.value === "null" ? null : Number(e.target.value))} aria-label="Range">
              {RANGES.map((r) => (
                <option key={String(r.days)} value={String(r.days)}>
                  {r.label}
                </option>
              ))}
            </select>
            <div className="seg" role="radiogroup" aria-label="Group by">
              {GROUPS.map((g) => (
                <button key={g.id} className="seg-item" role="radio" aria-checked={group === g.id} onClick={() => setGroup(g.id)}>
                  {g.label}
                </button>
              ))}
            </div>
            <button className="icon-btn" onClick={onClose} aria-label="Close" title="Close (Esc)">
              ×
            </button>
          </div>

          {entries.state === "loading" && (
            <div className="usage-body" aria-busy="true" aria-label="Reading the chat history">
              <div className="skeleton comment-skeleton" />
            </div>
          )}
          {entries.state === "error" && (
            <div className="usage-body">
              <div className="banner banner-err" role="alert">
                <span className="dot dot-err" />
                The usage cannot load: {entries.message}
              </div>
            </div>
          )}
          {summary && (
            <div className="usage-body">
              <div className="usage-stats">
                <div>
                  <span>Input tokens</span>
                  <strong>{formatCount(summary.input)}</strong>
                </div>
                <div>
                  <span>Output tokens</span>
                  <strong>{formatCount(summary.output)}</strong>
                </div>
                <div>
                  <span>Cached</span>
                  <strong>{formatCount(summary.cached)}</strong>
                </div>
                <div>
                  <span>Estimated cost · API only</span>
                  <strong>{usd(summary.cost)}</strong>
                </div>
              </div>

              <div className="usage-chart-head">
                <span>Tokens per day</span>
                <span className="spacer" />
                <span className="legend legend-sub">Subscription</span>
                <span className="legend legend-api">API</span>
                {hasLocal && <span className="legend legend-local">Local</span>}
                {hasUnknown && <span className="legend legend-unknown">Unknown provider</span>}
              </div>
              <div className="usage-chart" role="img" aria-label="Tokens per day">
                {summary.days.map((d) => {
                  const total = d.subscription + d.api + d.local + d.unknown;
                  return (
                    <div key={d.date} className="usage-day" title={`${shortDate(d.date)}: ${formatCount(total)} tokens`}>
                      <span className="bar bar-unknown" style={{ height: `${(d.unknown / max) * 100}%` }} />
                      <span className="bar bar-local" style={{ height: `${(d.local / max) * 100}%` }} />
                      <span className="bar bar-api" style={{ height: `${(d.api / max) * 100}%` }} />
                      <span className="bar bar-sub" style={{ height: `${(d.subscription / max) * 100}%` }} />
                    </div>
                  );
                })}
              </div>
              <div className="usage-axis">
                <span>{summary.days[0] ? shortDate(summary.days[0].date) : ""}</span>
                <span>{summary.days.at(-1) ? shortDate(summary.days.at(-1)!.date) : ""}</span>
              </div>

              {summary.rows.length === 0 ? (
                <p className="comments-empty">No turns in this range.</p>
              ) : (
                <table className="usage-table">
                  <thead>
                    <tr>
                      <th>{GROUPS.find((g) => g.id === group)?.label}</th>
                      <th>Turns</th>
                      <th>Input</th>
                      <th>Output</th>
                      <th>Cached</th>
                      <th>Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.rows.map((r) => (
                      <tr key={r.key}>
                        <td>
                          <span className={group === "model" || group === "day" ? "mono" : ""}>{group === "day" ? shortDate(r.label) : r.label}</span>
                          {r.via && <span className="muted"> · {r.via}</span>}
                        </td>
                        <td>{r.turns}</td>
                        <td>{formatCount(r.input)}</td>
                        <td>{formatCount(r.output)}</td>
                        <td>{formatCount(r.cached)}</td>
                        <td className={r.cost === null ? "muted" : ""}>
                          {r.cost !== null
                            ? usd(r.cost)
                            : r.billing === "subscription"
                              ? "Subscription"
                              : r.billing === "local"
                                ? "Local"
                                : r.billing === "api"
                                  ? "No price"
                                  : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <p className="settings-note">
                Cost is an estimate from the [prices] table in config.toml. Subscriptions and local models show tokens only.
                {summary.unpriced > 0 && ` ${summary.unpriced} API turn${summary.unpriced === 1 ? " has" : "s have"} no price.`}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
