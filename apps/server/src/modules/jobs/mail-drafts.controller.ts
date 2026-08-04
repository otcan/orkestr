import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req } from "@nestjs/common";
import {
  createOrkestrMailDraftForPrincipal,
  listOrkestrMailDraftsForPrincipal,
  sendOrkestrMailDraftForPrincipal,
  updateOrkestrMailDraftForPrincipal,
} from "../../../../../packages/core/src/mail-drafts.js";
import { requestPrincipal } from "../../../../../packages/core/src/principal.js";

@Controller("api/mail-drafts")
export class MailDraftsController {
  @Get()
  async list(@Req() request: any, @Query("threadId") threadId = "") {
    return listOrkestrMailDraftsForPrincipal(requestPrincipal(request), { threadId });
  }

  @Post()
  @HttpCode(200)
  async create(@Req() request: any, @Body() body: Record<string, unknown> = {}) {
    return createOrkestrMailDraftForPrincipal(body, requestPrincipal(request));
  }

  @Patch(":draftId")
  async update(@Req() request: any, @Param("draftId") draftId: string, @Body() body: Record<string, unknown> = {}) {
    return updateOrkestrMailDraftForPrincipal(draftId, body, requestPrincipal(request));
  }

  @Post(":draftId/send")
  @HttpCode(200)
  async send(@Req() request: any, @Param("draftId") draftId: string) {
    return sendOrkestrMailDraftForPrincipal(draftId, requestPrincipal(request));
  }
}
