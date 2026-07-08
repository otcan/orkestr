import { eventStorageStatus } from "../../storage/src/store.js";

function doctorCheck(id, label, status, summary, detail = {}) {
  return {
    id,
    label,
    status,
    summary,
    severity: status === "error" ? "error" : status === "warning" ? "warning" : "info",
    ...detail,
  };
}

export async function eventStorageCheck(env = process.env) {
  try {
    const status = await eventStorageStatus(env);
    if (status.currentSize > status.maxBytes) {
      return doctorCheck("event_storage", "Event storage", "warning", `Current event log is ${status.currentSize} bytes, above the ${status.maxBytes} byte rotation threshold.`, {
        ...status,
        repair: "Rotate the event log from Ops Audit or rerun after the next event append triggers rotation.",
      });
    }
    if (status.gzipBacklog > 0) {
      return doctorCheck("event_storage", "Event storage", "warning", `${status.gzipBacklog} uncompressed event archive(s) are waiting for gzip.`, {
        ...status,
        repair: "Wait for archive compression to finish, or inspect filesystem permissions under ORKESTR_HOME.",
      });
    }
    if (status.truncationRecent) {
      return doctorCheck("event_storage", "Event storage", "warning", "Recent events include truncated oversized payloads.", {
        ...status,
        repair: "Inspect recent event producers and avoid logging large content or raw payloads.",
      });
    }
    return doctorCheck("event_storage", "Event storage", "ok", `Current event log is ${status.currentSize} bytes with ${status.archiveCount} archive(s).`, status);
  } catch (error) {
    return doctorCheck("event_storage", "Event storage", "warning", error?.message || String(error), {
      repair: "Check ORKESTR_HOME permissions and event log files.",
    });
  }
}
