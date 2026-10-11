import fs from "node:fs";
import path from "node:path";

// Static browser assets for interactive live builds, keyed by catalog slug.
// Plain browser JS and CSS live in apps/server/public-builds and ship unchanged
// with the server. Only the files listed here are served; everything else
// falls through.
const buildAssetRoot = path.resolve(process.cwd(), "apps/server/public-builds");
const js = "text/javascript; charset=utf-8";
const css = "text/css; charset=utf-8";

export const publicBuildAssets: Record<string, Record<string, string>> = {
  "evidence-desk": {
    "evidence-desk-app.js": js,
    "evidence-desk-state.js": js,
    "evidence-desk-score.js": js,
    "evidence-desk-sample.js": js,
    "evidence-desk-export.js": js,
    "evidence-desk-views.js": js,
    "evidence-desk.css": css,
  },
};

export function publicBuildAsset(pathname = "") {
  const match = /^\/builds\/([a-z0-9-]+)\/([a-z0-9.-]+)$/.exec(pathname);
  if (!match) return null;
  const type = publicBuildAssets[match[1]]?.[match[2]];
  if (!type) return null;
  try {
    return { type, body: fs.readFileSync(path.join(buildAssetRoot, match[1], match[2]), "utf8") };
  } catch {
    return null;
  }
}
