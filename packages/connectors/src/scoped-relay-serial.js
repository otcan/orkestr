// Serialize the same durable input without blocking unrelated thread reads.
export function createKeyedSerial() {
  const pending = new Map();
  return async (key, work) => {
    const previous = pending.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(work);
    pending.set(key, current);
    try { return await current; }
    finally { if (pending.get(key) === current) pending.delete(key); }
  };
}
