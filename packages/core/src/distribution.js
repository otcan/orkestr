function clean(value = "") {
  return String(value || "").trim();
}

function normalizeKind(value = "", fallback = "oss") {
  const normalized = clean(value).toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  if (normalized === "managed" || normalized === "private") return "managed";
  if (normalized === "oss" || normalized === "public") return "oss";
  return fallback;
}

export function distributionIdentity(env = process.env, manifest = {}) {
  const manifestDistribution = manifest.distribution && typeof manifest.distribution === "object"
    ? manifest.distribution
    : {};
  const kind = normalizeKind(
    env.ORKESTR_DISTRIBUTION ||
      env.ORKESTR_DEPLOYMENT_KIND ||
      manifestDistribution.kind ||
      manifest.distributionKind ||
      "",
    "oss",
  );
  const track = clean(
    env.ORKESTR_DEPLOYMENT_TRACK ||
      env.ORKESTR_RELEASE_TRACK ||
      manifestDistribution.track ||
      manifest.deploymentTrack ||
      kind,
  ).toLowerCase().replace(/[^a-z0-9_.-]+/g, "-") || kind;
  const repoRole = normalizeKind(
    env.ORKESTR_REPO_ROLE ||
      env.ORKESTR_SOURCE_REPO_ROLE ||
      manifestDistribution.repoRole ||
      manifest.repoRole ||
      kind,
    kind,
  );
  return {
    kind,
    track,
    repoRole,
    managed: kind === "managed",
    oss: kind === "oss",
  };
}
