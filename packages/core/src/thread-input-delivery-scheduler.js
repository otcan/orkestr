const deliveryLocks = new Set();
const deliveryTimers = new Map();
const deliveryTasks = new Map();
const closedDeliveryScopes = new Set();

function clean(value = "") {
  return String(value || "").trim();
}

function deliveryKey(scope = "", threadId = "") {
  return `${clean(scope)}\u0000${clean(threadId)}`;
}

function scopePrefix(scope = "") {
  return `${clean(scope)}\u0000`;
}

export function scheduleThreadInputDeliveryTask({ scope = "", threadId = "", delayMs = 0, task } = {}) {
  const selectedScope = clean(scope);
  const selectedThreadId = clean(threadId);
  if (!selectedScope || !selectedThreadId || typeof task !== "function" || closedDeliveryScopes.has(selectedScope)) return false;
  const key = deliveryKey(selectedScope, selectedThreadId);
  const current = deliveryTimers.get(key);
  if (current) clearTimeout(current);
  const timer = setTimeout(() => {
    deliveryTimers.delete(key);
    if (closedDeliveryScopes.has(selectedScope)) return;
    const pending = Promise.resolve().then(task).finally(() => {
      if (deliveryTasks.get(key) === pending) deliveryTasks.delete(key);
    });
    deliveryTasks.set(key, pending);
  }, Math.max(0, Number(delayMs) || 0));
  timer.unref?.();
  deliveryTimers.set(key, timer);
  return true;
}

export function acquireThreadInputDeliveryLock(scope = "", threadId = "") {
  const key = deliveryKey(scope, threadId);
  if (!clean(scope) || !clean(threadId) || deliveryLocks.has(key)) return false;
  deliveryLocks.add(key);
  return true;
}

export function releaseThreadInputDeliveryLock(scope = "", threadId = "") {
  deliveryLocks.delete(deliveryKey(scope, threadId));
}

export function resetThreadInputDeliverySchedulerForTest() {
  for (const timer of deliveryTimers.values()) clearTimeout(timer);
  deliveryTimers.clear();
  closedDeliveryScopes.clear();
}

export function activateThreadInputDeliveryScope(scope = "") {
  const selectedScope = clean(scope);
  if (selectedScope) closedDeliveryScopes.delete(selectedScope);
}

export async function closeThreadInputDeliveryScope(scope = "") {
  const selectedScope = clean(scope);
  const prefix = scopePrefix(selectedScope);
  closedDeliveryScopes.add(selectedScope);
  for (const [key, timer] of deliveryTimers.entries()) {
    if (!key.startsWith(prefix)) continue;
    clearTimeout(timer);
    deliveryTimers.delete(key);
  }
  const tasks = [...deliveryTasks.entries()]
    .filter(([key]) => key.startsWith(prefix))
    .map(([, task]) => task);
  if (tasks.length) await Promise.allSettled(tasks);
  for (const [key, timer] of deliveryTimers.entries()) {
    if (!key.startsWith(prefix)) continue;
    clearTimeout(timer);
    deliveryTimers.delete(key);
  }
  return { scope: selectedScope, timers: 0, tasks: tasks.length };
}

export function threadInputDeliveryScopeStatus(scope = "") {
  const selectedScope = clean(scope);
  const prefix = scopePrefix(selectedScope);
  return {
    scope: selectedScope,
    active: !closedDeliveryScopes.has(selectedScope),
    timers: [...deliveryTimers.keys()].filter((key) => key.startsWith(prefix)).length,
    tasks: [...deliveryTasks.keys()].filter((key) => key.startsWith(prefix)).length,
    locks: [...deliveryLocks].filter((key) => key.startsWith(prefix)).length,
  };
}
