import { watch } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

// Subscribe before checking the fixture's journal, so a fast child cannot race
// the initial read. Only a complete matching record proves the child started.
export function waitForFixtureCall(file, matches, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const finish = (error, record) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      watcher.close();
      if (error) reject(error);
      else resolve(record);
    };
    const check = async () => {
      try {
        const lines = (await fs.readFile(file, "utf8")).split("\n").slice(0, -1);
        const record = lines.filter(Boolean).map(JSON.parse).find(matches);
        if (record) finish(null, record);
      } catch (error) {
        if (error.code !== "ENOENT") finish(error);
      }
    };
    const watcher = watch(path.dirname(file), { persistent: false }, (_event, name) => {
      if (String(name) === path.basename(file)) void check();
    });
    watcher.once("error", (error) => finish(error));
    timer = setTimeout(() => finish(new Error("fixture call was not observed")), timeoutMs);
    void check();
  });
}
