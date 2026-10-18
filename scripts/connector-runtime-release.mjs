// Verify the processes that are actually running, not only the release symlink.
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isMainModule } from "./main-module.mjs";

const exec = promisify(execFile);

async function mainPid(unit) {
  if (!/^[a-zA-Z0-9@_.-]+$/.test(unit)) throw new Error("invalid_unit");
  const { stdout } = await exec("systemctl", ["show", unit, "--property=MainPID", "--value"], { timeout: 5000 });
  const pid = Number(stdout.trim());
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("process_unavailable");
  return pid;
}

export async function verifyConnectorProcess({ unit, releaseDir, script }, { pidForUnit = mainPid, procRoot = "/proc" } = {}) {
  try {
    const expectedRoot = await fs.realpath(releaseDir);
    const expectedScript = await fs.realpath(path.join(expectedRoot, "scripts", script));
    const pid = await pidForUnit(unit);
    const processRoot = path.join(procRoot, String(pid));
    const cwd = await fs.realpath(path.join(processRoot, "cwd"));
    const argv = (await fs.readFile(path.join(processRoot, "cmdline"), "utf8")).split("\0");
    if (cwd !== expectedRoot) return { ok: false, unit, reason: "process_release_directory_mismatch" };
    if (!argv[1] || await fs.realpath(path.resolve(cwd, argv[1])) !== expectedScript) {
      return { ok: false, unit, reason: "process_entrypoint_mismatch" };
    }
    if (await pidForUnit(unit) !== pid) return { ok: false, unit, reason: "process_changed_during_check" };
    return { ok: true, unit, pid };
  } catch {
    return { ok: false, unit, reason: "process_release_unverifiable" };
  }
}

export async function verifyConnectorProcesses(releaseDir, gateway, worker) {
  const results = await Promise.all([
    verifyConnectorProcess({ unit: gateway, releaseDir, script: "orkestr-connectors-mcp.mjs" }),
    verifyConnectorProcess({ unit: worker, releaseDir, script: "orkestr-wa-worker.mjs" }),
  ]);
  return { ok: results.every(result => result.ok), processes: results };
}

if (isMainModule(import.meta.url)) {
  const [releaseDir, gateway, worker] = process.argv.slice(2);
  const result = await verifyConnectorProcesses(releaseDir, gateway, worker);
  console.log(JSON.stringify(result));
  process.exitCode = result.ok ? 0 : 1;
}
