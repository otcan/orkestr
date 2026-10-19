/** Default-disabled contract for the canonical Caddy HTTP Basic mechanism.
 * No env/file reads, hash implementation, proxy-header trust, or default scope.
 */
import type { FastifyRequest } from 'fastify';
import type { StatusPrincipal } from './canonical_scope_status.js';
export type CurrentBasicAuthority = Readonly<{
  enabled: true;
  revision: string;
  username: string;
  passwordHash: string;
  principal: StatusPrincipal;
}>;
export type BasicAuthorityDependencies = Readonly<{
  /** Must return CURRENT canonical credential + explicit status-only scope grant. */
  current: () => Promise<CurrentBasicAuthority | null>;
  /** Canonical owner must supply an audited bcrypt verifier; never plaintext equality. */
  verifyPassword: (password: string, bcryptHash: string) => Promise<boolean>;
}>;
export function createBasicCallerVerifier(deps?: BasicAuthorityDependencies) {
  return async (request: FastifyRequest): Promise<StatusPrincipal | null> => {
    if (!deps) return null;
    const raw = request.raw.rawHeaders;
    if (raw.filter((v, i) => i % 2 === 0 && v.toLowerCase() === 'authorization').length !== 1) return null;
    const header = request.headers.authorization;
    if (typeof header !== 'string' || header.length > 4096 || !/^Basic [A-Za-z0-9+/]+={0,2}$/.test(header)) return null;
    const encoded = header.slice(6);
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.toString('base64') !== encoded) return null;
    let decoded: string;
    try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return null; }
    if (/[\u0000-\u001f\u007f]/u.test(decoded)) return null;
    const split = decoded.indexOf(':');
    if (split < 1) return null;
    const username = decoded.slice(0, split), password = decoded.slice(split + 1);
    if (!password) return null;
    const before = await deps.current();
    if (!before || before.enabled !== true || !before.revision || before.username !== username ||
        !/^\$2[aby]\$\d\d\$[./A-Za-z0-9]{53}$/.test(before.passwordHash)) return null;
    // Copy before awaiting: authority may revoke/rotate while verification runs.
    const revision = before.revision, hash = before.passwordHash;
    const principal = structuredClone(before.principal);
    if (!await deps.verifyPassword(password, hash)) return null;
    const after = await deps.current();
    if (!after || after.enabled !== true || after.revision !== revision ||
        after.username !== username || after.passwordHash !== hash ||
        JSON.stringify(after.principal) !== JSON.stringify(principal)) return null;
    return principal;
  };
}
