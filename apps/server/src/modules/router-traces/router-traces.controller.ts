import { Controller, Get, Param, Query, Req } from "@nestjs/common";
import {
  detectStuckRouterTraces,
  getRouterTrace,
  listRouterOutbox,
  listRouterTraces,
  listRouterTurns,
  routerTraceMetrics,
} from "../../../../../packages/core/src/router-traces.js";
import { doctorWhatsAppRouter } from "../../../../../packages/core/src/router-doctor.js";
import {
  listConnectorOutboxJobs,
  releaseConnectorOutboxClaim,
} from "../../../../../packages/connectors/src/connector-outbox.js";
import { getWhatsAppStatus } from "../../../../../packages/connectors/src/whatsapp.js";
import { isAdminPrincipal } from "../../../../../packages/core/src/policy.js";
import { requestPrincipal } from "../../../../../packages/core/src/principal.js";
import { listThreadsForPrincipal } from "../../../../../packages/core/src/threads.js";
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
  async whatsappDoctor(@Req() request: any, @Query() query: Record<string, unknown> = {}) {
    const principal = requestPrincipal(request);
    const allowed = await allowedThreadIds(request);
    const repair = boolQuery(query.repair);
    if (repair && !isAdminPrincipal(principal)) throw httpError("admin_required_for_router_repair", 403);
    const thread = clean(query.thread || query.threadId);
    if (allowed && thread && !allowed.has(thread)) throw httpError("thread_access_denied", 403);
    const result = await doctorWhatsAppRouter({
      thread,
      routerTraceId: clean(query.trace || query.routerTraceId),
      repair,
      repairSafe: !boolQuery(query.unsafe),
      staleMs: numberQuery(query.staleMs),
      whatsappStatusFn: () => getWhatsAppStatus(),
      listConnectorOutboxJobsFn: listConnectorOutboxJobs,
      releaseConnectorOutboxClaimFn: releaseConnectorOutboxClaim,
    });
    if (!allowed) return result;
    return {
      ...result,
      checks: filterByAllowedThreads((result.checks || []) as Array<any>, allowed),
      threads: (result.threads || []).filter((item: any) => allowed.has(clean(item.threadId))),
    };
  }

  @Get("doctor/router")
  async routerDoctor(@Req() request: any, @Query() query: Record<string, unknown> = {}) {
    return this.whatsappDoctor(request, { ...query, trace: clean(query.trace || query.routerTraceId) });
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
