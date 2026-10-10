// Field-owned writes to `thread.runtime`. Writers describe only the runtime
// fields they own; the merge happens on the latest record under the thread
// store lock, so concurrent writers (Codex notifications, Claude finalizers,
// liveness, recovery) cannot drop each other's fields.
//
// `runtime.turnGeneration` is a monotonic counter bumped whenever a write
// installs a new `activeTurnId`. A writer that captured the generation of its
// turn passes it as `turnGeneration`; once a newer turn has begun the write is
// skipped, so an old turn can never overwrite a newer turn's lifecycle state.
import { updateThread } from "./threads.js";

function clean(value) {
  return String(value || "").trim();
}

export function runtimeOf(thread) {
  return thread?.runtime && typeof thread.runtime === "object" && !Array.isArray(thread.runtime) ? thread.runtime : {};
}

export function runtimeTurnGeneration(runtimeOrThread) {
  const runtime = runtimeOrThread?.runtime !== undefined ? runtimeOf(runtimeOrThread) : (runtimeOrThread || {});
  const value = Number(runtime.turnGeneration);
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

// True when a write on behalf of a turn would clobber newer runtime state:
// - `turnGeneration`: a newer turn began after the writer's turn;
// - `turnId` with `requireActiveTurn`: another turn is currently active.
export function staleRuntimeTurnWrite(runtime = {}, guard = {}) {
  if (Number.isSafeInteger(guard.turnGeneration) && runtimeTurnGeneration(runtime) > guard.turnGeneration) return true;
  const turnId = clean(guard.turnId);
  const activeTurnId = clean(runtime.activeTurnId);
  if (guard.requireActiveTurn && turnId && activeTurnId && activeTurnId !== turnId) return true;
  return false;
}

export function mergeRuntimeFields(runtime = {}, fields = {}) {
  const next = { ...runtime, ...fields };
  const activeTurnId = clean(next.activeTurnId);
  if (activeTurnId && activeTurnId !== clean(runtime.activeTurnId)) {
    next.turnGeneration = runtimeTurnGeneration(runtime) + 1;
  } else if (runtime.turnGeneration !== undefined) {
    next.turnGeneration = runtime.turnGeneration;
  }
  return next;
}

// `build(current, runtime)` returns a thread patch whose `runtime` member
// holds only the owned runtime fields (or null to skip). A plain object is
// accepted for writers whose fields do not depend on the current record.
// Resolves to the latest thread record (unchanged when the write is skipped).
export function updateThreadRuntime(threadId, build, env = process.env, guard = {}) {
  let skipped = false;
  return updateThread(threadId, (current) => {
    const runtime = runtimeOf(current);
    if (staleRuntimeTurnWrite(runtime, guard)) {
      skipped = true;
      return null;
    }
    const patch = typeof build === "function" ? build(current, runtime) : build;
    if (!patch) {
      skipped = true;
      return null;
    }
    if (!Object.prototype.hasOwnProperty.call(patch, "runtime")) return patch;
    const { runtime: fields, ...rest } = patch;
    return { ...rest, runtime: mergeRuntimeFields(runtime, fields || {}) };
  }, env).then((thread) => (guard.withSkipped ? { thread, skipped } : thread));
}
