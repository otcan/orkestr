import fs from "node:fs";
import path from "node:path";

// Static files for the live builds under /builds/<slug>/. Plain browser JS and
// CSS live in apps/server/public-builds and ship unchanged with the server.
const buildAssetDir = path.resolve(process.cwd(), "apps/server/public-builds");
const buildAssetTypes: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};
const buildAssetFiles = new Set(["customer-portal/app.js", "customer-portal/workflow.js", "customer-portal/portal.css"]);

// Only an explicit allowlist of static demo files is served; never arbitrary paths.
export function readPublicBuildAsset(pathname = "") {
  const relative = String(pathname || "").replace(/^\/builds\//, "");
  if (!pathname.startsWith("/builds/") || !buildAssetFiles.has(relative)) return null;
  try {
    const body = fs.readFileSync(path.join(buildAssetDir, relative), "utf8");
    return { body, type: buildAssetTypes[path.extname(relative)] || "text/plain; charset=utf-8" };
  } catch {
    return null;
  }
}
