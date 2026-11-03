import { useCallback, useEffect, useState } from "react";
import { getJSON, sendJSON, type AppConfig, type Load, type ProviderStatus } from "../api.ts";
import { useProviderAuth } from "../auth.ts";
import {
  canSaveModel,
  methodBlocker,
  methodName,
  methodProvider,
  methodReady,
  methodSummary,
  methodTag,
  modelOptions,
  modelSaveBody,
  pickModel,
  setupVendors,
  startChoice,
  type SetupStart,
} from "../first-use.ts";
import { defaultMethod, MODEL_ID, statusOf, VENDORS, type AuthMethod, type Vendor } from "../providers.ts";
import type { Theme } from "../theme.ts";
import type { WorkspaceState } from "./ProjectsNav.tsx";

export type SetupStep = "connect" | "model" | "ready";

const ICON: Record<string, string> = { anthropic: "A", openai: "◎", "opencode-go": "⌘" };
const TYPE_ID = " type"; // a model id has no space

type Catalog =
  | { provider: string; state: "loading" }
  | { provider: string; state: "ready"; models: string[] }
  | { provider: string; state: "error"; message: string };

interface Saved {
  vendorId: string;
  method: AuthMethod;
  provider: string;
  model: string;
}

export interface FirstUseProps {
  config: Load<AppConfig>;
  providers: Load<ProviderStatus[]>;
  workspace: Load<WorkspaceState>;
  onRecheckProviders: () => void;
  onRecheckConfig: () => void;
  onRecheckWorkspace: () => void;
  /** A model choice was saved; the app loads the config again. */
  onSaved: () => void;
  /** "Start designing": the app opens the editor and focuses the composer. */
  onStart: () => void;
  /** "Explore without a model": the app opens the editor and keeps the config. */
  onExplore: () => void;
  /** The theme in use, from the one app-wide choice (`doi:theme`). */
  theme: Theme;
  /** Switches the theme. The flow keeps its step and draft, because the app owns the choice. */
  onTheme: () => void;
}

/**
 * The first-use flow: Connect, Choose a model, Ready.
 *
 * It shows once per workspace, before the editor. Nothing is saved until Continue on the model
 * step; Start designing and Explore both close the flow. Settings can open it again.
 */
