import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const webRoot = path.join(root, "dist", "web", "browser");
const required = ["index.html", "main.js", "polyfills.js", "styles.css", "favicon.svg"];
const missing = required.filter((file) => !fs.existsSync(path.join(webRoot, file)));

if (missing.length) {
  console.error("Missing prebuilt Orkestr web assets:");
  for (const file of missing) console.error(`  ${path.relative(root, path.join(webRoot, file))}`);
  console.error("");
  console.error("Install packages use the checked-in static web bundle instead of building Angular.");
  console.error("For frontend development, run `npm ci && npm run web:build`, then commit the updated dist/web bundle.");
  process.exit(1);
}

const index = fs.readFileSync(path.join(webRoot, "index.html"), "utf8");
for (const asset of ["main.js", "polyfills.js", "styles.css"]) {
  if (!index.includes(asset)) {
    console.error(`Static web index does not reference ${asset}. Rebuild with npm run web:build.`);
    process.exit(1);
  }
}

console.log(`Static web bundle ready: ${path.relative(root, webRoot)}`);
