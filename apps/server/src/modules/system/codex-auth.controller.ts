import { Controller, Get, Query } from "@nestjs/common";
import { codexLoginStatus } from "../../../../../packages/connectors/src/codex.js";
import { codexAuthDoctor, listCodexAuthFailedTurns, parseSinceMs } from "../../../../../packages/core/src/codex-auth-alert.js";

@Controller("api/system/codex-auth")
export class CodexAuthController {
  @Get()
  async doctor() {
    return codexAuthDoctor(process.env, { codexLoginStatus });
  }

  @Get("failed-turns")
  async failedTurns(@Query("since") since = "") {
    return { ok: true, turns: await listCodexAuthFailedTurns({ sinceMs: parseSinceMs(since) }) };
  }
}
