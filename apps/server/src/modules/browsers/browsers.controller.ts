import { Controller, Get, HttpCode, Param, Post } from "@nestjs/common";
import {
  listVirtualBrowsers,
  openVirtualBrowser,
  prepareVirtualBrowser,
} from "../../../../../packages/browsers/src/browsers.js";
import { httpError } from "../../common/http.js";

@Controller("api")
export class BrowsersController {
  @Get("browser-sessions")
  async sessions() {
    return { sessions: await listVirtualBrowsers() };
  }

  @Get("browsers")
  async browsers() {
    const browsers = await listVirtualBrowsers();
    return { browsers, sessions: browsers };
  }

  @Post("browser-sessions/:slug/:action")
  @HttpCode(200)
  async sessionAction(@Param("slug") slug: string, @Param("action") action: string) {
    const normalized = String(action || "").trim().toLowerCase();
    if (normalized === "prepare") return { browser: await prepareVirtualBrowser(slug) };
    if (normalized === "open" || normalized === "start") return { browser: await openVirtualBrowser(slug) };
    throw httpError("unknown_browser_action", 404);
  }

  @Post("browsers/:slug/:action")
  @HttpCode(200)
  async browserAction(@Param("slug") slug: string, @Param("action") action: string) {
    return this.sessionAction(slug, action);
  }
}
