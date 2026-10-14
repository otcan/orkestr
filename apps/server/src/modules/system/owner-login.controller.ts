import { Body, Controller, Get, HttpCode, Post, Req, Res } from "@nestjs/common";
import {
  changeOwnerPassword,
  createOwnerLogin,
  ownerCookieHeader,
  ownerLoginStatus,
  verifyOwnerLogin,
} from "../../../../../packages/core/src/owner-login.js";
import { httpError } from "../../common/http.js";
import { requestSourceKey } from "../../request-security.js";
import { ownerSetupOpenToAnonymous, securityStatus } from "../../../../../packages/core/src/security.js";
import { isAdminPrincipal } from "../../../../../packages/core/src/policy.js";
import { requestPrincipal } from "../../../../../packages/core/src/principal.js";

function secureRequest(request: any): boolean {
  return Boolean(request?.secure) || String(request?.headers?.["x-forwarded-proto"] || "").split(",")[0].trim() === "https";
}

// Same source identity as other throttles: the socket peer, or the address a
// trusted proxy appended to X-Forwarded-For (never a client-supplied entry).
function clientKey(request: any): string {
  return requestSourceKey(request, process.env);
}

function sendJson(response: any, status: number, body: unknown, cookie = "") {
  if (cookie) response.setHeader("set-cookie", cookie);
  response.status(status).type("application/json; charset=utf-8").send(JSON.stringify(body));
}

function fail(response: any, error: any) {
  sendJson(response, Number(error?.statusCode || 500), { ok: false, error: String(error?.message || "owner_login_failed") });
}

// The owner's own login: the first visitor picks a username and password
// (setup only works while no owner exists), later visits sign in.
@Controller("api/auth/owner")
export class OwnerLoginController {
  @Get()
  async status(@Req() request: any) {
    const status = await ownerLoginStatus(process.env);
    const signedIn = request?.orkestrSecuritySession?.authProvider === "owner-password";
    const enabled = String(process.env.ORKESTR_OWNER_LOGIN_PROMPT || "").trim() !== "0";
    // prompt: show the login page (sign in) or offer to create one. Creating is
    // only offered where setup() would accept it.
    const prompt = enabled && (status.configured || await this.setupAllowed(request));
    return { configured: status.configured, signedIn, prompt, ...(signedIn ? { username: status.username } : {}) };
  }

  // Fresh install: anyone may create the first login (owner's choice). Existing
  // installs: only a signed-in admin (paired browser or identity provider).
  private async setupAllowed(request: any): Promise<boolean> {
    if (String(process.env.ORKESTR_OWNER_LOGIN_PROMPT || "").trim() === "0") return false;
    if (await ownerSetupOpenToAnonymous(process.env)) return true;
    // Without any sign-in (local install) every visitor is already the admin.
    if (!(await securityStatus(process.env)).authEnabled) return true;
    const session = request?.orkestrSecuritySession;
    return Boolean(session?.id) && !request?.orkestrAnonymous && isAdminPrincipal(requestPrincipal(request));
  }

  @Post("setup")
  @HttpCode(200)
  async setup(@Req() request: any, @Res() response: any, @Body() body: Record<string, unknown> = {}) {
    try {
      const username = String(body.username || "");
      const password = String(body.password || "");
      if (!(await this.setupAllowed(request))) throw Object.assign(new Error("owner_setup_closed"), { statusCode: 403 });
      await createOwnerLogin({ username, password }, process.env);
      const { token } = await verifyOwnerLogin({ username, password, clientKey: clientKey(request) }, process.env);
      sendJson(response, 200, { ok: true, username: username.trim() }, ownerCookieHeader(token, { secure: secureRequest(request) }));
    } catch (error) {
      fail(response, error);
    }
  }

  @Post("login")
  @HttpCode(200)
  async login(@Req() request: any, @Res() response: any, @Body() body: Record<string, unknown> = {}) {
    try {
      const { token, payload } = await verifyOwnerLogin({ username: String(body.username || ""), password: String(body.password || ""), clientKey: clientKey(request) }, process.env);
      sendJson(response, 200, { ok: true, username: payload.sub }, ownerCookieHeader(token, { secure: secureRequest(request) }));
    } catch (error) {
      fail(response, error);
    }
  }

  @Post("password")
  @HttpCode(200)
  async password(@Req() request: any, @Body() body: Record<string, unknown> = {}) {
    if (request?.orkestrSecuritySession?.authProvider !== "owner-password") throw httpError("owner_session_required", 401);
    await changeOwnerPassword({ currentPassword: String(body.currentPassword || ""), newPassword: String(body.newPassword || "") }, process.env);
    return { ok: true, signInAgain: true };
  }
}
