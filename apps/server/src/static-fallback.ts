import fs from "node:fs/promises";
import path from "node:path";
import type { INestApplication } from "@nestjs/common";

const publicDir = path.resolve(process.cwd(), "dist/web/browser");

const mimeTypes = new Map<string, string>([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
]);

export function registerStaticFallback(app: INestApplication): void {
  const expressApp = app.getHttpAdapter().getInstance();
  expressApp.use(async (request: any, response: any, next: () => void) => {
    const url = String(request.url || "");
    if (url.startsWith("/api/") || url.startsWith("/oauth/") || url.startsWith("/google-marketing/oauth/")) {
      return next();
    }
    return serveStaticPath(url || "/", response);
  });
}

async function serveStaticPath(requestUrl: string, response: any) {
  const url = new URL(requestUrl, "http://localhost");
  const requested = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const safePath = path.normalize(requested).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(publicDir, safePath);
  const target = filePath.startsWith(publicDir) ? filePath : path.join(publicDir, "index.html");
  const ext = path.extname(target);

  try {
    const body = await fs.readFile(target);
    return response
      .status(200)
      .header("cache-control", "no-store")
      .type(mimeTypes.get(ext) || "application/octet-stream")
      .send(body);
  } catch {
    try {
      const body = await fs.readFile(path.join(publicDir, "index.html"));
      return response
        .status(200)
        .header("cache-control", "no-store")
        .type("text/html; charset=utf-8")
        .send(body);
    } catch {
      return response
        .status(503)
        .header("cache-control", "no-store")
        .type("text/html; charset=utf-8")
        .send("<!doctype html><title>Orkestr build missing</title><h1>Angular build missing</h1><p>Run <code>npm run web:build</code> before starting the server.</p>");
    }
  }
}
