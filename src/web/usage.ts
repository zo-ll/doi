// The usage report (#62) without React: totals, groups, tokens per day and estimated cost.
import type { Price } from "../config.ts";
import type { UsageEntry } from "../workspace/chat.ts";

export type Group = "project" | "design" | "model" | "day";
/** How a provider bills: a subscription through a CLI, an API key, a local model, or not known (no status). */
export type Billing = "subscription" | "api" | "local" | "unknown";

export interface UsageRow {
  key: string;
  label: string;
  /** For a model row: "Claude Code", "Anthropic API"… */
  via?: string;
  turns: number;
  input: number;
  output: number;
  cached: number;
  /** USD; null when no turn of the row has a price (subscription, local or no price). */
  cost: number | null;
  billing: Billing | "mixed";
}

export interface UsageSummary {
  input: number;
  output: number;
  cached: number;
  /** USD of the turns that have a price. */
  cost: number;
  /** Turns of API models without a price in config.toml. */
  unpriced: number;
  /** One entry per day of the range, oldest first: tokens (input + output) by billing. */
  days: { date: string; subscription: number; api: number; local: number; unknown: number }[];
  rows: UsageRow[];
}

const DAY = 86_400_000;
const dayOf = (iso: string) => iso.slice(0, 10);

/** The cost of one answer, or null without a price. Input includes the cached tokens. */
export function costOf(e: Pick<UsageEntry, "inputTokens" | "outputTokens" | "cachedTokens">, price: Price | undefined): number | null {
  if (!price) return null;
  const cached = Math.min(e.cachedTokens, e.inputTokens);
  return ((e.inputTokens - cached) * price.input + cached * (price.cached ?? price.input) + e.outputTokens * price.output) / 1_000_000;
}

export function summarize(
  entries: UsageEntry[],
  billing: (provider: string) => Billing,
  prices: Record<string, Price>,
  group: Group,
  /** Days back from `now`; null for all time. */
  days: number | null,
  now = Date.now(),
  names: { project?: (id: string) => string; provider?: (id: string) => string } = {},
): UsageSummary {
  const from = days === null ? -Infinity : now - days * DAY;
  const list = entries.filter((e) => Date.parse(e.at) >= from && Date.parse(e.at) <= now);
  const sum: UsageSummary = { input: 0, output: 0, cached: 0, cost: 0, unpriced: 0, days: [], rows: [] };
  const rows = new Map<string, UsageRow>();
  const perDay = new Map<string, { subscription: number; api: number; local: number; unknown: number }>();

  for (const e of list) {
    const b = billing(e.provider);
    const ref = `${e.provider}:${e.model}`;
    const cost = b === "api" ? costOf(e, prices[ref]) : null;
    sum.input += e.inputTokens;
    sum.output += e.outputTokens;
    sum.cached += e.cachedTokens;
    if (cost !== null) sum.cost += cost;
    else if (b === "api") sum.unpriced++;

    const d = dayOf(e.at);
    const slot = perDay.get(d) ?? { subscription: 0, api: 0, local: 0, unknown: 0 };
    slot[b] += e.inputTokens + e.outputTokens;
    perDay.set(d, slot);

    const key = group === "project" ? e.project : group === "design" ? `${e.project}/${e.design}` : group === "model" ? ref : d;
    const label =
      group === "project"
        ? (names.project?.(e.project) ?? e.project)
        : group === "design"
          ? `${names.project?.(e.project) ?? e.project} / ${e.design}`
          : group === "model"
            ? e.model
            : d;
    const row = rows.get(key) ?? { key, label, turns: 0, input: 0, output: 0, cached: 0, cost: null, billing: b, ...(group === "model" ? { via: names.provider?.(e.provider) ?? e.provider } : {}) };
    row.turns++;
    row.input += e.inputTokens;
    row.output += e.outputTokens;
    row.cached += e.cachedTokens;
    if (cost !== null) row.cost = (row.cost ?? 0) + cost;
    if (row.billing !== b) row.billing = "mixed";
    rows.set(key, row);
  }

  // Every day of the range, also the quiet ones, so the chart shows the gaps.
  const first = days === null ? (list.length ? Math.min(...list.map((e) => Date.parse(dayOf(e.at)))) : now) : now - (days - 1) * DAY;
  for (let t = Date.parse(new Date(first).toISOString().slice(0, 10)); t <= now; t += DAY) {
    const date = new Date(t).toISOString().slice(0, 10);
    sum.days.push({ date, ...(perDay.get(date) ?? { subscription: 0, api: 0, local: 0, unknown: 0 }) });
  }
  sum.rows = [...rows.values()].sort((a, b) => (group === "day" ? b.key.localeCompare(a.key) : b.input + b.output - (a.input + a.output)));
  return sum;
}

/** 2.41M, 618k, 950. */
export function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}
