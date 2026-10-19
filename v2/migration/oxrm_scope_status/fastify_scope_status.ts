/** Unregistered canonical transport adapter. The verifier owns credential authority. */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { createScopeStatus, SCOPE_STATUS_PATH } from "./canonical_scope_status.js";
import type { StatusDependencies, StatusPrincipal } from "./canonical_scope_status.js";

export type CanonicalCallerVerifier = (request: FastifyRequest) => Promise<StatusPrincipal | null>;
export function registerScopeStatus(
  app: FastifyInstance,
  dependencies: Omit<StatusDependencies, "authenticate">,
  verifyCurrentCaller: CanonicalCallerVerifier,
): void {
  if (typeof verifyCurrentCaller !== "function") throw new TypeError("canonical_caller_verifier_required");
  app.get(SCOPE_STATUS_PATH, async (request, reply) => {
    // Closure retains the actual framework request for BOTH checks. No projection
    // of claimed headers, query identities, registry rows or local transport trust.
    const handle = createScopeStatus({ ...dependencies,
      authenticate: () => verifyCurrentCaller(request),
    });
    const result = await handle({ method: request.method, url: request.raw.url ?? "",
      body: request.body });
    return reply.code(result.statusCode).headers(result.headers).send(result.body);
  });
}
