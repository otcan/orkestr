import { listVirtualBrowsers, openVirtualBrowser, prepareVirtualBrowser } from "../../../../packages/browsers/src/browsers.js";
import { json } from "../http.js";

export async function registerBrowserRoutes(app) {
  app.get("/api/browsers", async (_request, reply) => {
    return json(reply, 200, { browsers: await listVirtualBrowsers() });
  });

  app.post("/api/browsers/:slug/prepare", async (request, reply) => {
    return json(reply, 200, { browser: await prepareVirtualBrowser(request.params.slug) });
  });

  app.post("/api/browsers/:slug/open", async (request, reply) => {
    return json(reply, 200, { browser: await openVirtualBrowser(request.params.slug) });
  });
}
