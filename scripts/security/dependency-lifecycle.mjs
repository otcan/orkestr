import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { inspectLockfile, lifecycleScripts, reviewLifecycle, sha256 } from "./dependency-policy.mjs";

export async function checkLifecycle({ root, installed = false, policyPath = new URL("./dependency-policy.json", import.meta.url) }) {
  const policy = JSON.parse(await fs.readFile(policyPath, "utf8"));
  const lock = JSON.parse(await fs.readFile(path.join(root, "package-lock.json"), "utf8"));
  const manifest = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  const { entries } = inspectLockfile(lock, manifest, policy);
  if (sha256(await fs.readFile(path.join(root, "scripts/patch-whatsapp-media-id.mjs"))) !== policy.root.patchSha256) throw new Error("unreviewed_root_lifecycle");
  let checked = 0;
  if (installed) for (const entry of entries) {
    const target = path.join(root, entry.location);
    let raw;
    try { raw = await fs.readFile(path.join(target, "package.json"), "utf8"); }
    catch (error) { if (error.code === "ENOENT" && entry.optional) continue; throw new Error("installed_inventory_incomplete"); }
    const real = await fs.realpath(target), base = await fs.realpath(root);
    if (!real.startsWith(base + path.sep)) throw new Error("installed_package_outside_root");
    const pkg = JSON.parse(raw);
    if (pkg.name !== entry.package || pkg.version !== entry.version) throw new Error("installed_identity_mismatch");
    const scripts = lifecycleScripts(pkg);
    const implicitBuild = await fs.stat(path.join(target, "binding.gyp")).then(() => true, error => {
      if (error.code === "ENOENT") return false; throw error;
    });
    // npm has an implicit node-gyp install for binding.gyp, even without a scripts map.
    if (implicitBuild && !scripts.install && !scripts.preinstall) scripts.install = "node-gyp rebuild";
    reviewLifecycle(entry.package, entry, policy, Object.fromEntries(Object.entries(scripts).sort()));
    checked++;
  }
  return { status: "passed", lockedEntries: entries.length, installedChecked: checked, lifecycleExecution: "disabled" };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { root: { type: "string", default: process.cwd() }, installed: { type: "boolean" } } });
    console.log(JSON.stringify(await checkLifecycle({ root: path.resolve(values.root), installed: values.installed })));
  } catch { console.error("dependency_lifecycle_review_failed"); process.exitCode = 1; }
}
