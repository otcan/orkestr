// Deploy markers in the perf log: on every server start one `events` line with
// the release id, short commit and version, so `orkestr doctor perf` can say
// "since deploy X" and compare before/after a deploy. Ids are reduced to a
// short safe character set; no paths, hosts or environment values are written.
import fs from "node:fs/promises";
import path from "node:path";

const safeId = (value, max = 64) => String(value || "").trim().replace(/[^\w.+:-]/g, "").slice(0, max) || null;

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

export async function perfDeployMarker(env = process.env, { cwd = process.cwd(), now = new Date() } = {}) {
  const manifest = (env.ORKESTR_RELEASE_MANIFEST && await readJson(env.ORKESTR_RELEASE_MANIFEST)) || await readJson(path.join(cwd, "release-manifest.json")) || {};
  const pkg = await readJson(path.join(cwd, "package.json")) || {};
  const commit = safeId(env.ORKESTR_BUILD_COMMIT || manifest.git?.commit, 40)?.slice(0, 12) || null;
  const version = safeId(manifest.releaseVersion || manifest.version || pkg.version, 32);
  return {
    ts: now.toISOString(),
    event: "start",
    releaseId: safeId(manifest.releaseId || manifest.buildId) || commit || version || "unknown",
    commit,
    version,
  };
}

// Groups start markers (oldest first) into deploys: a deploy is the first
// start of a release id; later starts of the same release are restarts.
export function latestPerfDeploy(markers = []) {
  let deploy = null;
  for (const marker of markers) {
    if (marker?.event !== "start") continue;
    if (!deploy || deploy.releaseId !== marker.releaseId) {
      deploy = { releaseId: marker.releaseId, commit: marker.commit || null, at: marker.ts, previousReleaseId: deploy?.releaseId || null, restarts: 0, lastStartAt: marker.ts };
    } else {
      deploy.restarts += 1;
      deploy.lastStartAt = marker.ts;
    }
  }
  return deploy;
}
