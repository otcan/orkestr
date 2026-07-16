import fs from "node:fs";
import { fileURLToPath } from "node:url";

export function isMainModule(moduleUrl = "", argvPath = process.argv[1]) {
  if (!moduleUrl || !argvPath) return false;
  try {
    return fs.realpathSync(fileURLToPath(moduleUrl)) === fs.realpathSync(argvPath);
  } catch {
    return false;
  }
}
