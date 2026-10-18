// Report provenance is routing metadata, never human authority. Unclassified
// content is retained; only explicit ACKs or exact legacy ACK phrases are inert.
import { createHash } from "node:crypto";
import { appendThreadMessage, getThreadForPrincipal, listThreadMessageCandidates, listThreadMessages } from "./threads.js";
import { resourceOwnerUserId } from "./policy.js";
const clean = value => String(value || "").trim();
export function reportFingerprint(text) {
  return createHash("sha256").update(clean(text).replace(/\s+/g, " ")).digest("hex");
}
export function acknowledgementOnly(message) {
  if (message.reportKind === "ack") return true;
  if (["result", "blocked", "failed", "decision"].includes(message.reportKind)) return false;
  const text = clean(message.text).replace(/\*/g, "");
  return /^(?:DONE\s*[:—–-]?\s*)?(?:acknowledged|ack|confirmed|understood|noted|received|standing by|no (?:new )?(?:changes|updates))(?:[.!])?$/iu.test(text);
}
export async function prepareAgentReport(thread, input, principal, env = process.env) {
  const body = { ...input };
  // This API never accepts a client assertion of validated provenance.
  for (const key of ["reportSourceThreadId", "reportCauseMessageId", "reportFingerprint"]) delete body[key];
  const sourceId = clean(body.agentSourceThreadId);
  delete body.agentSourceThreadId;
  if (!sourceId) { delete body.reportKind; delete body.reportKey; return { body }; }
  const source = await getThreadForPrincipal(sourceId, principal, env);
  if (resourceOwnerUserId(source, env) !== resourceOwnerUserId(thread, env)) throw Object.assign(new Error("report_owner_mismatch"), { statusCode: 403 });
  if (source.id === thread.id) return { body };
  const related = source.parentThreadId === thread.id || thread.parentThreadId === source.id ||
    (source.parentThreadId && source.parentThreadId === thread.parentThreadId);
  if (!related) { delete body.reportKind; delete body.reportKey; return { body }; }
  const kind = clean(body.reportKind);
  if (kind && !["ack", "result", "blocked", "failed", "decision"].includes(kind)) throw Object.assign(new Error("report_kind_invalid"), { statusCode: 400 });
  const inputs = await listThreadMessageCandidates(source.id, { tailLimit: 100 }, env);
  const cause = [...inputs].reverse().find(row => row.role === "user" &&
    source.runtime?.activeTurnId && (row.codexTurnId || row.executorTurnId) === source.runtime.activeTurnId);
  Object.assign(body, { reportSourceThreadId: source.id, reportCauseMessageId: cause?.id || "",
    reportFingerprint: reportFingerprint(body.text), controlAllowed: false, originOwner: false, parseCommands: false });
  if (acknowledgementOnly(body)) {
    const message = await appendThreadMessage(thread.id, { ...body, role: "assistant", phase: "notification",
      state: "completed", visibility: "internal", source: "agent_report_ack", reportKind: "ack",
      clientMessageId: `report-ack:${source.id}:${cause?.id || "none"}:${body.reportFingerprint}`,
      dedupeAssistantByIdempotencyKey: true }, env);
    return { body, suppressed: true, suppressionReason: "agent_ack_no_dispatch", message };
  }
  // Same immutable report revision has one delivery even if CLI retries it.
  const prior = (await listThreadMessages(thread.id, env)).find(row =>
    row.role === "user" && row.reportSourceThreadId === source.id && row.reportFingerprint === body.reportFingerprint);
  if (prior && !body.reportKey) return { body, suppressed: true, suppressionReason: "agent_report_duplicate", message: { ...prior, duplicate: true } };
  body.clientMessageId = `agent-report:${source.id}:${clean(body.reportKey) || body.reportFingerprint}:${body.reportFingerprint}`;
  body.text = "[Agent report: act on new work, changed results or unresolved blockers. Do not send acknowledgements or confirmation loops. Use NO_REPLY when no action is needed.]\n\n" + body.text;
  return { body };
}
