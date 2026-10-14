import { createRoot } from "react-dom/client";
// IBM Plex, bundled (OFL): doi sends no request to a font service.
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import { App } from "./App.tsx";

createRoot(document.getElementById("root")!).render(<App />);
