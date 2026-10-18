// Synthetic only; no production fallback and no second task database.
export function fakeMemoryStore({ ownerUserId = "owner-fixture", projects = ["project-alpha", "project-beta"], tasks = { "task-alpha": "project-alpha" }, rows = [] } = {}) {
  let data = new Map(rows.map(row => [row.id, structuredClone(row)]));
  let calls = 0;
  return {
    ownerUserId,
    get calls() { return calls; },
    rows() { return structuredClone([...data.values()]); },
    transaction(fn) {
      calls++;
      const copy = structuredClone(data);
      const result = fn({
        get: id => structuredClone(copy.get(id) || null),
        findByIdempotencyKey: key => structuredClone([...copy.values()].find(row => row.idempotency_key === key) || null),
        list: () => structuredClone([...copy.values()]),
        insert(row) {
          if (copy.has(row.id) || [...copy.values()].some(existing => row.idempotency_key && existing.idempotency_key === row.idempotency_key)) throw Error("fixture_unique_constraint");
          copy.set(row.id, structuredClone(row));
        },
        replace(id, row) { if (!copy.has(id)) throw Error("fixture_missing"); copy.set(id, structuredClone(row)); },
        delete: id => copy.delete(id),
        hasProject: id => projects.includes(id),
        taskProjectId: id => tasks[id] || null,
      });
      data = copy;
      return result;
    },
  };
}

export const memoryOwnerRequest = Object.freeze({ orkestrPrincipal: { kind: "user", role: "admin", userId: "owner-fixture" } });
export const memorySource = Object.freeze({ sourceKind: "owner", actorId: "owner-fixture", origin: "web", capturedAt: "2026-01-01T00:00:00.000Z" });
export function memoryInput(extra = {}) {
  return { category: "fact", scope: { kind: "owner", id: null }, content: { statement: "Synthetic favorite color is teal." }, source: memorySource, idempotencyKey: "save-fixture", ...extra };
}
