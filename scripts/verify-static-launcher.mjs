import fs from "node:fs/promises";
import path from "node:path";

const output = path.resolve("dist/launcher");
for (const file of ["index.html", "launcher.css", "launcher.js"]) {
  const stat = await fs.stat(path.join(output, file)).catch(() => null);
  if (!stat?.isFile() || stat.size < 20) throw new Error(`launcher_asset_missing:${file}`);
}
const index = await fs.readFile(path.join(output, "index.html"), "utf8");
if (!index.includes("launcher.css") || !index.includes("launcher.js")) throw new Error("launcher_index_incomplete");
console.log("Standalone launcher assets verified.");

