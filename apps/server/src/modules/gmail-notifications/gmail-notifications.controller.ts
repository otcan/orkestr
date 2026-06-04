import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req } from "@nestjs/common";
import {
  createGmailNotificationForPrincipal,
  deleteGmailNotificationForPrincipal,
  listGmailNotificationsForPrincipal,
  runGmailNotificationNowForPrincipal,
  updateGmailNotificationForPrincipal,
} from "../../../../../packages/core/src/gmail-notifications.js";
import { requestPrincipal } from "../../../../../packages/core/src/principal.js";

@Controller("api/gmail-notifications")
export class GmailNotificationsController {
  @Get()
  async list(@Req() request: any) {
    return { notifications: await listGmailNotificationsForPrincipal(requestPrincipal(request)) };
  }

  @Post()
  async create(@Req() request: any, @Body() body: Record<string, unknown> = {}) {
    return { notification: await createGmailNotificationForPrincipal(body, requestPrincipal(request)) };
  }

  @Patch(":notificationId")
  async update(@Req() request: any, @Param("notificationId") notificationId: string, @Body() body: Record<string, unknown> = {}) {
    return { notification: await updateGmailNotificationForPrincipal(notificationId, body, requestPrincipal(request)) };
  }

  @Delete(":notificationId")
  async delete(@Req() request: any, @Param("notificationId") notificationId: string) {
    return { ok: await deleteGmailNotificationForPrincipal(notificationId, requestPrincipal(request)) };
  }

  @Post(":notificationId/run")
  @HttpCode(200)
  async run(@Req() request: any, @Param("notificationId") notificationId: string) {
    return await runGmailNotificationNowForPrincipal(notificationId, requestPrincipal(request));
  }
}
