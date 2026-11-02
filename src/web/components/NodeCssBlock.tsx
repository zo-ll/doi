import { useCallback, useEffect, useRef, useState } from "react";
import { formatNodeCss, readNodeCss } from "../node-css.ts";

/**
 * The CSS of the selected node in the side panel. A hidden iframe loads the same page with
 * sandbox (same origin) and no scripts, so the app can read its stylesheets (the design
 * frames have the origin "null" and cannot) while no design script runs with the app's origin.
 * It is the one exception to "every iframe is allow-scripts only" (test/security.test.ts); never
 * add allow-scripts here: scripts and the app's origin together would give a design the app.
 */
export function NodeCssBlock({ src, oid, onToast }: { src: string; oid: string; onToast: (text: string) => void }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [css, setCss] = useState<string | null>(null);
  const read = useCallback(() => {
    const doc = ref.current?.contentDocument;
    if (!doc || doc.readyState !== "complete") return;
    const found = readNodeCss(doc, oid);
    setCss(found ? formatNodeCss(found) : null);
  }, [oid]);
  useEffect(read, [read]);

  const copy = () => {
    if (css === null) return;
    navigator.clipboard.writeText(css).then(
      () => onToast("CSS copied"),
      () => onToast("Copy failed. Select the CSS and copy it."),
    );
  };

  return (
    <>
      <iframe ref={ref} src={src} sandbox="allow-same-origin" onLoad={read} className="node-css-source" title="CSS source" aria-hidden="true" tabIndex={-1} />
      {css !== null && (
        <div className="node-css">
          <div className="node-link-head">
            <span className="node-css-title">CSS</span>
            <button className="btn btn-ghost btn-sm" onClick={copy} title="Copy the CSS of this node">
              Copy CSS
            </button>
          </div>
          <pre className="node-css-code mono" tabIndex={0} aria-label={`CSS of ${oid}`}>
            {css || "/* No CSS rule matches this element. */"}
          </pre>
        </div>
      )}
    </>
  );
}
