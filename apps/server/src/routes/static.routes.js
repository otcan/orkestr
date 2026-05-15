import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { json } from "../http.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, "../../../web/public");

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
]);

async function serveStaticPath(pathname, reply) {
  const url = new URL(pathname, "http://localhost");
  const requested = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const safePath = path.normalize(requested).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(publicDir, safePath);
  const target = filePath.startsWith(publicDir) ? filePath : path.join(publicDir, "index.html");
  const ext = path.extname(target);
  try {
    const body = await fs.readFile(target);
    return reply
      .code(200)
      .header("cache-control", "no-store")
      .type(mimeTypes.get(ext) || "application/octet-stream")
      .send(body);
  } catch {
    const body = await fs.readFile(path.join(publicDir, "index.html"));
    return reply
      .code(200)
      .header("cache-control", "no-store")
      .type("text/html; charset=utf-8")
      .send(body);
  }
}

export async function registerStaticRoutes(app) {
  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith("/api/")) return json(reply, 404, { error: "not_found" });
    return serveStaticPath(request.url, reply);
  });
}
