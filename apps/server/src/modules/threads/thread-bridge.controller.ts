import { Body, Controller, Get, Param, Post, Query, Req } from "@nestjs/common";
import { listBridgeThreads, readBridgeChanges, readBridgeHistory, replyToBridgeThread } from "../../../../../packages/core/src/thread-bridge.js";

// No existing human/browser principal is promoted into a delegated identity.
// A future verified authentication adapter must populate this principal. Until
// then these routes deny access, even when the local feature flag is enabled.
function delegatedPrincipal(request: any) {
  return request.orkestrDelegatedPrincipal || null;
}

@Controller("api/thread-bridge")
export class ThreadBridgeController {
  @Get("threads")
  async threads(@Req() request: any) {
    return listBridgeThreads(delegatedPrincipal(request));
  }

  @Get("changes")
  async changes(@Req() request: any, @Query() query: Record<string, string>) {
    return readBridgeChanges(delegatedPrincipal(request), { cursor: query.cursor || "", limit: query.limit === undefined ? 100 : Number(query.limit) });
  }

  @Get("threads/:threadId/history")
  async history(@Req() request: any, @Param("threadId") threadId: string, @Query() query: Record<string, string>) {
    return readBridgeHistory(threadId, delegatedPrincipal(request), { after: query.after || "", limit: query.limit === undefined ? 100 : Number(query.limit) });
  }

  @Post("threads/:threadId/replies")
  async reply(@Req() request: any, @Param("threadId") threadId: string, @Body() body: Record<string, unknown>) {
    return replyToBridgeThread(threadId, body, delegatedPrincipal(request));
  }
}
