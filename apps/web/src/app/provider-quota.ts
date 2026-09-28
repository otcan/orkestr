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