export function FirstUse({ config, providers, workspace, onRecheckProviders, onRecheckConfig, onRecheckWorkspace, onSaved, onStart, onExplore, theme, onTheme }: FirstUseProps) {
  const [step, setStep] = useState<SetupStep>("connect");
  const [start, setStart] = useState<SetupStart | null>(null);
  const [choice, setChoice] = useState<{ vendorId: string; method: AuthMethod } | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [typed, setTyped] = useState(false);
  const [saved, setSaved] = useState<Saved | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // The document title follows the step: the browser tab names the screen, as in the reference.
  useEffect(() => {
    document.title = step === "connect" ? "Connect · doi" : step === "model" ? "Choose a model · doi" : "Ready · doi";
    return () => {
      document.title = "doi";
    };
  }, [step]);

  const statuses = providers.state === "ready" ? providers.data : [];
  const configured = config.state === "ready" ? config.data.models.generate : { provider: "", model: "" };

  // The flow starts on the configured generate model. The status must be known, so a ready
  // fallback method (for example the API key when the CLI is logged out) is the right one. After
  // a status failure the flow waits for Check again, instead of guessing a method.
  useEffect(() => {
    if (start || config.state !== "ready" || providers.state !== "ready") return;
    setStart(startChoice(config.data.models.generate, statuses));
  }, [start, config, providers.state, statuses]);

  const vendors = setupVendors(statuses);
  const vendorId = choice?.vendorId ?? start?.vendorId ?? "";
  const vendor = vendors.find((v) => v.id === vendorId) ?? null;
  const method = choice?.method ?? start?.method ?? null;
  const providerId = vendor && method ? methodProvider(vendor, method) : "";
  const status = statuses.find((p) => p.id === providerId);
  const ready = vendor && method ? methodReady(statuses, vendor, method) : false;
  const reason = vendor && method ? methodBlocker(statuses, vendor, method) : null;
  const auth = useProviderAuth(providerId || null, ready, onRecheckProviders);

  const pickVendor = (id: string) => {
    const next = vendors.find((v) => v.id === id) ?? defaultVendor(vendors);
    if (!next) return;
    // Stale credentials, errors, login waits and model choices belong to the vendor that is gone.
    auth.reset();
    setChoice({ vendorId: next.id, method: defaultMethod(next, statuses) });
    setModel(null);
    setTyped(false);
    setSaved(null);
    setSaveError(null);
    setStep("connect");
  };
  const pickMethod = (next: AuthMethod) => {
    if (!vendor || vendor.methods[next] === undefined) return;
    auth.reset();
    setChoice({ vendorId: vendor.id, method: next });
    setModel(null);
    setTyped(false);
    setSaved(null);
    setSaveError(null);
  };

  // The model catalog comes from the selected provider only. A new provider gets a new list.
  useEffect(() => {
    if (step === "model" && providerId) {
      let live = true;
      setCatalog({ provider: providerId, state: "loading" });
      getJSON<{ models: string[] }>(`/api/providers/${providerId}/models`)
        .then(({ models }) => live && setCatalog({ provider: providerId, state: "ready", models }))
        .catch((e: unknown) => live && setCatalog({ provider: providerId, state: "error", message: e instanceof Error ? e.message : String(e) }));
      return () => {
        live = false;
      };
    }
    return;
  }, [step, providerId, attempt]);

  const currentCatalog = catalog && catalog.provider === providerId ? catalog : null;
  const options = currentCatalog?.state === "ready" ? modelOptions(currentCatalog.models, configured, providerId) : [];
  // A kept choice wins; then the configured model of this provider; then the first id of the list.
  useEffect(() => {
    if (step !== "model" || model !== null || currentCatalog?.state !== "ready") return;
    setModel(pickModel(null, configured, providerId, options));
  }, [step, model, currentCatalog, configured, providerId, options]);
  const value = model ?? "";

  const canModel = ready;
  const save = async () => {
    if (!vendor || !method || !canSaveModel(statuses, providerId, value)) return;
    setSaving(true);
    setSaveError(null);
    try {
      await sendJSON("PUT", "/api/config/models", modelSaveBody(providerId, value));
      setSaved({ vendorId: vendor.id, method, provider: providerId, model: value.trim() });
      setStep("ready");
      onSaved();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const retryCatalog = useCallback(() => setAttempt((n) => n + 1), []);

  return (
    <div className="first-use">
      <header className="fu-header">
        <span className="fu-wordmark" aria-label="doi">
          doi<span className="fu-wordmark-dot">.</span>
        </span>
        <div className="fu-header-right">
          <span className="fu-workspace-status">
            <span className="fu-status-dot" />
            LOCAL WORKSPACE
            <span className="fu-status-divider">/</span>
            First use
          </span>
          <button
            type="button"
            className="fu-theme"
            onClick={onTheme}
            title="Switch theme"
            aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
          >
            <span className="theme-icon" aria-hidden="true" />
          </button>
        </div>
      </header>
      <main className="fu-main">
        <nav className="fu-steps-nav" aria-label="Setup progress">
          <ol className="fu-steps">
            <li>
              <button type="button" className={`fu-step${step === "connect" ? " is-active" : " is-complete"}`} aria-current={step === "connect" ? "step" : undefined} onClick={() => setStep("connect")}>
                <span className="fu-step-number">{step === "connect" ? "1" : "✓"}</span>
                Connect
              </button>
            </li>
            <li>
              <button
                type="button"
                className={`fu-step${step === "model" ? " is-active" : step === "ready" ? " is-complete" : ""}`}
                aria-current={step === "model" ? "step" : undefined}
                disabled={!canModel}
                onClick={() => canModel && setStep("model")}
              >
                <span className="fu-step-number">{step === "ready" ? "✓" : "2"}</span>
                Choose a model
              </button>
            </li>
            <li>
              <button type="button" className={`fu-step${step === "ready" ? " is-active" : ""}`} aria-current={step === "ready" ? "step" : undefined} disabled={!saved} onClick={() => saved && setStep("ready")}>
                <span className="fu-step-number">3</span>
                Ready
              </button>
            </li>
          </ol>
          <span className="fu-setup-caption">YOUR FIRST DESIGN STARTS HERE</span>
        </nav>

        <div className="fu-layout">
          <section className="fu-guidance" aria-labelledby="fu-title">
            <p className="fu-eyebrow">{step === "connect" ? "01" : step === "model" ? "02" : "03"} / GET STARTED</p>
            <h1 id="fu-title">
              {step === "connect" ? (
                <>
                  A model, then
                  <br />
                  your first design.
                </>
              ) : step === "model" ? (
                <>
                  Choose your
                  <br />
                  model.
                </>
              ) : (
                <>
                  You are ready
                  <br />
                  to design.
                </>
              )}
            </h1>
            <p className="fu-lead">
              {step === "connect" ? (
                <>
                  Your designs stay on your computer.
                  <br />
                  Connect a provider to bring your ideas to life.
                </>
              ) : step === "model" ? (
                <>
                  One connection. One model.
                  <br />
                  A clear place to start.
                </>
              ) : (
                <>
                  Start with an idea.
                  <br />
                  Make it something you can see.
                </>
              )}
            </p>
            <div className="fu-guidance-note">
              <span className="fu-note-mark" aria-hidden="true">
                ↗
              </span>
              <div>
                <h2>{step === "ready" ? "A small idea is enough." : "Local space. Your choice of model."}</h2>
                <p>
                  {step === "ready" ? (
                    <>
                      A screen, a slide, a one-pager.
                      <br />
                      Tell doi what you want to make.
                    </>
                  ) : (
                    <>Prompts and attached files go to the selected provider. Your workspace stays local.</>
                  )}
                </p>
              </div>
            </div>
          </section>

          {step === "connect" && (
            <section className="fu-card" aria-label="Connect">
              <div className="fu-card-heading">
                <h2>Connect a provider</h2>
                <span className="fu-mono fu-small">01 — 03</span>
              </div>
              <p className="fu-card-intro">Choose the provider you want to design with.</p>

              {config.state === "error" && (
                <div className="fu-banner" role="alert">
                  <span>
                    <strong>The configuration could not load.</strong> {config.message}
                  </span>
                  <button type="button" className="fu-link" onClick={onRecheckConfig}>
                    Try again
                  </button>
                </div>
              )}
              {providers.state === "error" && (
                <div className="fu-banner" role="alert">
                  <span>
                    <strong>The provider status could not load.</strong> {providers.message}
                  </span>
                  <button type="button" className="fu-link" onClick={onRecheckProviders}>
                    Check again
                  </button>
                </div>
              )}

              {!vendor && (config.state === "loading" || providers.state === "loading" || !start) ? (
                <p className="fu-loading" role="status">
                  Checking your providers…
                </p>
              ) : vendor && method ? (
                <>
                  <div className="fu-provider-options" role="radiogroup" aria-label="Model provider">
                    {vendors.map((v) => (
                      <label key={v.id} className={`fu-provider-choice${v.id === vendor.id ? " is-checked" : ""}`}>
                        <input
                          className="fu-provider-radio"
                          type="radio"
                          name="fu-provider"
                          value={v.id}
                          checked={v.id === vendor.id}
                          onChange={() => pickVendor(v.id)}
                        />
                        <span className="fu-provider-icon" aria-hidden="true">
                          {ICON[v.id] ?? "·"}
                        </span>
                        {v.name}
                        <span className="fu-radio-mark" aria-hidden="true" />
                      </label>
                    ))}
                  </div>

                  <div className="fu-connection">
                    <p className="fu-field-label">{method === "oauth" ? "Connection method" : "Connect with an API key"}</p>
                    <div className="fu-method-current">
                      <span>{methodName(vendor, method)}</span>
                      <span className="fu-method-tag">{methodTag(vendor, method)}</span>
                    </div>

                    {method === "oauth" ? (
                      <div className="fu-oauth">
                        <div className="fu-login-state">
                          <span className={`fu-check-icon${ready ? "" : " is-warn"}`} aria-hidden="true">
                            {ready ? "✓" : "!"}
                          </span>
                          <div>
                            <h3>{status ? statusOf(status).label : "Checking…"}</h3>
                            <p>
                              {ready
                                ? `Connected through ${methodTag(vendor, method)}`
                                : status && /not found/i.test(status.detail)
                                  ? status.detail
                                  : auth.login.state === "waiting"
                                    ? "Finish the login in your browser."
                                    : status?.detail || "doi asks the official CLI for its login state."}
                            </p>
                          </div>
                          <button type="button" className="fu-link fu-check-again" onClick={onRecheckProviders}>
                            Check again <span aria-hidden="true">↻</span>
                          </button>
                        </div>
                        {auth.login.state === "waiting" && auth.login.url && (
                          <p className="fu-note">
                            <a className="fu-link" href={auth.login.url} target="_blank" rel="noopener noreferrer">
                              Open the login page
                            </a>
                          </p>
                        )}
                        <p className="fu-cli-note">doi uses the official {methodTag(vendor, method)} and never reads its token.</p>
                        {!ready && status && !/not found/i.test(status.detail) && (
                          <div className="fu-inline-actions">
                            <button type="button" className="fu-button secondary" disabled={auth.login.state !== "idle"} onClick={() => void auth.startLogin()}>
                              {auth.login.state === "idle" ? "Log in" : "Waiting for the login…"}
                            </button>
                          </div>
                        )}
                        {vendor.methods.api_key && (
                          <button type="button" className="fu-alternative" onClick={() => pickMethod("api_key")}>
                            <span className="fu-triangle" aria-hidden="true" /> Use an API key instead
                          </button>
                        )}
                      </div>
                    ) : (
                      <div className="fu-api">
                        <div className="fu-login-state">
                          <span className={`fu-check-icon${ready ? "" : " is-warn"}`} aria-hidden="true">
                            {ready ? "✓" : "!"}
                          </span>
                          <div>
                            <h3>{status ? statusOf(status).label : "Checking…"}</h3>
                            <p>{ready ? "The key is saved. doi keeps it on this computer." : status?.detail || "Add the provider API key."}</p>
                          </div>
                          <button type="button" className="fu-link fu-check-again" onClick={onRecheckProviders}>
                            Check again <span aria-hidden="true">↻</span>
                          </button>
                        </div>
                        {status?.keyFrom === "env" && status.keyEnv && (
                          <p className="fu-note">
                            The environment variable <span className="fu-mono">{status.keyEnv}</span> is set. It wins over a key that you save here.
                          </p>
                        )}
                        <form
                          className="fu-key-form"
                          onSubmit={(e) => {
                            e.preventDefault();
                            if (auth.key.trim()) void auth.saveKey();
                          }}
                        >
                          <label className="fu-field-label" htmlFor="fu-key">
                            {vendor.name} API key
                          </label>
                          <div className="fu-key-row">
                            <input
                              id="fu-key"
                              className="fu-input fu-mono"
                              type="password"
                              autoComplete="off"
                              spellCheck={false}
                              placeholder="Enter your API key"
                              value={auth.key}
                              onChange={(e) => auth.setKey(e.target.value)}
                            />
                            <button type="submit" className="fu-button secondary" disabled={auth.busy || !auth.key.trim()}>
                              Save key
                            </button>
                            {(status?.keyFrom === "keychain" || status?.keyFrom === "file") && (
                              <button type="button" className="fu-link" disabled={auth.busy} onClick={() => void auth.removeKey()}>
                                Remove
                              </button>
                            )}
                          </div>
                        </form>
                        {vendor.methods.oauth && (
                          <button type="button" className="fu-alternative" onClick={() => pickMethod("oauth")}>
                            <span className="fu-triangle" aria-hidden="true" /> Use the {methodName(vendor, "oauth")} instead
                          </button>
                        )}
                      </div>
                    )}
                    {auth.note && (
                      <p className="fu-note" role="status">
                        {auth.note}
                      </p>
                    )}
                    {auth.error && (
                      <div className="fu-banner" role="alert">
                        {auth.error}
                      </div>
                    )}
                  </div>

                  <div className="fu-actions">
                    <span className={`fu-action-note${ready ? "" : " is-blocked"}`} role="status">
                      {reason ?? "Next: choose your model"}
                    </span>
                    <button type="button" className="fu-button primary" disabled={!ready} onClick={() => setStep("model")}>
                      Continue <span aria-hidden="true">→</span>
                    </button>
                  </div>
                  <button type="button" className="fu-explore" onClick={onExplore}>
                    Explore without a model
                  </button>
                </>
              ) : (
                <p className="fu-loading" role="status">
                  {config.state === "error"
                    ? "The configuration must load before you can connect a provider. Use Try again above."
                    : providers.state === "error"
                      ? "The provider status must load before you can connect. Use Check again above."
                      : "Checking your providers…"}
                </p>
              )}
            </section>
          )}

          {step === "model" && vendor && method && (
            <section className="fu-card" aria-label="Choose a model">
              <div className="fu-card-heading">
                <h2>Choose a model</h2>
                <span className="fu-mono fu-small">02 — 03</span>
              </div>
              <p className="fu-card-intro">The model behind your next idea.</p>

              <div className="fu-provider-summary">
                <span className="fu-summary-icon" aria-hidden="true">
                  {ICON[vendor.id] ?? "·"}
                </span>
                <div>
                  <h3>{vendor.name}</h3>
                  <p>{methodSummary(vendor, method)}</p>
                </div>
                <span className="fu-connected-badge">{ready ? "Connected" : "Not ready"}</span>
              </div>

              <div className="fu-model-field">
                <div className="fu-model-label-row">
                  <label className="fu-field-label" htmlFor="fu-model">
                    Model
                  </label>
                  {currentCatalog?.state === "ready" && typed && (
                    <button
                      type="button"
                      className="fu-link fu-small"
                      onClick={() => {
                        setTyped(false);
                        setModel(options.includes(value) ? value : (options[0] ?? ""));
                      }}
                    >
                      List
                    </button>
                  )}
                </div>
                {currentCatalog?.state === "ready" && !typed ? (
                  <>
                    <select
                      id="fu-model"
                      className="fu-select fu-mono"
                      value={value}
                      aria-invalid={!MODEL_ID.test(value.trim())}
                      onChange={(e) => {
                        if (e.target.value === TYPE_ID) {
                          setTyped(true);
                          return;
                        }
                        setModel(e.target.value);
                      }}
                    >
                      {!options.includes(value) && <option value={value}>{value || "Choose a model"}</option>}
                      {options.map((id) => (
                        <option key={id} value={id}>
                          {id}
                        </option>
                      ))}
                      <option value={TYPE_ID}>Type a model id…</option>
                    </select>
                    <p className="fu-field-help">One model for generation, edits and extraction. Change this later in Settings.</p>
                  </>
                ) : currentCatalog?.state === "error" ? (
                  <>
                    <input
                      id="fu-model"
                      className="fu-input fu-mono"
                      value={value}
                      aria-invalid={!MODEL_ID.test(value.trim())}
                      spellCheck={false}
                      placeholder="Type a model id"
                      onChange={(e) => {
                        setTyped(true);
                        setModel(e.target.value);
                      }}
                    />
                    <div className="fu-banner" role="alert">
                      <span>
                        <strong>The model list could not load.</strong> {currentCatalog.message} You can type a model id.
                      </span>
                      <button type="button" className="fu-link" onClick={retryCatalog}>
                        Retry
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <input
                      id="fu-model"
                      className="fu-input fu-mono"
                      value={value}
                      aria-invalid={!MODEL_ID.test(value.trim())}
                      spellCheck={false}
                      placeholder={currentCatalog?.state === "loading" && !typed || !currentCatalog ? "Loading models…" : "Type a model id"}
                      disabled={!typed && (currentCatalog?.state === "loading" || !currentCatalog)}
                      onChange={(e) => {
                        setTyped(true);
                        setModel(e.target.value);
                      }}
                    />
                    {currentCatalog?.state === "loading" || !currentCatalog ? (
                      <p className="fu-field-help" role="status">
                        Loading the models of {vendor.name}…{" "}
                        {!typed && (
                          <button type="button" className="fu-link" onClick={() => setTyped(true)}>
                            Type a model id instead
                          </button>
                        )}
                      </p>
                    ) : (
                      <p className="fu-field-help">Type the model id for {vendor.name}.</p>
                    )}
                  </>
                )}
                {value.trim() && !MODEL_ID.test(value.trim()) && (
                  <p className="fu-field-error" role="alert">
                    A model id has letters, digits and . _ @ / : - only, and it does not start with a flag.
                  </p>
                )}
              </div>

              <div className="fu-model-description">
                <span className="fu-note-mark" aria-hidden="true">
                  ↳
                </span>
                <p>{ready ? "Your provider connection is ready. Choose a model to complete this step." : reason ?? "The provider is not ready. Go back and connect it."}</p>
              </div>

              {saveError && (
                <div className="fu-banner" role="alert">
                  <span>
                    <strong>The model was not saved.</strong> {saveError}
                  </span>
                </div>
              )}

              <div className="fu-actions">
                <button type="button" className="fu-back-link" onClick={() => setStep("connect")}>
                  ← Back
                </button>
                <button type="button" className="fu-button primary" disabled={saving || !canSaveModel(statuses, providerId, value)} onClick={() => void save()}>
                  {saving ? "Saving…" : "Continue"} <span aria-hidden="true">→</span>
                </button>
              </div>
            </section>
          )}

          {step === "ready" && saved && (
            <section className="fu-card" aria-label="Ready">
              <div className="fu-card-heading">
                <h2>All connected</h2>
                <span className="fu-ready-check" aria-label="Complete">
                  ✓
                </span>
              </div>
              <p className="fu-card-intro">Your workspace is ready for its first idea.</p>
              <dl className="fu-ready-summary">
                <div>
                  <dt>Provider</dt>
                  <dd>
                    {savedVendor(saved.vendorId).name}
                    <span>{methodSummary(savedVendor(saved.vendorId), saved.method)}</span>
                  </dd>
                </div>
                <div>
                  <dt>Model</dt>
                  <dd className="fu-mono">{saved.model}</dd>
                </div>
                <div>
                  <dt>Workspace</dt>
                  <dd>
                    On this computer
                    <span>Your designs and files stay here.</span>
                    {workspace.state === "ready" ? (
                      <span className="fu-path fu-mono">{workspace.data.path}</span>
                    ) : workspace.state === "error" ? (
                      <span className="fu-path">
                        The workspace could not load.{" "}
                        <button type="button" className="fu-link" onClick={onRecheckWorkspace}>
                          Try again
                        </button>
                      </span>
                    ) : null}
                  </dd>
                </div>
              </dl>
              <p className="fu-settings-note">You can change your provider and model in Settings.</p>
              <div className="fu-actions">
                <button type="button" className="fu-back-link" onClick={() => setStep("model")}>
                  ← Back
                </button>
                <button type="button" className="fu-button primary" onClick={onStart}>
                  Start designing <span aria-hidden="true">→</span>
                </button>
              </div>
            </section>
          )}
        </div>

        <footer className="fu-footer">
          <span>A space for your next idea.</span>
          <span className="fu-mono">LOCAL BY DEFAULT</span>
        </footer>
      </main>
    </div>
  );
}

function defaultVendor(vendors: Vendor[]): Vendor | null {
  return vendors[0] ?? null;
}

function savedVendor(id: string): Vendor {
  return VENDORS.find((v) => v.id === id) ?? VENDORS[0]!;
}
