import { Body, Controller, Get, HttpCode, Param, Post, Req } from "@nestjs/common";
import {
  heartbeatBrokerInstance,
  listBrokerInstances,
  registerBrokerInstance,
} from "../../../../../packages/core/src/broker-instance-registry.js";
import { isAdminPrincipal } from "../../../../../packages/core/src/policy.js";
import { requestPrincipal } from "../../../../../packages/core/src/principal.js";
import { httpError } from "../../common/http.js";

function assertAdminRequest(request: any): void {
  if (isAdminPrincipal(requestPrincipal(request))) return;
  throw httpError("admin_required", 403);
}

async function brokerCall<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error: any) {
    throw httpError(String(error?.message || "broker_request_failed"), Number(error?.statusCode || 500));
  }
}

@Controller("api/broker")
export class BrokerController {
  @Post("instances/register")
  @HttpCode(200)
  async registerInstance(@Req() request: any, @Body() body: Record<string, unknown> = {}) {
    return brokerCall(() => registerBrokerInstance({ body, request, env: process.env }));
  }

  @Post("instances/:instanceId/heartbeat")
  @HttpCode(200)
  async heartbeatInstance(
    @Req() request: any,
    @Param("instanceId") instanceId: string,
    @Body() body: Record<string, unknown> = {},
  ) {
    return brokerCall(() => heartbeatBrokerInstance(instanceId, { body, request, env: process.env }));
  }

  @Get("instances")
  async instances(@Req() request: any) {
    assertAdminRequest(request);
    return listBrokerInstances(process.env);
  }
}
