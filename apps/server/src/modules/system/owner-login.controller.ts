import { Body, Controller, Get, HttpCode, Post, Req, Res } from "@nestjs/common";
import {
  changeOwnerPassword,
  createOwnerLogin,
  ownerCookieHeader,
  ownerLoginStatus,
  verifyOwnerLogin,
} from "../../../../../packages/core/src/owner-login.js";
import { httpError } from "../../common/http.js";

function secureRequest(request: any): boolean {
  return Boolean(request?.secure) || String(request?.headers?.["x-forwarded-proto"] || "").split(",")[0].trim() === "https";
}

function clientKey(request: any): string {
  return String(request?.ip || request?.socket?.remoteAddress || "unknown");
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
    // prompt=false keeps the older browser-pairing flow (tests, operators who opt out).
    const prompt = String(process.env.ORKESTR_OWNER_LOGIN_PROMPT || "").trim() !== "0";
    return { configured: status.configured, signedIn, prompt, ...(signedIn ? { username: status.username } : {}) };
  }

  @Post("setup")
  @HttpCode(200)
  async setup(@Req() request: any, @Res() response: any, @Body() body: Record<string, unknown> = {}) {
    try {
      const username = String(body.username || "");
      const password = String(body.password || "");
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
