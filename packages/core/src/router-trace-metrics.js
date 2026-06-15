import { dataPaths } from "../../storage/src/paths.js";
import { readJson } from "../../storage/src/store.js";
import { listRouterTraces } from "./router-traces.js";

const failurePhases = new Set(["runtime_failed", "mirror_failed"]);

function clean(value) {
  return String(value || "").trim();
}

function normalizeStore(raw = {}) {
  return {
    turns: Array.isArray(raw?.turns) ? raw.turns : [],
    outbox: Array.isArray(raw?.outbox) ? raw.outbox : [],
    updatedAt: clean(raw?.updatedAt),
  };
}

export async function routerTraceMetrics(env = process.env) {
  const store = normalizeStore(await readJson(dataPaths(env).routerTraces, { turns: [], outbox: [] }));
  const traces = await listRouterTraces({}, env);
  return {
    traces: traces.length,
    turns: store.turns.length,
    outbox: store.outbox.length,
    stuck: traces.filter((trace) => trace.diagnostics?.stuck === true).length,
    failed: traces.filter((trace) => failurePhases.has(trace.currentPhase)).length,
    terminal: traces.filter((trace) => trace.terminal === true).length,
    updatedAt: store.updatedAt || "",
  };
}
