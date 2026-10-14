// Light and dark theme. Without a choice the app follows the system; a choice is stored per browser.
import { useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark";
const KEY = "doi:theme";

function stored(): Theme | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : null;
  } catch {
    return null; // storage can be off (private window)
  }
}

const systemTheme = (): Theme => (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");

/** The stored choice: a theme, or null to follow the system. */
export type ThemeChoice = Theme | null;

/** The theme in use, a toggle that stores the other one, and the choice with its setter. */
export function useTheme(): [Theme, () => void, ThemeChoice, (c: ThemeChoice) => void] {
  const [choice, setChoice] = useState<Theme | null>(stored);
  const [system, setSystem] = useState<Theme>(systemTheme);

  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setSystem(systemTheme());
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    if (choice) document.documentElement.dataset.theme = choice;
    else delete document.documentElement.dataset.theme;
  }, [choice]);

  const theme = choice ?? system;
  const choose = useCallback((next: ThemeChoice) => {
    setChoice(next);
    try {
      if (next) localStorage.setItem(KEY, next);
      else localStorage.removeItem(KEY);
    } catch {
      // the choice lasts until the page reloads
    }
  }, []);
  const toggle = useCallback(() => choose(theme === "dark" ? "light" : "dark"), [theme, choose]);
  return [theme, toggle, choice, choose];
}
