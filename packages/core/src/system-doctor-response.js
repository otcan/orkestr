import { systemDoctor } from "./system-doctor.js";

// A diagnostics page must not multiply full-store scans or hold HTTP requests
// open for their entire duration. Keep one run alive and report its real state.
export function createSystemDoctorResponder(run, { timeoutMs = 5000, cacheMs = 15000 } = {}) {
  let inFlight = null;
  let completed = null;
  let completedAt = 0;
  return async () => {
    if (completed && Date.now() - completedAt < cacheMs) return completed;
    if (!inFlight) {
      inFlight = Promise.resolve().then(run).then(result => {
        completed = result;
        completedAt = Date.now();
        return result;
      }).finally(() => { inFlight = null; });
    }
    let timer;
    try {
      return await Promise.race([
        inFlight,
        new Promise(resolve => {
          timer = setTimeout(() => resolve({
            ok: false, status: "warning", pending: true, counts: { ok: 0, warnings: 1, errors: 0 },
            summary: "System diagnostics are still running. Refresh to see the completed checks.",
            checks: [{ id: "diagnostics_pending", label: "System diagnostics", status: "warning", severity: "warning",
              summary: "Checks are still running; readiness has not yet been verified." }],
            issues: [], generatedAt: new Date().toISOString(),
          }), timeoutMs);
        }),
      ]);
    } finally { clearTimeout(timer); }
  };
}

export const systemDoctorResponse = createSystemDoctorResponder(() => systemDoctor());
