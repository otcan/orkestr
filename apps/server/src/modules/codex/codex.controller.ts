import { Body, Controller, Get, HttpCode, Post, Query } from "@nestjs/common";
import {
  codexAppServerStatus,
  importCodexAppServerThread,
  listCodexAppServerThreads,
} from "../../../../../packages/core/src/codex-app-server.js";
import { migrateCodexThreadsToAppServer } from "../../../../../packages/core/src/codex-app-server-migration.js";
import { listThreadMessages } from "../../../../../packages/core/src/threads.js";
import { threadRuntimeSummary } from "../../thread-summary.js";
import { httpError } from "../../common/http.js";

function optionalString(value: unknown): string {
  return String(value || "").trim();
}

@Controller("api/codex")
export class CodexController {
  @Get("app-server/status")
  async appServerStatus() {
    const status = await codexAppServerStatus();
    return {
      ...status,
      runtimeKind: "codex-app-server",
    };
  }

  @Get("threads")
  async threads(@Query() query: Record<string, unknown> = {}) {
    const payload = await listCodexAppServerThreads({
      cursor: optionalString(query.cursor),
      limit: Number(query.limit || 25) || 25,
      searchTerm: optionalString(query.search || query.searchTerm),
      archived: String(query.archived || "").toLowerCase() === "true",
    });
    return {
      threads: payload?.data || [],
      nextCursor: payload?.nextCursor || null,
    };
  }

  @Post("threads/import")
  @HttpCode(201)
  async importThread(@Body() body: Record<string, unknown> = {}) {
    const codexThreadId = optionalString(body.codexThreadId || body.threadId);
    if (!codexThreadId) throw httpError("codex_thread_id_required", 400);
    const result = await importCodexAppServerThread(codexThreadId, body);
    return {
      ...result,
      thread: await threadRuntimeSummary(result.thread, await listThreadMessages(result.thread.id)),
    };
  }

  @Post("migrate")
  @HttpCode(200)
  async migrate(@Body() body: Record<string, unknown> = {}) {
    return migrateCodexThreadsToAppServer({
      dryRun: ["1", "true", "yes"].includes(optionalString(body.dryRun).toLowerCase()),
    });
  }
}
