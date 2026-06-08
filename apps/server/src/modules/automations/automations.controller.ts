import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req } from "@nestjs/common";
import {
  createAutomationForPrincipal,
  deleteAutomationForPrincipal,
  listAutomationsForPrincipal,
  runAutomationForPrincipal,
  setAutomationEnabledForPrincipal,
  updateAutomationForPrincipal,
} from "../../../../../packages/core/src/automations.js";
import { doctorAutomationsForPrincipal } from "../../../../../packages/core/src/automation-doctor.js";
import { listBrowserSessions } from "../../../../../packages/browsers/src/browsers.js";
import { connectorAuthStatus } from "../../../../../packages/connectors/src/connector-auth.js";
import { requestPrincipal } from "../../../../../packages/core/src/principal.js";

@Controller("api/automations")
export class AutomationsController {
  @Get()
  async list(@Req() request: any) {
    return { automations: await listAutomationsForPrincipal(requestPrincipal(request)) };
  }

  @Get("doctor")
  async doctor(@Req() request: any) {
    const principal = requestPrincipal(request);
    return doctorAutomationsForPrincipal(principal, process.env, new Date(), {
      connectorStatusProvider: (provider: string) => connectorAuthStatus(provider, process.env, { principal }),
      browserSessionsProvider: () => listBrowserSessions(process.env, { principal }),
    });
  }

  @Post()
  async create(@Req() request: any, @Body() body: Record<string, unknown> = {}) {
    return createAutomationForPrincipal(body, requestPrincipal(request));
  }

  @Patch(":automationId")
  async update(@Req() request: any, @Param("automationId") automationId: string, @Body() body: Record<string, unknown> = {}) {
    return updateAutomationForPrincipal({ ...body, automationId }, requestPrincipal(request));
  }

  @Post(":automationId/pause")
  @HttpCode(200)
  async pause(@Req() request: any, @Param("automationId") automationId: string) {
    return setAutomationEnabledForPrincipal({ automationId }, false, requestPrincipal(request));
  }

  @Post(":automationId/resume")
  @HttpCode(200)
  async resume(@Req() request: any, @Param("automationId") automationId: string) {
    return setAutomationEnabledForPrincipal({ automationId }, true, requestPrincipal(request));
  }

  @Post(":automationId/run")
  @HttpCode(200)
  async run(@Req() request: any, @Param("automationId") automationId: string, @Body() body: Record<string, unknown> = {}) {
    return runAutomationForPrincipal({ ...body, automationId }, requestPrincipal(request));
  }

  @Delete(":automationId")
  async delete(@Req() request: any, @Param("automationId") automationId: string) {
    return deleteAutomationForPrincipal({ automationId }, requestPrincipal(request));
  }
}
