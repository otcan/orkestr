import { createTimer, deleteTimer, listTimers, runTimerNow } from "../../../../packages/core/src/timers.js";
import { timerCreateSchema, timerIdSchema } from "../../../../packages/shared/src/api-schemas.js";
import { json } from "../http.js";

export async function registerTimerRoutes(app) {
  app.get("/api/timers", async (_request, reply) => {
    return json(reply, 200, { timers: await listTimers() });
  });

  app.post("/api/timers", { schema: timerCreateSchema }, async (request, reply) => {
    return json(reply, 201, { timer: await createTimer(request.body || {}) });
  });

  app.delete("/api/timers/:timerId", { schema: timerIdSchema }, async (request, reply) => {
    return json(reply, 200, { ok: await deleteTimer(request.params.timerId) });
  });

  app.post("/api/timers/:timerId/run", { schema: timerIdSchema }, async (request, reply) => {
    return json(reply, 200, { event: await runTimerNow(request.params.timerId) });
  });
}
