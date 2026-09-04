import fs from "node:fs/promises";
import path from "node:path";

const source = path.resolve("apps/launcher/public");
const output = path.resolve("dist/launcher");
await fs.rm(output, { recursive: true, force: true });
await fs.mkdir(output, { recursive: true });
await fs.cp(source, output, { recursive: true });

