import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, Res } from "@nestjs/common";
import { BrowsersController } from "../browsers/browsers.controller.js";
import { agentThreadIdFromRequest } from "../../../../../packages/core/src/vault-access.js";
import {
  agentPasswordHandoffStatus,
  endPasswordHandoff,
  listOwnerPasswordHandoffs,
  ownerHandoffDesktopAccess,
  ownerPasswordHandoffStatus,
  ownerPasswordHandoffTargets,
  startPasswordHandoff,
} from "../../../../../packages/core/src/password-handoff.js";
import { vaultAgent, vaultOwner } from "./vault-request.js";

// Password-blind Chrome password handoff (docs/password-handoff.md). The owner
// starts, checks and ends it from a real browser session; the bound agent
// thread may only read the value-free status.

type JsonBody = Record<string, unknown>;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

@Controller("api/vault")
export class PasswordHandoffController {
  @Get("password-handoffs")
  async list(@Req() request: any, @Query("desktop") desktop = "") {
    return { handoffs: await listOwnerPasswordHandoffs(vaultOwner(request), { desktopSlug: text(desktop) }) };
  }

  @Get("password-handoffs/targets")
  async targets(@Req() request: any, @Query("desktop") desktop = "") {
    return ownerPasswordHandoffTargets(vaultOwner(request), text(desktop));
  }

  @Post("password-handoffs")
  @HttpCode(201)
  async start(@Req() request: any, @Body() body: JsonBody = {}) {
    return startPasswordHandoff(vaultOwner(request, { mutating: true }), {
      desktopSlug: text(body?.desktop),
      threadId: text(body?.threadId),
      targetId: text(body?.targetId),
      origin: text(body?.origin),
      selector: text(body?.selector),
      ttlMs: Number(body?.ttlMs) || undefined,
    });
  }

  @Get("password-handoffs/:id")
  async status(@Req() request: any, @Param("id") id: string) {
    return ownerPasswordHandoffStatus(vaultOwner(request), id);
  }

  @Post("password-handoffs/:id/end")
  @HttpCode(200)
  async end(@Req() request: any, @Param("id") id: string, @Body() body: JsonBody = {}) {
    return endPasswordHandoff(vaultOwner(request, { mutating: true }), id, { reason: text(body?.reason) });
  }

  // Opens the handoff desktop for this browser session (a share bound to it).
  // The lease fencing token is supplied server-side, never sent to the page.
  @Post("password-handoffs/:id/open")
  @HttpCode(201)
  async open(@Req() request: any, @Res({ passthrough: true }) response: any, @Param("id") id: string) {
    const access = await ownerHandoffDesktopAccess(vaultOwner(request, { mutating: true }), id);
    return new BrowsersController().shareDesktop(request, response, access.desktopSlug, {
      threadId: access.threadId, fencingToken: access.fencingToken, start: false, openForCurrentSession: true,
    });
  }

  @Get("agent/password-handoffs/:id")
  async agentStatus(@Req() request: any, @Param("id") id: string, @Query("threadId") threadId = "") {
    vaultAgent(request);
    return agentPasswordHandoffStatus(await agentThreadIdFromRequest(request, text(threadId)), id);
  }
}
