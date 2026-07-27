import {
  completeRuntimeLiveness,
  recordRuntimeLiveness,
  saveRuntimeCheckpoint,
} from "../../core/src/runtime-liveness.js";
import { connectorMcpStructuredResult } from "./connectors-mcp-contract.js";

function clean(value = "") {
  return String(value || "").trim();
}

function runtimeCounters(input = {}) {
  const counters = {};
  if (Number.isFinite(input.progress_current)) counters.current = input.progress_current;
  if (Number.isFinite(input.progress_total)) counters.total = input.progress_total;
  return Object.keys(counters).length ? counters : null;
}

function runtimeCheckpointPayload(input = {}) {
  const value = clean(input.checkpoint_json);
  if (!value) throw Object.assign(new Error("runtime_checkpoint_json_required"), { statusCode: 400 });
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw Object.assign(new Error("runtime_checkpoint_json_invalid"), { statusCode: 400 });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw Object.assign(new Error("runtime_checkpoint_json_object_required"), { statusCode: 400 });
  }
  return parsed;
}

export async function runConnectorMcpRuntime(input, auth, env) {
  const threadId = auth.threadId || clean(input.thread_id);
  if (!threadId) throw Object.assign(new Error("runtime_thread_id_required"), { statusCode: 400 });
  const common = {
    executionId: input.execution_id,
    runtimeGeneration: clean(input.runtime_generation),
    turnId: clean(input.turn_id),
    phase: clean(input.phase),
    summary: clean(input.summary),
    counters: runtimeCounters(input),
  };
  let payload;
  if (input.action === "checkpoint") {
    payload = await saveRuntimeCheckpoint(threadId, {
      ...common,
      checkpointId: clean(input.checkpoint_id),
      payload: runtimeCheckpointPayload(input),
    }, env);
  } else if (input.action === "complete") {
    payload = await completeRuntimeLiveness(threadId, {
      ...common,
      status: clean(input.completion_status) || "completed",
      phase: clean(input.phase) || "complete",
    }, env);
  } else {
    payload = await recordRuntimeLiveness(threadId, {
      ...common,
      evidenceType: clean(input.evidence_type) || "mcp_progress",
      phase: clean(input.phase) || (input.action === "blocked" ? "blocked" : "executing"),
    }, env);
  }
  if (!payload?.ok) {
    throw Object.assign(new Error(clean(payload?.reason) || "runtime_signal_rejected"), {
      statusCode: payload?.reason === "thread_not_found" ? 404 : 409,
    });
  }
  return connectorMcpStructuredResult({
    service: input.service,
    action: input.action,
    status: input.action === "blocked" ? "blocked" : input.action === "complete" ? clean(input.completion_status) || "completed" : "ok",
    instanceId: auth.instanceId,
    userId: auth.ownerUserId,
    threadId,
    data: payload,
  });
}
