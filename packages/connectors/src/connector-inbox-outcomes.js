import crypto from "node:crypto";

export const connectorInboxOutcomes = [
  "accepted",
  "rejected_terminal",
  "retryable_failure",
  "duplicate_accepted",
  "duplicate_rejected",
];

function clean(value = "") {
  return String(value || "").trim();
}

function explicitRetryable(payload = {}) {
  if (typeof payload?.routingFailure?.retryable === "boolean") return payload.routingFailure.retryable;
  if (typeof payload?.retryable === "boolean") return payload.retryable;
  return null;
}

function retryableStatus(status = 0) {
  return status === 408 || status === 425 || status === 429 || status >= 500 || status === 0;
}

export function classifyConnectorInboxDelivery({ response = null, payload = {}, error = null } = {}) {
  const status = Number(response?.status || error?.statusCode || 0) || 0;
  const failureCode = clean(payload?.routingFailure?.code || payload?.error || error?.message);
  const retryable = explicitRetryable(payload) ?? retryableStatus(status);
  const declaredOutcome = clean(payload?.outcome);
  const duplicateRejected = declaredOutcome === "duplicate_rejected" || payload?.duplicateRejected === true || (payload?.duplicate === true && payload?.rejected === true);
  const rejected = duplicateRejected || declaredOutcome === "rejected_terminal";
  if (response?.ok && payload?.ok !== false && !rejected) {
    return {
      state: "delivered",
      outcome: payload?.duplicate === true ? "duplicate_accepted" : "accepted",
      retryable: false,
      status,
      failureCode: "",
    };
  }
  if (rejected || retryable === false) {
    return {
      state: "rejected_terminal",
      outcome: duplicateRejected ? "duplicate_rejected" : "rejected_terminal",
      retryable: false,
      status,
      failureCode: failureCode || "connector_inbound_rejected",
    };
  }
  return {
    state: "failed_retryable",
    outcome: "retryable_failure",
    retryable: true,
    status,
    failureCode: failureCode || "connector_inbound_delivery_failed",
  };
}

export function duplicateConnectorInboxOutcome(event = {}) {
  const rejected = event.state === "rejected_terminal" || ["rejected_terminal", "duplicate_rejected"].includes(clean(event.outcome));
  return rejected ? "duplicate_rejected" : "duplicate_accepted";
}

export function connectorInboxEventIsTerminal(event = {}) {
  return ["delivered", "rejected_terminal", "dead_letter"].includes(clean(event.state));
}

export function connectorInboxReplayEventId(sourceEventId = "", replayId = "") {
  const source = clean(sourceEventId);
  const replay = clean(replayId);
  if (!source) throw Object.assign(new Error("connector_inbox_replay_source_required"), { statusCode: 400 });
  if (!replay) throw Object.assign(new Error("connector_inbox_replay_id_required"), { statusCode: 400 });
  const digest = crypto.createHash("sha256").update(`${source}\n${replay}`).digest("hex").slice(0, 24);
  return `${source}:replay:${digest}`;
}
