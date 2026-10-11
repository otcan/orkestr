// Run guards for due timers: one due-timer pass at a time per Orkestr home, and
// exponential backoff after a failed run so a broken timer does not retry on
// every loop tick.
import { appHome } from "../../storage/src/paths.js";

const passes = new Map();

// Serializes due-timer passes for the same ORKESTR_HOME within this process.
// A pass that starts while another is running waits for it, then re-reads the
// timers, so a check-in that the first pass delivered is no longer due.
export function withDueTimerPass(env, run) {
  const key = appHome(env);
  const previous = passes.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(run);
  const tail = current.catch(() => {});
  passes.set(key, tail);
  tail.then(() => { if (passes.get(key) === tail) passes.delete(key); });
  return current;
}

const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 60 * 60_000;

// failureCount is the count after this failure (1 for the first failure).
export function timerRetryAt(failureCount, now = new Date()) {
  const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, Number(failureCount || 1) - 1));
  return new Date(now.getTime() + delay).toISOString();
}

export function timerWaitingForRetry(timer, now = new Date()) {
  const retryMs = Date.parse(String(timer?.retryAt || ""));
  return Number.isFinite(retryMs) && retryMs > now.getTime();
}
