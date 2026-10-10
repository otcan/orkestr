// Runs tasks that share a key strictly one after another, in submission order,
// while tasks with different keys (or no key) run concurrently. A failing task
// does not break the chain for later tasks with the same key.
export function createKeyedSerialQueue() {
  const tails = new Map();
  return {
    run(key, task) {
      if (!key) return Promise.resolve().then(() => task());
      const previous = tails.get(key) || Promise.resolve();
      const result = previous.then(() => task());
      const tail = result.then(() => {}, () => {});
      tails.set(key, tail);
      void tail.then(() => {
        if (tails.get(key) === tail) tails.delete(key);
      });
      return result;
    },
    size() {
      return tails.size;
    },
  };
}
