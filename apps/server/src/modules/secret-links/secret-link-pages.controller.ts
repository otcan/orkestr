import { Body, Controller, Get, Param, Post, Req, Res } from "@nestjs/common";
import { consumeDurableRateLimit, peekDurableRateLimit, positiveIntegerEnv } from "../../../../../packages/core/src/durable-rate-limit.js";
import { keycloakOidcEnabled } from "../../../../../packages/core/src/keycloak-oidc.js";
import {
  inspectSecretLink,
  revealSecretShareLink,
  secretLinkPublicBase,
  submitSecretRequestLink,
} from "../../../../../packages/core/src/secret-links.js";
import { sameOriginFormPost } from "../../browser-page-security.js";
import { effectiveRequestOrigin } from "../../host-boundaries.js";
import { requestSourceKey } from "../../request-security.js";
import {
  endedPage,
  forbiddenOriginPage,
  invalidValuePage,
  rateLimitedPage,
  requestPromptPage,
  revealedPage,
  sharePromptPage,
  signInPage,
  submittedPage,
  unavailablePage,
} from "./secret-link-pages.js";
import { inspectVaultRequestLink, submitVaultRequestLink } from "../../../../../packages/core/src/vault-requests.js";
import { vaultRequestPromptPage, vaultStoredPage } from "./vault-request-pages.js";

// Why "/s/<token>": paths outside /api/ and /oauth/ pass the pre-pairing
// allowlist (security.js isAllowedBeforePairing), so the auth middleware still
// resolves a browser session cookie into the real principal when present and
// otherwise marks the request anonymous. Nothing else is opened up: every
// handler here requires a real, unscoped browser session (no anonymous
// fallback, machine credential, shared-app or auth-intent session) whose user
// id equals the link owner. Anonymous GETs only get a sign-in redirect.
function ownerPrincipal(request: any) {
  if (request.orkestrAnonymous === true || request.orkestrMachineAuth) return null;
  const session = request.orkestrSecuritySession;
  if (!session?.id || session.shareId) return null;
  if (Array.isArray(session.allowedActions) && session.allowedActions.length) return null;
  const principal = request.orkestrPrincipal;
  return principal?.userId ? principal : null;
}

function lookupLimit() {
  return {
    bucket: "secret-link-lookups",
    limit: positiveIntegerEnv(process.env.ORKESTR_SECRET_LINK_LOOKUP_LIMIT, 20),
    windowMs: positiveIntegerEnv(process.env.ORKESTR_SECRET_LINK_LOOKUP_WINDOW_MS, 15 * 60 * 1000, 1000),
  };
}

async function throttled(request: any) {
  const peek = await peekDurableRateLimit({ ...lookupLimit(), key: requestSourceKey(request) });
  return !peek.ok;
}

async function recordFailedLookup(request: any) {
  await consumeDurableRateLimit({ ...lookupLimit(), key: requestSourceKey(request) }).catch(() => null);
}

function postAllowed(request: any) {
  const expected = [effectiveRequestOrigin(request), new URL(secretLinkPublicBase()).origin];
  return sameOriginFormPost(request, expected);
}

function signIn(request: any, response: any, token: string) {
  if (keycloakOidcEnabled()) return signInPage(response, `/auth/login?return=${encodeURIComponent(`/s/${token}`)}`);
  return signInPage(response);
}

const valueErrors: Record<string, [number, string]> = {
  secret_value_required: [400, "The secret value is empty."],
  secret_value_too_large: [413, "The secret value is larger than 16 KiB."],
  vault_password_too_large: [413, "The password is longer than 4096 characters."],
  vault_username_too_large: [413, "The username is longer than 512 characters."],
};

@Controller("s")
export class SecretLinkPagesController {
  @Get(":token")
  async view(@Req() request: any, @Param("token") token: string, @Res() response: any) {
    const principal = ownerPrincipal(request);
    if (!principal) return signIn(request, response, token);
    if (await throttled(request)) return rateLimitedPage(response);
    const result = await inspectSecretLink(token, principal.userId);
    if (result.state === "unknown") {
      await recordFailedLookup(request);
      return unavailablePage(response);
    }
    if (result.state !== "active") return endedPage(response);
    if (result.link.kind === "vault") return vaultRequestPromptPage(response, token, await inspectVaultRequestLink(token, principal.userId));
    return result.link.kind === "request"
      ? requestPromptPage(response, token, result.link)
      : sharePromptPage(response, token, result.link);
  }

  @Post(":token/reveal")
  async reveal(@Req() request: any, @Param("token") token: string, @Res() response: any) {
    const principal = ownerPrincipal(request);
    if (!principal) return signInPage(response);
    if (!postAllowed(request)) return forbiddenOriginPage(response);
    if (await throttled(request)) return rateLimitedPage(response);
    const result = await revealSecretShareLink(token, principal.userId);
    if (result.state === "unknown") {
      await recordFailedLookup(request);
      return unavailablePage(response);
    }
    if (result.state !== "revealed") return endedPage(response);
    return revealedPage(response, result.link, result.value);
  }

  @Post(":token/submit")
  async submit(@Req() request: any, @Param("token") token: string, @Body() body: Record<string, unknown> = {}, @Res() response: any) {
    const principal = ownerPrincipal(request);
    if (!principal) return signInPage(response);
    if (!postAllowed(request)) return forbiddenOriginPage(response);
    if (await throttled(request)) return rateLimitedPage(response);
    const value = typeof body?.value === "string" ? body.value.replace(/\r\n/g, "\n") : "";
    let result: any;
    try {
      result = await submitSecretRequestLink(token, value, principal);
    } catch (error: any) {
      // Never echo the error text: only known, value-free codes are shown.
      const known = valueErrors[String(error?.message || "")];
      return invalidValuePage(response, known?.[0] || 500, known?.[1] || "The secret could not be stored.");
    }
    if (result.state === "unknown") {
      await recordFailedLookup(request);
      return unavailablePage(response);
    }
    if (result.state !== "submitted") return endedPage(response);
    return submittedPage(response, result.link);
  }

  @Post(":token/vault")
  async storeInVault(@Req() request: any, @Param("token") token: string, @Body() body: Record<string, unknown> = {}, @Res() response: any) {
    const principal = ownerPrincipal(request);
    if (!principal) return signInPage(response);
    if (!postAllowed(request)) return forbiddenOriginPage(response);
    if (await throttled(request)) return rateLimitedPage(response);
    const values = { password: typeof body?.password === "string" ? body.password : "", username: typeof body?.username === "string" ? body.username : "" };
    let result: any;
    try {
      result = await submitVaultRequestLink(token, values, principal);
    } catch (error: any) {
      const known = valueErrors[String(error?.message || "")];
      return invalidValuePage(response, known?.[0] || 500, known?.[1] || "The password could not be stored.");
    }
    if (result.state === "unknown") {
      await recordFailedLookup(request);
      return unavailablePage(response);
    }
    if (result.state !== "submitted") return endedPage(response);
    return vaultStoredPage(response, result.request);
  }
}
