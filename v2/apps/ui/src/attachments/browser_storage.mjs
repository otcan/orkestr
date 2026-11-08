// Browsers may throw on the storage property itself (for example in a
// restricted frame). Uploads can proceed without optional resume persistence.
export function browserStorage(name) {
  try { return globalThis[name]; }
  catch { return null; }
}
