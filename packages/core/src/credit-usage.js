import path from "node:path";
import { dataPaths, ensureDataDirs } from "../../storage/src/paths.js";
import { appendEvent, readJson, writeJson } from "../../storage/src/store.js";
import { normalizeUserId } from "./users.js";

const defaultUsdPerMillionTokens = {
  "gpt-5-mini": { input: 0.25, cachedInput: 0.025, output: 2.0 },
  "gpt-5-nano": { input: 0.05, cachedInput: 0.005, output: 0.4 },
  "gpt-5": { input: 1.25, cachedInput: 0.125, output: 10.0 },
  "gpt-4.1-mini": { input: 0.4, cachedInput: 0.1, output: 1.6 },
  "gpt-4.1-nano": { input: 0.1, cachedInput: 0.025, output: 0.4 },
  "gpt-4o-mini": { input: 0.15, cachedInput: 0.075, output: 0.6 },
};

function nowIso() {
  return new Date().toISOString();
}

function usagePath(env = process.env) {
  return path.join(dataPaths(env).home, "credit-usage.json");
}

function parseJsonMap(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function cents(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? Math.round(parsed * 1_000_000) / 1_000_000 : 0;
}

function datePrefix(days = 0) {
  const date = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return date.toISOString().slice(0, 10);
}

function monthPrefix() {
  return new Date().toISOString().slice(0, 7);
}

function modelPrice(model = "", env = process.env) {
  const configured = parseJsonMap(env.ORKESTR_OPENAI_MODEL_PRICES_JSON);
  const key = String(model || "").trim();
  const exact = configured[key] || defaultUsdPerMillionTokens[key];
  if (exact) return exact;
  const family = Object.keys(defaultUsdPerMillionTokens).find((prefix) => key === prefix || key.startsWith(`${prefix}-`));
  return family ? defaultUsdPerMillionTokens[family] : { input: 0, cachedInput: 0, output: 0 };
}

export function estimateOpenAICost(record = {}, env = process.env) {
  const usage = record.usage || record;
  const inputTokens = Number(usage.input_tokens ?? usage.inputTokens ?? 0) || 0;
  const outputTokens = Number(usage.output_tokens ?? usage.outputTokens ?? 0) || 0;
  const cachedTokens = Number(usage.input_tokens_details?.cached_tokens ?? usage.cachedInputTokens ?? 0) || 0;
  const billableInputTokens = Math.max(0, inputTokens - cachedTokens);
  const price = modelPrice(record.model || usage.model || "", env);
  return cents(
    (billableInputTokens / 1_000_000) * Number(price.input || 0) +
    (cachedTokens / 1_000_000) * Number(price.cachedInput ?? price.input ?? 0) +
    (outputTokens / 1_000_000) * Number(price.output || 0),
  );
}

async function readLedger(env = process.env) {
  await ensureDataDirs(env);
  const payload = await readJson(usagePath(env), { records: [] });
  return {
    records: Array.isArray(payload?.records) ? payload.records : [],
  };
}

async function writeLedger(ledger, env = process.env) {
  await writeJson(usagePath(env), {
    records: Array.isArray(ledger?.records) ? ledger.records.slice(-20_000) : [],
    updatedAt: nowIso(),
  });
}

export async function listCreditUsageRecords(env = process.env) {
  return (await readLedger(env)).records;
}

export function tenantBudgetConfig(tenantId = "", env = process.env) {
  const budgets = parseJsonMap(env.ORKESTR_API_AGENT_TENANT_BUDGETS_JSON);
  const tenant = budgets[normalizeUserId(tenantId)] || {};
  return {
    dailyUsd: numberOrNull(tenant.dailyUsd ?? tenant.daily ?? env.ORKESTR_API_AGENT_DAILY_BUDGET_USD),
    monthlyUsd: numberOrNull(tenant.monthlyUsd ?? tenant.monthly ?? env.ORKESTR_API_AGENT_MONTHLY_BUDGET_USD),
    warningUsd: numberOrNull(tenant.warningUsd ?? tenant.warning ?? env.ORKESTR_API_AGENT_WARNING_BUDGET_USD),
  };
}

export function summarizeCreditUsage(records = [], options = {}) {
  const tenantId = normalizeUserId(options.tenantId || "");
  const today = datePrefix();
  const month = monthPrefix();
  const filtered = tenantId ? records.filter((record) => normalizeUserId(record.tenantId || "") === tenantId) : records;
  const totalUsd = filtered.reduce((sum, record) => sum + Number(record.estimatedCostUsd || 0), 0);
  const todayUsd = filtered
    .filter((record) => String(record.createdAt || "").startsWith(today))
    .reduce((sum, record) => sum + Number(record.estimatedCostUsd || 0), 0);
  const monthUsd = filtered
    .filter((record) => String(record.createdAt || "").startsWith(month))
    .reduce((sum, record) => sum + Number(record.estimatedCostUsd || 0), 0);
  const byModel = {};
  for (const record of filtered) {
    const model = String(record.model || "unknown").trim() || "unknown";
    byModel[model] = cents(Number(byModel[model] || 0) + Number(record.estimatedCostUsd || 0));
  }
  return {
    tenantId: tenantId || null,
    totalUsd: cents(totalUsd),
    todayUsd: cents(todayUsd),
    monthUsd: cents(monthUsd),
    byModel,
    count: filtered.length,
    recent: filtered.slice(-25).reverse(),
    generatedAt: nowIso(),
  };
}

export async function creditUsageSummary(options = {}, env = process.env) {
  const tenantId = normalizeUserId(options.tenantId || "");
  const records = await listCreditUsageRecords(env);
  const summary = summarizeCreditUsage(records, { tenantId });
  const budget = tenantBudgetConfig(tenantId, env);
  return {
    ...summary,
    budget,
    remainingDailyUsd: budget.dailyUsd === null ? null : cents(budget.dailyUsd - summary.todayUsd),
    remainingMonthlyUsd: budget.monthlyUsd === null ? null : cents(budget.monthlyUsd - summary.monthUsd),
  };
}

export async function assertCreditBudget(tenantId = "", estimatedCostUsd = 0, env = process.env) {
  const summary = await creditUsageSummary({ tenantId }, env);
  const projectedDaily = Number(summary.todayUsd || 0) + Number(estimatedCostUsd || 0);
  const projectedMonthly = Number(summary.monthUsd || 0) + Number(estimatedCostUsd || 0);
  if (summary.budget.dailyUsd !== null && projectedDaily > summary.budget.dailyUsd) {
    const error = new Error("api_agent_daily_budget_exceeded");
    error.statusCode = 402;
    error.summary = summary;
    throw error;
  }
  if (summary.budget.monthlyUsd !== null && projectedMonthly > summary.budget.monthlyUsd) {
    const error = new Error("api_agent_monthly_budget_exceeded");
    error.statusCode = 402;
    error.summary = summary;
    throw error;
  }
  return summary;
}

export async function recordCreditUsage(input = {}, env = process.env) {
  const now = nowIso();
  const record = {
    id: String(input.id || `${now}:${Math.random().toString(16).slice(2)}`),
    tenantId: normalizeUserId(input.tenantId || input.ownerUserId || ""),
    threadId: String(input.threadId || ""),
    messageId: String(input.messageId || ""),
    responseId: String(input.responseId || ""),
    runtimeKind: String(input.runtimeKind || "api-agent"),
    sourceChannel: String(input.sourceChannel || ""),
    callKind: String(input.callKind || "assistant"),
    model: String(input.model || ""),
    inputTokens: Number(input.inputTokens ?? input.usage?.input_tokens ?? 0) || 0,
    outputTokens: Number(input.outputTokens ?? input.usage?.output_tokens ?? 0) || 0,
    cachedInputTokens: Number(input.cachedInputTokens ?? input.usage?.input_tokens_details?.cached_tokens ?? 0) || 0,
    toolCallCount: Number(input.toolCallCount || 0) || 0,
    estimatedCostUsd: cents(input.estimatedCostUsd ?? estimateOpenAICost(input, env)),
    status: String(input.status || "completed"),
    error: String(input.error || ""),
    createdAt: String(input.createdAt || now),
  };
  const ledger = await readLedger(env);
  if (record.responseId && ledger.records.some((existing) => existing.responseId === record.responseId && existing.callKind === record.callKind)) {
    return record;
  }
  ledger.records.push(record);
  await writeLedger(ledger, env);
  await appendEvent({
    type: "openai_credit_usage_recorded",
    tenantId: record.tenantId,
    threadId: record.threadId,
    messageId: record.messageId,
    model: record.model,
    estimatedCostUsd: record.estimatedCostUsd,
    status: record.status,
  }, env).catch(() => {});
  return record;
}
