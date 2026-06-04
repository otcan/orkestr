import { Controller, Get, Param, Query, Req } from "@nestjs/common";
import {
  detectStuckRouterTraces,
  getRouterTrace,
  listRouterOutbox,
  listRouterTraces,
  listRouterTurns,
  routerTraceMetrics,
} from "../../../../../packages/core/src/router-traces.js";
import { isAdminPrincipal } from "../../../../../packages/core/src/policy.js";
import { requestPrincipal } from "../../../../../packages/core/src/principal.js";
import { listThreadsForPrincipal } from "../../../../../packages/core/src/threads.js";

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
