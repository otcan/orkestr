import { Controller, Get, HttpCode, Param, Post } from "@nestjs/common";
import {
  listVirtualBrowsers,
  openVirtualBrowser,
  prepareVirtualBrowser,
} from "../../../../../packages/browsers/src/browsers.js";
import { httpError } from "../../common/http.js";

@Controller("api")
export class BrowsersController {
  @Get("browsers")
  async browsers() {
    const browsers = await listVirtualBrowsers();
    return { browsers, sessions: browsers };
  }

  @Get("browser-sessions")
  async browserSessions() {
    return { sessions: await listVirtualBrowsers() };
  }

  @Post("browsers/:slug/:action")
  @HttpCode(200)
  async browserAction(@Param("slug") slug: string, @Param("action") action: string) {
    return this.runAction(slug, action);
  }

  @Post("browser-sessions/:slug/:action")
  @HttpCode(200)
  async browserSessionAction(@Param("slug") slug: string, @Param("action") action: string) {
    return this.runAction(slug, action);
  }

  private async runAction(slug: string, action: string) {
    const normalized = String(action || "").trim().toLowerCase();
    if (normalized === "prepare") return { browser: await prepareVirtualBrowser(slug) };
    if (normalized === "start" || normalized === "open") return { browser: await openVirtualBrowser(slug) };
    throw httpError("unknown_browser_action", 404);
  }
}
