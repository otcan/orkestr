import { Controller, Get, HttpCode, Param, Post } from "@nestjs/common";
import {
  listVirtualBrowsers,
  openVirtualBrowser,
  prepareVirtualBrowser,
} from "../../../../../packages/browsers/src/browsers.js";

@Controller("api")
export class BrowsersController {
  @Get("browsers")
  async browsers() {
    return { browsers: await listVirtualBrowsers() };
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
    if (action === "prepare") return { browser: await prepareVirtualBrowser(slug) };
    if (action === "start" || action === "open") return { browser: await openVirtualBrowser(slug) };
    const error = new Error("unknown_browser_action") as Error & { statusCode?: number };
    error.statusCode = 400;
    throw error;
  }
}
