import { Body, Controller, Delete, Get, Header, HttpCode, Param, Post, Query, Req } from "@nestjs/common";
import {
  deleteSecureSecret,
  listSecureInputRequests,
  listSecureSecrets,
  setSecureSecret,
} from "../../../../../packages/core/src/secure-secrets.js";
import { requestPrincipal } from "../../../../../packages/core/src/principal.js";

function clean(value: unknown): string {
  return String(value || "").trim();
}

function secretTarget(body: Record<string, unknown> = {}, query: Record<string, unknown> = {}) {
  const scope = clean(body.scope || query.scope || (body.global === true || query.global === "1" ? "global" : "user"));
  return {
    scope: scope === "global" ? "global" : "user",
    ownerUserId: clean(body.userId || body.ownerUserId || query.userId || query.ownerUserId),
  };
}

@Controller("api/secure-input")
export class SecureInputController {
  @Get("secrets")
  @Header("X-Orkestr-Secure-Input", "noMirror,noCapture,noCodexContext,noScreenshot")
  async list(@Req() request: any, @Query() query: Record<string, unknown> = {}) {
    const principal = requestPrincipal(request);
    return listSecureSecrets(secretTarget({}, query), principal);
  }

  @Get("requests")
  @Header("X-Orkestr-Secure-Input", "noMirror,noCapture,noCodexContext,noScreenshot")
  async requests(@Req() request: any, @Query() query: Record<string, unknown> = {}) {
    const principal = requestPrincipal(request);
    return listSecureInputRequests(secretTarget({}, query), principal);
  }

  @Post("secrets")
  @HttpCode(200)
  @Header("X-Orkestr-Secure-Input", "noMirror,noCapture,noCodexContext,noScreenshot")
  async set(@Req() request: any, @Body() body: Record<string, unknown> = {}) {
    const principal = requestPrincipal(request);
    return setSecureSecret({
      ...secretTarget(body),
      name: clean(body.name || body.secretName || body.handle),
      value: String(body.value ?? body.secret ?? ""),
    }, principal);
  }

  @Delete("secrets/:name")
  @Header("X-Orkestr-Secure-Input", "noMirror,noCapture,noCodexContext,noScreenshot")
  async delete(@Req() request: any, @Param("name") name: string, @Query() query: Record<string, unknown> = {}) {
    const principal = requestPrincipal(request);
    return deleteSecureSecret({
      ...secretTarget({}, query),
      name,
    }, principal);
  }
}
