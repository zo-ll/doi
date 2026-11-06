import { useState } from "react";

/**
 * Runs `reset` during the render in which `key` changes. React then renders again before it
 * commits, so the page never shows the state of the old key. `reset` may only set state of the
 * calling component or replace a ref's value with a fresh one.
 * https://react.dev/reference/react/useState#storing-information-from-previous-renders
 */
export function useResetOn(key: string | null, reset: () => void): void {
  const [seen, setSeen] = useState(key);
  if (seen === key) return;
  setSeen(key);
  reset();
}
