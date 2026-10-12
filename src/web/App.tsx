import { useEffect, useRef, useState } from "react";

interface Selection {
  oid: string;
  rect: { x: number; y: number; width: number; height: number };
}

const FRAMES = [
  { id: "desktop", width: 1440, height: 900 },
  { id: "mobile", width: 390, height: 844 },
];
const SCALE = 0.4;

function Frame({ src, width, height, onSelect }: {
  src: string;
  width: number;
  height: number;
  onSelect: (s: Selection) => void;
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [selected, setSelected] = useState<Selection | null>(null);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== ref.current?.contentWindow) return;
      if (event.data?.type !== "doi:select") return;
      const s = { oid: String(event.data.oid), rect: event.data.rect };
      setSelected(s);
      onSelect(s);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [onSelect]);

  return (
    <div className="frame" style={{ width: width * SCALE, height: height * SCALE }}>
      <div style={{ width, height, transform: `scale(${SCALE})`, transformOrigin: "0 0", position: "relative" }}>
        <iframe ref={ref} src={src} sandbox="allow-scripts" width={width} height={height} />
        {selected && (
          <div
            className="selection"
            style={{ left: selected.rect.x, top: selected.rect.y, width: selected.rect.width, height: selected.rect.height }}
          />
        )}
      </div>
    </div>
  );
}

export function App() {
  const [selection, setSelection] = useState<Selection | null>(null);
  const [prompt, setPrompt] = useState("");

  return (
    <div className="app">
      <aside className="chat">
        <h1>doi</h1>
        <p className="muted">Chat and generation arrive in M1.</p>
        {selection && <p className="chip">Selected: <code>{selection.oid}</code></p>}
        <form onSubmit={(e) => e.preventDefault()}>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Describe a design or a change"
            rows={4}
          />
          <button type="submit" disabled>Send</button>
        </form>
      </aside>
      <main className="canvas">
        {FRAMES.map((f) => (
          <figure key={f.id}>
            <figcaption>{f.id} · {f.width}px</figcaption>
            <Frame src="/design/sample/home/" width={f.width} height={f.height} onSelect={setSelection} />
          </figure>
        ))}
      </main>
    </div>
  );
}
