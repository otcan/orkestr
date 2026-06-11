#!/usr/bin/env node

function clean(value = "") {
  return String(value || "").trim();
}

function flagValue(argv, name, fallback = "") {
  const index = argv.indexOf(name);
  if (index === -1) return fallback;
  return clean(argv[index + 1]);
}

function hasFlag(argv, name) {
  return argv.includes(name);
}

function shellQuote(value = "") {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

function envLine(key, value) {
  return `${key}=${shellQuote(value)}`;
}

function profile({
  id,
  distribution,
  repoRole,
  track,
  repoUrl,
  root,
  serviceName,
  port,
  publicUrl,
}) {
  const deployRoot = `${root}/${id}`;
  return {
    id,
    distribution,
    repoRole,
    track,
    repoUrl,
    deployRoot,
    releasesDir: `${deployRoot}/releases`,
    currentLink: `${deployRoot}/current`,
    repoCache: `${deployRoot}/repo-cache`,
    home: `${deployRoot}/data`,
    workspaceRoot: `${deployRoot}/workspaces`,
    overlayDir: `${deployRoot}/overlay`,
    serviceName,
    port,
    publicUrl,
    env: {
      ORKESTR_DISTRIBUTION: distribution,
      ORKESTR_DEPLOYMENT_TRACK: track,
      ORKESTR_REPO_ROLE: repoRole,
      ORKESTR_REPO_URL: repoUrl,
      ORKESTR_DEPLOY_ROOT: deployRoot,
      ORKESTR_RELEASES_DIR: `${deployRoot}/releases`,
      ORKESTR_CURRENT_LINK: `${deployRoot}/current`,
      ORKESTR_REPO_CACHE: `${deployRoot}/repo-cache`,
      ORKESTR_HOME: `${deployRoot}/data`,
      ORKESTR_RUNTIME_WORKSPACE_ROOT: `${deployRoot}/workspaces`,
      ORKESTR_OVERLAY_DIR: `${deployRoot}/overlay`,
      ORKESTR_SERVICE_NAME: serviceName,
      ORKESTR_PORT: String(port),
      ORKESTR_HOST: "127.0.0.1",
      ORKESTR_PUBLIC_APP_URL: publicUrl,
    },
  };
}

function plan(options = {}) {
  const root = clean(options.root) || "/opt/orkestr";
  const managedRepo = clean(options.managedRepo) || "<managed-private-repo-url>";
  const ossRepo = clean(options.ossRepo) || "https://github.com/otcan/orkestr.git";
  const baseDomain = clean(options.domain) || "example.test";
  const managedHost = clean(options.managedHost) || `managed.${baseDomain}`;
  const ossHost = clean(options.ossHost) || `oss.${baseDomain}`;
  const managed = profile({
    id: "managed",
    distribution: "managed",
    repoRole: "managed",
    track: "managed-production",
    repoUrl: managedRepo,
    root,
    serviceName: "orkestr-managed",
    port: Number(options.managedPort || 19812),
    publicUrl: `https://${managedHost}`,
  });
  const oss = profile({
    id: "oss",
    distribution: "oss",
    repoRole: "oss",
    track: "oss-production",
    repoUrl: ossRepo,
    root,
    serviceName: "orkestr-oss",
    port: Number(options.ossPort || 19822),
    publicUrl: `https://${ossHost}`,
  });
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    root,
    profiles: [managed, oss],
    verification: [
      `${managed.publicUrl}/api/version should report distribution.kind=managed and deploymentTrack=managed-production`,
      `${oss.publicUrl}/api/version should report distribution.kind=oss and deploymentTrack=oss-production`,
      "Both profiles should use separate ORKESTR_HOME, release roots, service names, ports, and release manifests.",
    ],
  };
}

function renderShell(plan) {
  const blocks = [];
  for (const profile of plan.profiles) {
    blocks.push([
      `# ${profile.id} deployment profile`,
      ...Object.entries(profile.env).map(([key, value]) => envLine(key, value)),
      `# install/update: ORKESTR_REPO_URL=${shellQuote(profile.repoUrl)} ORKESTR_DEPLOY_ROOT=${shellQuote(profile.deployRoot)} sudo -E scripts/install.sh --systemd --track-main`,
    ].join("\n"));
  }
  return `${blocks.join("\n\n")}\n`;
}

function usage() {
  return [
    "Usage: node scripts/deployment-split-plan.mjs [--json|--shell] [options]",
    "",
    "Options:",
    "  --root DIR              Base deployment root. Default: /opt/orkestr",
    "  --domain DOMAIN         Base domain for generated hosts. Default: example.test",
    "  --managed-host HOST     Managed deployment host. Default: managed.<domain>",
    "  --oss-host HOST         OSS deployment host. Default: oss.<domain>",
    "  --managed-repo URL      Managed/private repo URL placeholder.",
    "  --oss-repo URL          OSS repo URL. Default: https://github.com/otcan/orkestr.git",
    "  --managed-port PORT     Managed local port. Default: 19812",
    "  --oss-port PORT         OSS local port. Default: 19822",
  ].join("\n");
}

const argv = process.argv.slice(2);
if (hasFlag(argv, "--help") || hasFlag(argv, "-h")) {
  console.log(usage());
  process.exit(0);
}

const result = plan({
  root: flagValue(argv, "--root"),
  domain: flagValue(argv, "--domain"),
  managedHost: flagValue(argv, "--managed-host"),
  ossHost: flagValue(argv, "--oss-host"),
  managedRepo: flagValue(argv, "--managed-repo"),
  ossRepo: flagValue(argv, "--oss-repo"),
  managedPort: flagValue(argv, "--managed-port"),
  ossPort: flagValue(argv, "--oss-port"),
});

if (hasFlag(argv, "--shell")) process.stdout.write(renderShell(result));
else process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
