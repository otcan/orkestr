// Capability vocabulary for the provider adapter conformance suite.
//
// A harness declares the capabilities its adapter supports. Each conformance
// check names the capability it exercises; checks for capabilities marked
// `required` must pass for every adapter, the rest are skipped (and reported as
// skipped) when the harness does not declare them.

export const CAPABILITIES = Object.freeze({
  "turn.start": {
    required: true,
    description: "Start a turn for a session and receive a stable turn id.",
  },
  "turn.final_output": {
    required: true,
    description: "Return a structured final result: { turnId, status, output: { text }, error }.",
  },
  "turn.streaming": {
    required: false,
    description: "Emit at least one progress event before the final output event.",
  },
  "turn.cancel": {
    required: false,
    description: "Cancel an active turn; the turn settles as cancelled and emits no late final output.",
  },
  "session.resume": {
    required: false,
    description: "After a process restart the same provider session is resumed, not recreated.",
  },
  "input.idempotent": {
    required: false,
    description: "Re-delivering the same input id runs the provider at most once and returns the original turn's outcome.",
  },
  "tools.approval": {
    required: false,
    description: "A tool-permission hook is consulted before a tool runs; deny blocks it, approve runs it.",
  },
  "errors.auth": {
    required: false,
    description: "Authentication/credential failures are classified as `auth`.",
  },
  "errors.transient": {
    required: false,
    description: "Retryable failures (rate limit, overload, disconnect) are classified as `transient`.",
  },
  "errors.permanent": {
    required: false,
    description: "Non-retryable failures (invalid request, crash) are classified as `permanent`.",
  },
});

export const CAPABILITY_NAMES = Object.freeze(Object.keys(CAPABILITIES));
export const REQUIRED_CAPABILITIES = Object.freeze(CAPABILITY_NAMES.filter((name) => CAPABILITIES[name].required));
export const ERROR_CLASSES = Object.freeze(["auth", "transient", "permanent"]);
export const TURN_STATUSES = Object.freeze(["completed", "failed", "cancelled"]);

export function normalizeCapabilities(declared = []) {
  const set = new Set(Array.isArray(declared) ? declared : [...(declared || [])]);
  const unknown = [...set].filter((name) => !CAPABILITIES[name]);
  if (unknown.length) throw new Error(`unknown conformance capabilities: ${unknown.join(", ")}`);
  return set;
}
