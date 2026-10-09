// Process-wide perf recording for the server: one log writer and in-flight
// counter shared by the request middleware and the health sampler.
// ORKESTR_PERF_LOG=0 turns both off.
import { createHealthSampler } from "./perf-health-sampler.js";
import { createInflightTracker, createPerfLogWriter, createPerfRequestLogMiddleware, perfLogEnabled } from "./perf-log.js";

let recorder = null;

function ensureRecorder(env) {
  if (!recorder) {
    const writer = createPerfLogWriter(env);
    const tracker = createInflightTracker();
    recorder = { writer, tracker, sampler: null, middleware: createPerfRequestLogMiddleware(writer, { tracker }) };
  }
  return recorder;
}

export function perfRequestLogMiddleware(env = process.env) {
  if (!perfLogEnabled(env)) return (_request, _response, next) => next();
  return ensureRecorder(env).middleware;
}

export function startPerfHealthSampling(env = process.env) {
  if (!perfLogEnabled(env)) return;
  const active = ensureRecorder(env);
  if (active.sampler) return;
  active.sampler = createHealthSampler(env, { writer: active.writer, inflight: active.tracker.current });
  active.sampler.start();
}

export async function stopPerfRecording() {
  if (!recorder) return;
  const active = recorder;
  recorder = null;
  active.sampler?.stop();
  await active.writer.close();
}
