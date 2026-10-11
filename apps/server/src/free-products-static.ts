import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderWorkoutLogPage } from "./free-workout-log-page.js";

const workoutLogAssets = new Map<string, string>([
  ["/free/workout-log/app.css", "text/css; charset=utf-8"],
  ["/free/workout-log/app.js", "text/javascript; charset=utf-8"],
  ["/free/workout-log/progression.js", "text/javascript; charset=utf-8"],
  ["/free/workout-log/store.js", "text/javascript; charset=utf-8"],
  ["/free/workout-log/timer.js", "text/javascript; charset=utf-8"],
]);
const serviceWorkerPath = "/free/workout-log-sw.js";

// The page may only load its own same-origin files and may not open any
// network connection, so logged data cannot leave the browser from this page.
export const workoutLogCsp = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "connect-src 'none'",
  "worker-src 'self'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");
// The service worker only re-fetches the page's own static files.
const serviceWorkerCsp = "default-src 'none'; connect-src 'self'";

function assetDir() {
  const candidates = [
    fileURLToPath(new URL("../../../../../apps/server/free-products/workout-log/", import.meta.url)),
    fileURLToPath(new URL("../free-products/workout-log/", import.meta.url)),
    path.resolve(process.cwd(), "apps/server/free-products/workout-log"),
  ];
  return candidates.find((dir) => fs.existsSync(path.join(dir, "app.js"))) || candidates[candidates.length - 1];
}

function sendAsset(response: any, file: string, type: string, extraHeaders: Record<string, string> = {}) {
  let body: Buffer;
  try {
    body = fs.readFileSync(path.join(assetDir(), file));
  } catch {
    response.status(404).header("cache-control", "no-store").type("text/plain; charset=utf-8").send("free product asset not found");
    return true;
  }
  response.status(200).header("cache-control", "no-cache").header("x-content-type-options", "nosniff");
  for (const [key, value] of Object.entries(extraHeaders)) response.header(key, value);
  response.type(type).send(body);
  return true;
}

export function maybeServeFreeProduct(response: any, publicPath: string, env = process.env) {
  if (publicPath === "/free/workout-log/") {
    response.status(301).header("cache-control", "public, max-age=3600").header("location", "/free/workout-log").send("Redirecting to the canonical URL.");
    return true;
  }
  if (publicPath === "/free/workout-log") {
    response.status(200)
      .header("cache-control", "no-cache")
      .header("content-security-policy", workoutLogCsp)
      .header("referrer-policy", "no-referrer")
      .header("x-content-type-options", "nosniff")
      .type("text/html; charset=utf-8")
      .send(renderWorkoutLogPage(env));
    return true;
  }
  if (publicPath === serviceWorkerPath) {
    return sendAsset(response, "sw.js", "text/javascript; charset=utf-8", { "content-security-policy": serviceWorkerCsp });
  }
  const type = workoutLogAssets.get(publicPath);
  if (type) return sendAsset(response, path.basename(publicPath), type);
  return false;
}
