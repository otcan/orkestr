function clean(value = "") {
  return String(value || "").trim();
}

export function doctorAbortError(signal = null) {
  const reason = signal?.reason;
  const message = clean(reason?.message || reason) || "router_doctor_aborted";
  const error = new Error(message);
  error.name = "AbortError";
  error.statusCode = Number(reason?.statusCode || 503);
  error.code = clean(reason?.code) || "router_doctor_aborted";
  return error;
}

export function throwIfAborted(signal = null) {
  if (!signal?.aborted) return;
  throw doctorAbortError(signal);
}

export function abortable(promise, signal = null) {
  throwIfAborted(signal);
  if (!signal || typeof signal.addEventListener !== "function") return Promise.resolve(promise);
  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      reject(doctorAbortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
