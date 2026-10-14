import { join } from "node:path";
import { rootTokens } from "../handoff/bundle.ts";

/**
 * Tweaks (#65): controls for the CSS variables of a design. The model writes `tweaks.json`
 * (system prompt v2); without it, the controls come from the `:root` variables of styles.css.
 * A change shows in the frames at once; "Save" writes the values into styles.css.
 */
export type Control =
  | { var: string; type: "color"; value: string }
  | { var: string; type: "slider"; value: string; min: number; max: number; step: number; unit: string }
  | { var: string; type: "select"; value: string; options: string[] };

export interface Tweaks {
  source: "tweaks.json" | "styles.css";
  controls: Control[];
}

export class TweakError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const VAR = /^--[A-Za-z0-9_-]{1,60}$/;
const MAX_CONTROLS = 12;
const COLOR = /^(#[0-9a-f]{3,8}|(rgb|rgba|hsl|hsla|oklch|oklab|lab|lch|color)\(.+\))$/i;
const LENGTH = /^(-?\d*\.?\d+)(px|rem|em|%|vw|vh|ch)?$/;

/** A slider for a number with a unit, from 0 to about twice its value. */
function sliderFor(name: string, value: string): Control | null {
  const m = LENGTH.exec(value.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2] ?? "";
  const small = unit === "rem" || unit === "em" || (!unit && Math.abs(n) <= 4);
  const step = small ? 0.05 : 1;
  const max = small ? Math.max(4, Math.ceil(n * 2)) : Math.max(16, Math.ceil(n * 2));
  return { var: name, type: "slider", value: value.trim(), min: Math.min(0, n), max, step, unit };
}

/** Controls from the variables themselves: colors and numbers with units. */
export function deriveControls(vars: Map<string, string>): Control[] {
  const out: Control[] = [];
  for (const [name, raw] of vars) {
    const value = raw.trim();
    if (COLOR.test(value)) out.push({ var: name, type: "color", value });
    else {
      const s = sliderFor(name, value);
      if (s) out.push(s);
    }
    if (out.length >= MAX_CONTROLS) break;
  }
  return out;
}

/** The controls of tweaks.json that name a variable on :root, with its value now. Bad entries are left out. */
export function parseTweaksJson(raw: unknown, vars: Map<string, string>): Control[] {
  const list = (raw as { controls?: unknown })?.controls;
  if (!Array.isArray(list)) return [];
  const out: Control[] = [];
  for (const c of list.slice(0, MAX_CONTROLS)) {
    if (typeof c !== "object" || c === null) continue;
    const { var: name, type } = c as Record<string, unknown>;
    if (typeof name !== "string" || !VAR.test(name) || !vars.has(name)) continue;
    const value = vars.get(name)!.trim();
    if (type === "color") out.push({ var: name, type, value });
    else if (type === "select") {
      const options = (c as { options?: unknown }).options;
      if (!Array.isArray(options)) continue;
      const opts = options.filter((o): o is string => typeof o === "string" && o.length > 0 && o.length <= 60).slice(0, 12);
      if (opts.length) out.push({ var: name, type, value, options: opts.includes(value) ? opts : [value, ...opts] });
    } else if (type === "slider") {
      const { min, max, step, unit } = c as Record<string, unknown>;
      const base = sliderFor(name, value);
      if (!base || base.type !== "slider") continue;
      const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
      out.push({ ...base, min: num(min, base.min), max: num(max, base.max), step: num(step, base.step), unit: typeof unit === "string" ? unit : base.unit });
    }
  }
  return out;
}

export async function readTweaks(dir: string): Promise<Tweaks> {
  const css = Bun.file(join(dir, "styles.css"));
  const vars = (await css.exists()) ? rootTokens(await css.text()) : new Map<string, string>();
  const file = Bun.file(join(dir, "tweaks.json"));
  if (await file.exists()) {
    try {
      const controls = parseTweaksJson(await file.json(), vars);
      if (controls.length) return { source: "tweaks.json", controls };
    } catch {
      // A broken tweaks.json: use the variables instead.
    }
  }
  return { source: "styles.css", controls: deriveControls(vars) };
}

/** Checks the values the UI sends: known variable names, values without CSS structure. */
export function checkVars(raw: unknown): Record<string, string> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new TweakError("vars must be an object.");
  const out: Record<string, string> = {};
  const entries = Object.entries(raw as Record<string, unknown>);
  if (!entries.length || entries.length > MAX_CONTROLS) throw new TweakError(`Send 1 to ${MAX_CONTROLS} variables.`);
  for (const [name, value] of entries) {
    if (!VAR.test(name)) throw new TweakError(`"${name}" is not a CSS variable name.`);
    if (typeof value !== "string" || !value.trim() || value.length > 200 || /[;{}<>\\]|\/\*/.test(value)) {
      throw new TweakError(`The value of ${name} is not valid.`);
    }
    out[name] = value.trim();
  }
  return out;
}

/**
 * Writes the values into the top-level `:root` rules of the CSS: each declaration of the variable there
 * gets the new value, and the rest of the file stays as it is. A variable that is on no
 * `:root` rule is an error, so nothing is written half.
 */
export function withVars(css: string, vars: Record<string, string>): string {
  const found = new Set<string>();
  // Comments can hold braces; blank them for the depth count (same length).
  const plain = css.replace(/\/\*[\s\S]*?\*\//g, (c) => " ".repeat(c.length));
  const depthAt = (i: number) => {
    let d = 0;
    for (let k = 0; k < i; k++) d += plain[k] === "{" ? 1 : plain[k] === "}" ? -1 : 0;
    return d;
  };
  const out = css.replace(/(:root\s*\{)([^{}]*)(\})/g, (all, open: string, body: string, close: string, at: number) => {
    // Only the :root rules at the top level: the ones in @media or @supports keep their values.
    if (depthAt(at) !== 0) return all;
    const next = body.replace(/(--[A-Za-z0-9_-]+)(\s*:\s*)([^;]*)/g, (decl, name: string, sep: string, value: string) => {
      if (!(name in vars)) return decl;
      found.add(name);
      // Keep the whitespace after the value (a newline before the next line).
      const tail = value.match(/\s*$/)?.[0] ?? "";
      return `${name}${sep}${vars[name]}${tail}`;
    });
    return open + next + close;
  });
  const missing = Object.keys(vars).filter((n) => !found.has(n));
  if (missing.length) throw new TweakError(`Not on :root in styles.css: ${missing.join(", ")}.`, 409);
  return out;
}
