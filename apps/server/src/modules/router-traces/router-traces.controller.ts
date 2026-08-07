import { Controller, Get, Param, Query, Req, Res } from "@nestjs/common";
import {
  detectStuckRouterTraces,
  getRouterTrace,
  listRouterOutbox,
  listRouterTraces,
  listRouterTurns,
  routerTraceMetrics,
} from "../../../../../packages/core/src/router-traces.js";
import { doctorWhatsAppRouter, routerDoctorRunEvent } from "../../../../../packages/core/src/router-doctor.js";
import {
  ensureConnectorOutboxJob,
  listConnectorOutboxJobs,
  releaseConnectorOutboxClaim,
} from "../../../../../packages/connectors/src/connector-outbox.js";
import { getWhatsAppStatus } from "../../../../../packages/connectors/src/whatsapp.js";
import { isAdminPrincipal } from "../../../../../packages/core/src/policy.js";
import { requestPrincipal } from "../../../../../packages/core/src/principal.js";
import { listThreadsForPrincipal } from "../../../../../packages/core/src/threads.js";
import { appendEvent } from "../../../../../packages/storage/src/store.js";
import { httpError } from "../../common/http.js";

function clean(value: unknown): string {
  return String(value || "").trim();
}

function boolQuery(value: unknown): boolean {
  return ["1", "true", "yes", "on"].includes(clean(value).toLowerCase());
}

async function allowedThreadIds(request: any): Promise<Set<string> | null> {
  const principal = requestPrincipal(request);
  if (isAdminPrincipal(principal)) return null;
  return new Set((await listThreadsForPrincipal(principal)).map((thread: any) => String(thread.id || "").trim()).filter(Boolean));
}

function filterByAllowedThreads<T extends { threadId?: string }>(items: T[], allowed: Set<string> | null): T[] {
  if (!allowed) return items;
  return items.filter((item) => allowed.has(clean(item.threadId)));
}

function numberQuery(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function boundedNumberQuery(value: unknown, fallback: number, max: number): number {
  const parsed = numberQuery(value, fallback);
  return Math.min(max, Math.max(1, parsed));
}

const MIN_REPAIR_TIMEOUT_MS = 5_000;

function timeoutPayload(timeoutMs: number, repair: boolean) {
  return {
    ok: false,
    status: "timeout",
    summary: `WhatsApp/router doctor did not finish within ${timeoutMs}ms.`,
    repair,
    generatedAt: new Date().toISOString(),
    counts: { threads: 0, checks: 1, errors: 1, warnings: 0, repairs: 0 },
    checks: [{
      code: "router_doctor_timeout",
      severity: "error",
      summary: "Run the doctor for a specific thread or trace, or rerun with a larger timeout during an attended diagnostic window.",
      timeoutMs,
    }],
    repairs: [],
    threads: [],
  };
}

function deadlineError(timeoutMs: number): Error {
  const error = new Error(`router_doctor_timeout_${timeoutMs}ms`);
  (error as any).name = "AbortError";
  (error as any).statusCode = 503;
  (error as any).code = "router_doctor_timeout";
  return error;
}

function isAbortError(error: any): boolean {
  return error?.name === "AbortError" || clean(error?.code) === "router_doctor_timeout";
}

async function runDoctorWithDeadline<T>(run: (signal: AbortSignal) => Promise<T>, timeoutMs: number, repair: boolean): Promise<{ result: T | ReturnType<typeof timeoutPayload>; timedOut: boolean }> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(deadlineError(timeoutMs));
  }, timeoutMs);
  try {
    return { result: await run(controller.signal), timedOut: false };
  } catch (error) {
    if (timedOut || isAbortError(error)) return { result: timeoutPayload(timeoutMs, repair), timedOut: true };
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

@Controller("api/router-traces")
export class RouterTracesController {
  @Get()
  async list(@Req() request: any, @Query() query: Record<string, unknown> = {}) {
    const allowed = await allowedThreadIds(request);
    const threadId = clean(query.threadId);
    const traces = await listRouterTraces({
      threadId,
      connector: clean(query.connector),
      phase: clean(query.phase),
      stuck: boolQuery(query.stuck),
    });
    return { traces: filterByAllowedThreads(traces, allowed) };
  }

  @Get("diagnostics")
  async diagnostics(@Req() request: any, @Query() query: Record<string, unknown> = {}) {
    const allowed = await allowedThreadIds(request);
    const stuck = filterByAllowedThreads(await detectStuckRouterTraces(), allowed);
    const metrics = await routerTraceMetrics();
    const threadId = clean(query.threadId);
    const traces = threadId
      ? filterByAllowedThreads(await listRouterTraces({ threadId }, process.env), allowed)
      : [];
    return { metrics, stuck, traces };
  }

  @Get("doctor/whatsapp")
  async whatsappDoctor(@Req() request: any, @Query() query: Record<string, unknown> = {}, @Res({ passthrough: true }) response?: any) {
    const principal = requestPrincipal(request);
    const allowed = await allowedThreadIds(request);
    const repair = boolQuery(query.repair);
    if (repair && !isAdminPrincipal(principal)) throw httpError("admin_required_for_router_repair", 403);
    const thread = clean(query.thread || query.threadId);
    if (allowed && thread && !allowed.has(thread)) throw httpError("thread_access_denied", 403);
    const timeoutMs = boundedNumberQuery(query.timeoutMs || query.timeout, 30_000, 120_000);
    if (repair && timeoutMs < MIN_REPAIR_TIMEOUT_MS) throw httpError("router_doctor_repair_timeout_too_small", 400);
    const run = (signal: AbortSignal) => doctorWhatsAppRouter({
      thread,
      routerTraceId: clean(query.trace || query.routerTraceId),
      repair,
      repairSafe: !boolQuery(query.unsafe),
      staleMs: numberQuery(query.staleMs),
      signal,
      recordRunEvent: false,
      whatsappStatusFn: () => getWhatsAppStatus(),
      ensureConnectorOutboxJobFn: ensureConnectorOutboxJob,
      listConnectorOutboxJobsFn: listConnectorOutboxJobs,
      releaseConnectorOutboxClaimFn: releaseConnectorOutboxClaim,
    });
    const { result, timedOut } = await runDoctorWithDeadline(run, timeoutMs, repair);
    if (timedOut) response?.status?.(503);
    if (!timedOut) {
      await appendEvent(routerDoctorRunEvent(result, {
        threadSelector: thread,
        routerTraceId: clean(query.trace || query.routerTraceId),
      })).catch(() => null);
    }
    if (!allowed) return result;
    return {
      ...result,
      checks: filterByAllowedThreads((result.checks || []) as Array<any>, allowed),
      threads: (result.threads || []).filter((item: any) => allowed.has(clean(item.threadId))),
    };
  }

  @Get("doctor/router")
  async routerDoctor(@Req() request: any, @Query() query: Record<string, unknown> = {}, @Res({ passthrough: true }) response?: any) {
    return this.whatsappDoctor(request, { ...query, trace: clean(query.trace || query.routerTraceId) }, response);
  }

  @Get(":routerTraceId")
  async detail(@Req() request: any, @Param("routerTraceId") routerTraceId: string) {
    const allowed = await allowedThreadIds(request);
    const trace = await getRouterTrace(routerTraceId);
    if (!trace || !filterByAllowedThreads([trace], allowed).length) return { trace: null, turns: [], outbox: [] };
    const turns = await listRouterTurns({ routerTraceId });
    const outbox = await listRouterOutbox({ routerTraceId });
    return { trace, turns, outbox };
  }
}
