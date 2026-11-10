// Shared, framework-free helpers for dual-provider quota display and the
// active executor label on the thread model card.

export type QuotaProvider = "codex" | "claude";

export interface ProviderQuotaEntry {
  provider?: QuotaProvider;
  fiveHourRemainingPct: number | null;
  weeklyRemainingPct: number | null;
  fiveHourResetsAt: string | null;
  weeklyResetsAt: string | null;
  fiveHourStatus?: string | null;
  weeklyStatus?: string | null;
  observedAt: string | null;
  stale: boolean;
  limited?: boolean;
  source: string | null;
}

export interface ProviderQuotaSnapshot {
  codex: ProviderQuotaEntry;
  claude: ProviderQuotaEntry;
  generatedAt?: string;
  staleAfterMs?: number;
}

type ThreadLike = Record<string, unknown> | null | undefined;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(...values: unknown[]): string {
  for (const value of values) {
    const cleaned = String(value ?? "").trim();
    if (cleaned) return cleaned;
  }
  return "";
}

export function threadExecutorProvider(thread: ThreadLike): QuotaProvider {
  const source = record(thread);
  const executor = record(source["executor"]);
  const metadata = record(executor["metadata"]);
  const claude = [source["runtimeKind"], record(source["runtime"])["runtimeKind"], executor["type"], executor["id"], metadata["runtimeKind"]]
    .some((value) => String(value ?? "").trim().toLowerCase() === "claude-code")
    || text(source["codexModelProvider"]).toLowerCase() === "anthropic";
  return claude ? "claude" : "codex";
}

export function executorLabel(provider: QuotaProvider): string {
  return provider === "claude" ? "Claude" : "Codex";
}

export function claudeModelName(thread: ThreadLike): string {
  const source = record(thread);
  const metadata = record(record(source["executor"])["metadata"]);
  return text(source["claudeModel"], metadata["claudeModel"], source["codexModel"], source["claudeModelResolved"], metadata["claudeModelResolved"]) || "Claude default";
}

export function claudeEffortLabel(thread: ThreadLike): string {
  const source = record(thread);
  const metadata = record(record(source["executor"])["metadata"]);
  return text(source["claudeEffort"], metadata["claudeEffort"], source["codexReasoningEffort"]) || "default";
}

export function quotaPercentLabel(pct: number | null | undefined, status?: string | null): string {
  if (typeof pct === "number" && Number.isFinite(pct)) return `${Math.round(pct)}%`;
  return status === "allowed" ? "ok" : "?";
}

export function quotaTone(entry: ProviderQuotaEntry | null | undefined): "ok" | "warn" | "danger" | "unknown" {
  if (!entry) return "unknown";
  if (entry.limited) return "danger";
  const values = [entry.fiveHourRemainingPct, entry.weeklyRemainingPct].filter((value): value is number => typeof value === "number");
  if (!values.length) return "unknown";
  const lowest = Math.min(...values);
  if (lowest <= 10) return "danger";
  if (lowest <= 25) return "warn";
  return "ok";
}

function resetLabel(value: string | null | undefined): string {
  const time = value ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? new Date(time).toLocaleString() : "unknown";
}

export function quotaTooltip(provider: QuotaProvider, entry: ProviderQuotaEntry | null | undefined): string {
  const name = executorLabel(provider);
  if (!entry || (entry.observedAt === null && entry.fiveHourRemainingPct === null && entry.weeklyRemainingPct === null && !entry.limited)) {
    return `${name}: no quota observed yet`;
  }
  return [
    `${name} remaining`,
    `5h: ${quotaPercentLabel(entry.fiveHourRemainingPct, entry.fiveHourStatus)} (resets ${resetLabel(entry.fiveHourResetsAt)})`,
    `Week: ${quotaPercentLabel(entry.weeklyRemainingPct, entry.weeklyStatus)} (resets ${resetLabel(entry.weeklyResetsAt)})`,
    `Observed: ${entry.observedAt ? resetLabel(entry.observedAt) : "unknown"}${entry.stale ? " (stale)" : ""}`,
    ...(entry.limited ? ["Account is currently rate limited"] : []),
  ].join("\n");
}

// Host-page quota view ---------------------------------------------------
// The Host page shows a fuller card per provider than the compact header
// chip. These framework-free helpers classify each provider into exactly one
// of three states and format countdown/freshness strings so the view never
// invents a 0% or 100% when telemetry is absent or stale.

export type QuotaState = "normal" | "limited" | "unknown";

function numericRemaining(entry: ProviderQuotaEntry): number[] {
  return [entry.fiveHourRemainingPct, entry.weeklyRemainingPct]
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
}

// "unknown" when no telemetry is present or the newest reading is stale;
// "limited" when the account is rate limited or any window is fully consumed;
// "normal" otherwise. Stale readings are treated as unknown so the view does
// not present an aged number as the current state.
export function quotaState(entry: ProviderQuotaEntry | null | undefined): QuotaState {
  if (!entry) return "unknown";
  const hasData = entry.observedAt !== null
    || entry.fiveHourRemainingPct !== null
    || entry.weeklyRemainingPct !== null
    || Boolean(entry.limited);
  if (!hasData || entry.stale) return "unknown";
  if (entry.limited) return "limited";
  const values = numericRemaining(entry);
  if (values.length && Math.min(...values) <= 0) return "limited";
  return "normal";
}

export function quotaStateLabel(state: QuotaState): string {
  if (state === "limited") return "At limit";
  if (state === "unknown") return "No data";
  return "Available";
}

// Time until a window resets: "2d23h", "1h30", "45m"; empty when unknown.
export function quotaCountdownLabel(resetsAt: string | null | undefined, now: number = Date.now()): string {
  const at = resetsAt ? Date.parse(resetsAt) : NaN;
  if (!Number.isFinite(at)) return "";
  const minutes = Math.max(0, Math.round((at - now) / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return `${days}d${hours}h`;
  if (hours > 0) return `${hours}h${String(mins).padStart(2, "0")}`;
  return `${mins}m`;
}

// How long ago the telemetry was observed: "just now", "12m ago", "3h ago",
// "2d ago"; "never" when the provider has never reported.
export function quotaFreshnessLabel(entry: ProviderQuotaEntry | null | undefined, now: number = Date.now()): string {
  const observedAt = entry?.observedAt;
  if (!observedAt) return "never";
  const at = Date.parse(observedAt);
  if (!Number.isFinite(at)) return "unknown";
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
