// Runs work for the same key one call after another, in this process.
// WhatsApp inbound routing uses it per event id, so concurrent redeliveries of
// one message cannot both pass the duplicate check on the same state snapshot.
const locks = new Map();

export async function withInboundRouteLock(key = "", work = async () => null) {
  if (!key) return work();
  const previous = locks.get(key);
  const run = (previous ? previous.catch(() => {}) : Promise.resolve()).then(() => work());
  locks.set(key, run);
  try {
    return await run;
  } finally {
    if (locks.get(key) === run) locks.delete(key);
  }
}
