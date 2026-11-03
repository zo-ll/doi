import { useState } from "react";
import type { ProviderStatus } from "../api.ts";
import { useProviderAuth } from "../auth.ts";
import { defaultMethod, METHOD_LABEL, methodsOf, statusOf, vendorOf, VENDORS, type AuthMethod } from "../providers.ts";

const TONE_DOT = { ok: "dot-ok", warn: "dot-warn", err: "dot-err", unknown: "" } as const;

/** Settings: select a provider, then connect it with OAuth (official CLI) or an API key. */
export function ProviderAuth({ providers, initial, onRecheck }: {
  providers: ProviderStatus[];
  /** The provider id to show first. */
  initial: string;
  onRecheck: () => void;
}) {
  const [vendorId, setVendorId] = useState(() => vendorOf(initial).id);
  const vendor = VENDORS.find((v) => v.id === vendorId)!;
  const [method, setMethod] = useState<AuthMethod>(() => defaultMethod(vendor, providers));

  const providerId = vendor.methods[method]!;
  const p = providers.find((x) => x.id === providerId);
  const s = statusOf(p);
  const auth = useProviderAuth(providerId, !!p?.ready, onRecheck);
  const { key, setKey, busy, error, note, login } = auth;

  const pickVendor = (id: string) => {
    const v = VENDORS.find((x) => x.id === id)!;
    setVendorId(id);
    setMethod(defaultMethod(v, providers));
    auth.reset();
  };
  const pickMethod = (m: AuthMethod) => {
    setMethod(m);
    auth.reset();
  };

  const stored = p?.keyFrom === "keychain" || p?.keyFrom === "file";
  const methods = methodsOf(vendor);

  return (
    <div className="provider-auth">
      <div className="provider-auth-head">
        <select className="select" value={vendorId} aria-label="Provider" onChange={(e) => pickVendor(e.target.value)}>
          {VENDORS.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </select>
        {methods.length > 1 && (
          <div className="seg" role="radiogroup" aria-label="Connect with">
            {methods.map((m) => (
              <button key={m} className="seg-item" role="radio" aria-checked={method === m} onClick={() => pickMethod(m)}>
                {METHOD_LABEL[m]}
              </button>
            ))}
          </div>
        )}
        <span className="spacer" />
        <span className="status">
          <span className={`dot ${TONE_DOT[s.tone]}`} />
          {s.label}
        </span>
      </div>

      <div className="provider-auth-body">
        {!p ? (
          <p className="muted">Checking…</p>
        ) : !p.implemented ? (
          <p className="muted">doi has no adapter for this provider yet.</p>
        ) : method === "oauth" ? (
          <>
            <p className="muted">{vendor.oauthLabel}. The CLI opens the login page in your browser and keeps the token. doi only asks the CLI if it is logged in.</p>
            {p.ready ? (
              <p>Logged in.</p>
            ) : /not found/i.test(p.detail) ? (
              <p>{p.detail}. Install the CLI, then check again.</p>
            ) : login.state === "waiting" ? (
              <p>
                Finish the login in your browser.{" "}
                {login.url && (
                  <a href={login.url} target="_blank" rel="noopener noreferrer">
                    Open the login page
                  </a>
                )}
              </p>
            ) : null}
            <div className="settings-actions">
              <span className="spacer" />
              {!p.ready && !/not found/i.test(p.detail) && (
                <button className="btn btn-primary" disabled={login.state !== "idle"} onClick={() => void auth.startLogin()}>
                  {login.state === "idle" ? "Log in" : "Waiting for the login…"}
                </button>
              )}
              <button className="btn btn-secondary" onClick={onRecheck}>
                Check again
              </button>
            </div>
          </>
        ) : method === "api_key" ? (
          <>
            <p className="muted">{p.detail}.</p>
            {p.keyFrom === "env" && (
              <p className="muted">
                The environment variable <span className="mono">{p.keyEnv}</span> is set. It wins over a key that you add here.
              </p>
            )}
            <form
              className="key-form"
              onSubmit={(e) => {
                e.preventDefault();
                if (key.trim()) void auth.saveKey();
              }}
            >
              <input
                className="input mono"
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder={stored ? "Paste a new key to replace the stored key" : "Paste the API key"}
                aria-label={`${vendor.name} API key`}
                value={key}
                onChange={(e) => setKey(e.target.value)}
              />
              <button className="btn btn-primary" type="submit" disabled={busy || !key.trim()}>
                Save
              </button>
              {stored && (
                <button className="btn btn-ghost" type="button" disabled={busy} onClick={() => void auth.removeKey()}>
                  Remove
                </button>
              )}
            </form>
          </>
        ) : (
          <>
            <p className="muted">{p.detail}</p>
            <div className="settings-actions">
              <span className="spacer" />
              <button className="btn btn-secondary" onClick={onRecheck}>
                Check again
              </button>
            </div>
          </>
        )}
        {note && <p className="status">{note}</p>}
        {error && (
          <div className="banner banner-err" role="alert">
            <span className="dot dot-err" />
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
