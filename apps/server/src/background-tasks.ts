// Background work the server starts without awaiting (startup pumps, interval
// runs) writes into ORKESTR_HOME. Shutdown must wait for whatever is still in
// flight before reporting the server closed, so callers (tests, restarts) can
// safely remove or reuse that state. The wait is bounded so one stuck task
// cannot block shutdown forever.
export function createBackgroundTasks() {
  const pending = new Set<Promise<unknown>>();
  return {
    track<T>(task: Promise<T>): Promise<T> {
      pending.add(task);
      task.then(() => pending.delete(task), () => pending.delete(task));
      return task;
    },
    get size() {
      return pending.size;
    },
    async drain(timeoutMs = 10_000) {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), timeoutMs); });
      try {
        // Tasks started while draining (none once intervals are cleared) are included.
        while (pending.size) {
          const result = await Promise.race([Promise.allSettled([...pending]), timeout]);
          if (result === "timeout") return { drained: false, pending: pending.size };
        }
        return { drained: true, pending: 0 };
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}
