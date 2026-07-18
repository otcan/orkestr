import fs from "node:fs/promises";
import { ApiError, requestJson } from "./api-client.js";

export async function tenantSliceCommand(argv = [], ctx = {}) {
  const subcommand = argv[0]?.startsWith("--") ? "list" : argv[0] || "list";
  const rest = subcommand === "list" && argv[0]?.startsWith("--") ? argv : argv.slice(1);
  if (subcommand === "list" || subcommand === "ls") return listTenantSlicesCommand(rest, ctx);
  if (subcommand === "create" || subcommand === "up" || subcommand === "ensure") return createTenantSliceCommand(rest, ctx);
  if (subcommand === "apply") return provisionTenantSliceCommand(["--execute", ...rest], ctx);
  if (subcommand === "plan") return provisionTenantSliceCommand(["--dry-run", ...rest], ctx);
  if (subcommand === "provision") return provisionTenantSliceCommand(rest, ctx);
  if (subcommand === "status" || subcommand === "show") return tenantSliceStatusCommand(rest, ctx);
  throw new Error(tenantSliceUsage());
}

async function listTenantSlicesCommand(argv, ctx) {
  const json = argv.includes("--json");
  const payload = await requestJson("/api/tenant-slices", ctx);
  if (json) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else ctx.stdout.write(formatTenantSliceTable(payload.tenantSlices || []));
  return 0;
}

async function createTenantSliceCommand(argv, ctx) {
  const json = argv.includes("--json");
  const ownerUserId = ownerFromArgs(argv);
  if (!ownerUserId) throw new Error(tenantSliceCreateUsage());

  const createBody = tenantSliceCreateBody(argv, ownerUserId);
  const { tenantSlice, reused } = await createOrReuseTenantSlice(createBody, ctx);
  if (argv.includes("--create-only")) {
    const payload = { ok: true, reused, tenantSlice };
    if (json) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else ctx.stdout.write(formatTenantSliceCreateOnly(payload));
    return 0;
  }

  const provisionBody = await tenantSliceProvisionBody(argv, ctx);
  const provisioned = await requestJson(`/api/tenant-slices/${encodeURIComponent(tenantSlice.id)}/provision`, {
    ...ctx,
    method: "POST",
    body: provisionBody,
  });
  const payload = { ok: true, reused, tenantSlice, provisioned };
  if (json) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else ctx.stdout.write(formatTenantSliceProvisionResult(payload));
  return provisioned?.ok === false ? 1 : 0;
}

async function provisionTenantSliceCommand(argv, ctx) {
  const json = argv.includes("--json");
  const tenantSliceId = positional(argv)[0] || flagValue(argv, "--id") || flagValue(argv, "--slice-id") || flagValue(argv, "--tenant-slice-id");
  if (!tenantSliceId) throw new Error("Usage: orkestr vm-slice provision <slice-id> [--execute] [--namespace ns] [--vm-name name] [--json]");
  const provisioned = await requestJson(`/api/tenant-slices/${encodeURIComponent(tenantSliceId)}/provision`, {
    ...ctx,
    method: "POST",
    body: await tenantSliceProvisionBody(argv, ctx),
  });
  if (json) ctx.stdout.write(`${JSON.stringify(provisioned, null, 2)}\n`);
  else ctx.stdout.write(formatTenantSliceProvisionResult({ ok: true, provisioned }));
  return provisioned?.ok === false ? 1 : 0;
}

async function tenantSliceStatusCommand(argv, ctx) {
  const json = argv.includes("--json");
  const tenantSliceId = positional(argv)[0] || flagValue(argv, "--id") || flagValue(argv, "--slice-id") || flagValue(argv, "--tenant-slice-id");
  if (!tenantSliceId) throw new Error("Usage: orkestr vm-slice status <slice-id> [--json]");
  const payload = await requestJson(`/api/tenant-slices/${encodeURIComponent(tenantSliceId)}/runtime-status`, ctx);
  if (json) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else ctx.stdout.write(formatTenantSliceRuntimeStatus(payload));
  return payload.ok === false ? 1 : 0;
}

async function createOrReuseTenantSlice(body, ctx) {
  try {
    const payload = await requestJson("/api/tenant-slices", {
      ...ctx,
      method: "POST",
      body,
    });
    return { tenantSlice: payload.tenantSlice, reused: false };
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 409) throw error;
    const existing = await findExistingTenantSlice(body, ctx);
    if (!existing) throw error;
    return { tenantSlice: existing, reused: true };
  }
}

async function findExistingTenantSlice(body, ctx) {
  const requestedId = clean(body.id || body.tenantSliceId);
  const requestedOwner = clean(body.ownerUserId || body.userId);
  if (requestedId) {
    const payload = await requestJson(`/api/tenant-slices/${encodeURIComponent(requestedId)}`, ctx).catch(() => null);
    if (payload?.tenantSlice) return payload.tenantSlice;
  }
  if (!requestedOwner) return null;
  const listed = await requestJson("/api/tenant-slices", ctx).catch(() => null);
  return (listed?.tenantSlices || []).find((slice) =>
    clean(slice.ownerUserId) === requestedOwner && !slice.deletedAt && slice.status !== "deleted",
  ) || null;
}

function tenantSliceCreateBody(argv, ownerUserId) {
  const body = {
    ownerUserId,
  };
  const id = flagValue(argv, "--id") || flagValue(argv, "--slice-id") || flagValue(argv, "--tenant-slice-id");
  const displayName = flagValue(argv, "--name") || flagValue(argv, "--display-name");
  if (id) body.id = id;
  if (displayName) body.displayName = displayName;

  const resources = numberFields(argv, {
    memoryHighMiB: ["--memory-high-mib", "--memory-high"],
    memoryMaxMiB: ["--memory-max-mib", "--memory-mib", "--memory"],
    cpuQuotaPercent: ["--cpu-quota-percent", "--cpu-quota", "--cpu"],
    tasksMax: ["--tasks-max"],
    diskSoftGiB: ["--disk-soft-gib", "--disk-gib", "--disk"],
  });
  if (Object.keys(resources).length) body.resources = resources;

  const budget = numberFields(argv, {
    dailyUsd: ["--daily-usd", "--daily-budget"],
    monthlyUsd: ["--monthly-usd", "--monthly-budget"],
  });
  if (Object.keys(budget).length) body.budget = budget;

  const connectors = connectorBody(argv);
  if (Object.keys(connectors).length) body.connectors = connectors;

  const labels = keyValueObject(repeatedFlagValues(argv, ["--label"]));
  if (Object.keys(labels).length) body.labels = labels;

  const capabilities = repeatedFlagValues(argv, ["--capability", "--cap"]);
  if (capabilities.length) body.capabilities = capabilities;

  return body;
}

function connectorBody(argv) {
  const connectors = {};
  const whatsappChatId = flagValue(argv, "--whatsapp-chat-id") || flagValue(argv, "--wa-chat-id") || flagValue(argv, "--chat-id");
  const whatsappAccountId = flagValue(argv, "--whatsapp-account-id") || flagValue(argv, "--wa-account-id") || flagValue(argv, "--wa-account");
  const whatsappParticipantIds = repeatedFlagValues(argv, ["--whatsapp-participant", "--wa-participant", "--participant"]);
  const promoteParticipantsAsAdmins = !argv.includes("--no-wa-admin") && !argv.includes("--no-admin");
  const whatsappAdminParticipantIds = uniqueList([
    ...(promoteParticipantsAsAdmins ? whatsappParticipantIds : []),
    ...repeatedFlagValues(argv, ["--whatsapp-admin", "--wa-admin", "--admin-participant"]),
  ]);
  if (argv.includes("--no-whatsapp") || whatsappChatId || whatsappAccountId || whatsappParticipantIds.length || whatsappAdminParticipantIds.length) {
    connectors.whatsapp = {
      ...(argv.includes("--no-whatsapp") ? { enabled: false } : {}),
      ...(whatsappChatId ? { chatId: whatsappChatId } : {}),
      ...(whatsappAccountId ? { accountId: whatsappAccountId } : {}),
      ...(whatsappParticipantIds.length ? { participantIds: whatsappParticipantIds } : {}),
      ...(whatsappAdminParticipantIds.length ? { adminParticipantIds: whatsappAdminParticipantIds } : {}),
      ...(whatsappParticipantIds.length || whatsappAdminParticipantIds.length ? { promoteParticipantsAsAdmins } : {}),
    };
  }

  const gmailAccountId = flagValue(argv, "--gmail-account-id") || flagValue(argv, "--gmail-account");
  if (argv.includes("--no-gmail") || gmailAccountId) {
    connectors.gmail = {
      ...(argv.includes("--no-gmail") ? { enabled: false } : {}),
      ...(gmailAccountId ? { accountId: gmailAccountId } : {}),
    };
  }

  const linkedinDesktopSlug = flagValue(argv, "--linkedin-desktop") || flagValue(argv, "--desktop") || flagValue(argv, "--desktop-slug");
  if (argv.includes("--no-linkedin") || linkedinDesktopSlug) {
    connectors.linkedin = {
      ...(argv.includes("--no-linkedin") ? { enabled: false } : {}),
      ...(linkedinDesktopSlug ? { desktopSlug: linkedinDesktopSlug } : {}),
    };
  }

  if (argv.includes("--no-oxrm")) connectors.oxrm = { enabled: false };
  return connectors;
}

async function tenantSliceProvisionBody(argv, ctx) {
  const execute = argv.includes("--execute") || argv.includes("--apply");
  const body = {
    execute,
    dryRun: !execute || argv.includes("--dry-run") || argv.includes("--plan"),
  };
  for (const [key, flags] of Object.entries({
    imageUrl: ["--image-url"],
    storageClass: ["--storage-class"],
    repoUrl: ["--repo-url", "--repo"],
    gitRef: ["--git-ref", "--ref"],
    bootstrapUrl: ["--bootstrap-url"],
    domain: ["--domain"],
    acmeEmail: ["--acme-email", "--email"],
    namespace: ["--namespace", "--ns"],
    vmName: ["--vm-name", "--vm"],
    tenantVmId: ["--tenant-vm-id", "--vm-id"],
    vmDisplayName: ["--vm-display-name"],
    kubeconfig: ["--kubeconfig"],
    publicIp: ["--public-ip", "--ip"],
    publicIpPorts: ["--public-ip-ports"],
    ports: ["--ports"],
    channel: ["--channel"],
    brokerBaseUrl: ["--broker-base-url", "--broker"],
    controlPlaneBaseUrl: ["--control-plane-base-url"],
    connectPublicBaseUrl: ["--connect-public-base-url", "--connect-base-url"],
    connectPublicSetupUrl: ["--connect-public-setup-url", "--setup-url"],
    targetBaseUrl: ["--target-base-url"],
    whatsappTargetBaseUrl: ["--whatsapp-target-base-url"],
    whatsappBrokerBaseUrl: ["--whatsapp-broker-base-url"],
    routeBrokerBaseUrl: ["--route-broker-base-url"],
    firstThreadName: ["--first-thread-name"],
    firstThreadId: ["--first-thread-id"],
    orkestrPort: ["--orkestr-port"],
    port: ["--port"],
  })) {
    const value = firstFlagValue(argv, flags);
    if (value) body[key] = value;
  }
  const sshPublicKeys = [
    ...repeatedFlagValues(argv, ["--ssh-key", "--ssh-public-key"]),
    ...(await sshKeysFromFile(firstFlagValue(argv, ["--ssh-keys-file", "--ssh-key-file"]), ctx)),
  ];
  if (sshPublicKeys.length) body.sshPublicKeys = sshPublicKeys;
  const runtimeEnv = keyValueObject(repeatedFlagValues(argv, ["--runtime-env", "--env"]));
  if (Object.keys(runtimeEnv).length) body.runtimeEnv = runtimeEnv;
  if (argv.includes("--with-whatsapp")) body.withWhatsapp = true;
  if (argv.includes("--no-whatsapp-route")) body.withWhatsapp = false;
  if (argv.includes("--no-tailscale")) body.noTailscale = true;
  return body;
}

async function sshKeysFromFile(file, ctx) {
  if (!file) return [];
  const raw = await fs.readFile(file, "utf8");
  return raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function formatTenantSliceTable(slices = []) {
  if (!slices.length) return "No tenant VM slices.\n";
  return [
    "SLICE\tOWNER\tSTATUS\tVM\tNAMESPACE\tPORT\tUPDATED",
    ...slices.map((slice) => [
      slice.id || "-",
      slice.ownerUserId || "-",
      slice.status || "-",
      slice.vm?.tenantVmId || slice.vm?.id || "-",
      slice.vm?.namespace || slice.vm?.kubevirt?.namespace || "-",
      slice.portBlock?.ports?.orkestr || "-",
      slice.updatedAt || slice.createdAt || "-",
    ].join("\t")),
  ].join("\n") + "\n";
}

function formatTenantSliceCreateOnly(payload = {}) {
  const slice = payload.tenantSlice || {};
  return [
    `Tenant VM slice ${payload.reused ? "reused" : "created"}: ${slice.id || "-"}`,
    `Owner: ${slice.ownerUserId || "-"}`,
    `Status: ${slice.status || "-"}`,
    `VM: ${slice.vm?.tenantVmId || slice.vm?.id || "-"} (${slice.vm?.namespace || "-"}/${slice.vm?.vmName || "-"})`,
    `Next: orkestr vm-slice provision ${slice.id || "<slice-id>"} --execute`,
  ].join("\n") + "\n";
}

function formatTenantSliceProvisionResult(payload = {}) {
  const slice = payload.tenantSlice || payload.provisioned?.tenantSlice || {};
  const plan = payload.provisioned || {};
  const vm = plan.tenantVm || slice.vm || {};
  const runtimeEnv = plan.runtimeEnv || {};
  const lines = [
    `Tenant VM slice ${payload.reused ? "reused" : slice.id ? "created" : "provisioned"}: ${slice.id || plan.tenantSlice?.id || "-"}`,
    `Owner: ${slice.ownerUserId || plan.tenantSlice?.ownerUserId || "-"}`,
    `Provisioning: ${plan.dryRun === false ? "executed" : "dry-run plan"}`,
    `Placement: ${plan.placement?.target || "local-k3s"} (${plan.placement?.kubeconfig || "/etc/rancher/k3s/k3s.yaml"})`,
    `VM: ${vm.id || vm.tenantVmId || "-"} (${plan.namespace || vm.kubevirt?.namespace || vm.namespace || "-"}/${plan.vmName || vm.kubevirt?.vmName || vm.vmName || "-"})`,
    `Resources: ${vm.resources?.vcpus || "-"} vCPU, ${vm.resources?.memoryMiB || "-"} MiB memory, ${vm.resources?.diskGiB || "-"} GiB disk`,
    `Runtime: ${runtimeEnv.ORKESTR_PUBLIC_URL || vm.endpoint?.baseUrl || "-"}`,
    `Setup: ${runtimeEnv.ORKESTR_CONNECT_PUBLIC_SETUP_URL || vm.endpoint?.setupUrl || "-"}`,
  ];
  if (plan.commands?.apply?.length) lines.push(`Apply command: ${plan.commands.apply.join(" ")}`);
  if (plan.dryRun !== false) lines.push("Next: rerun with --execute to apply the KubeVirt manifest.");
  if (plan.output?.stdout) lines.push(`stdout: ${String(plan.output.stdout).trim()}`);
  if (plan.output?.stderr) lines.push(`stderr: ${String(plan.output.stderr).trim()}`);
  return lines.join("\n") + "\n";
}

function formatTenantSliceRuntimeStatus(payload = {}) {
  const slice = payload.tenantSlice || {};
  const vm = payload.tenantVm || {};
  const service = payload.service || {};
  return [
    `Tenant VM slice: ${slice.id || "-"}`,
    `State: ${payload.ok === false ? "attention" : "ok"} (${service.activeState || slice.status || "-"}/${service.subState || "-"})`,
    `Owner: ${slice.ownerUserId || vm.ownerUserId || "-"}`,
    `VM: ${vm.id || slice.vm?.tenantVmId || "-"} (${service.namespace || vm.kubevirt?.namespace || "-"}/${service.name || vm.kubevirt?.vmName || "-"})`,
    payload.error ? `Error: ${payload.error}` : "",
  ].filter(Boolean).join("\n") + "\n";
}

function tenantSliceUsage() {
  return [
    "Usage:",
    "  orkestr vm-slice list [--json]",
    "  orkestr vm-slice create <owner-user-id> [--id slice-id] [--namespace ns] [--vm-name name] [--kubeconfig file] [--wa-participant jid]... [--wa-admin jid]... [--execute] [--json]",
    "  orkestr vm-slice provision <slice-id> [--execute] [--namespace ns] [--vm-name name] [--kubeconfig file] [--json]",
    "  orkestr vm-slice status <slice-id> [--json]",
  ].join("\n");
}

function tenantSliceCreateUsage() {
  return [
    "Usage: orkestr vm-slice create <owner-user-id> [--id slice-id] [--name display-name] [--namespace ns] [--vm-name name] [--kubeconfig file] [--wa-participant jid]... [--wa-admin jid]... [--execute] [--json]",
    "Dry-run is the default. Add --execute to apply the KubeVirt manifest.",
    "Tenant VMs default to /etc/rancher/k3s/k3s.yaml; ambient KUBECONFIG is ignored.",
  ].join("\n");
}

function ownerFromArgs(argv) {
  return flagValue(argv, "--owner") ||
    flagValue(argv, "--owner-user") ||
    flagValue(argv, "--owner-user-id") ||
    flagValue(argv, "--user") ||
    flagValue(argv, "--user-id") ||
    positional(argv)[0] ||
    "";
}

function numberFields(argv, spec) {
  const output = {};
  for (const [key, flags] of Object.entries(spec)) {
    const value = firstFlagValue(argv, flags);
    if (!value) continue;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) output[key] = numeric;
  }
  return output;
}

function keyValueObject(values = []) {
  const output = {};
  for (const value of values) {
    const separator = String(value).indexOf("=");
    if (separator <= 0) continue;
    const key = String(value).slice(0, separator).trim();
    const entryValue = String(value).slice(separator + 1).trim();
    if (key) output[key] = entryValue;
  }
  return output;
}

function firstFlagValue(argv, flags) {
  for (const flag of flags) {
    const value = flagValue(argv, flag);
    if (value) return value;
  }
  return "";
}

function repeatedFlagValues(argv, flags) {
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (flags.includes(argv[index])) values.push(argv[index + 1] || "");
  }
  return values.map((value) => String(value || "").trim()).filter(Boolean);
}

function uniqueList(values = []) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function positional(argv) {
  const flagsWithValues = new Set([
    "--acme-email",
    "--admin-participant",
    "--broker",
    "--broker-base-url",
    "--capability",
    "--cap",
    "--channel",
    "--chat-id",
    "--connect-base-url",
    "--connect-public-base-url",
    "--connect-public-setup-url",
    "--control-plane-base-url",
    "--cpu",
    "--cpu-quota",
    "--cpu-quota-percent",
    "--daily-budget",
    "--daily-usd",
    "--desktop",
    "--desktop-slug",
    "--disk",
    "--disk-gib",
    "--disk-soft-gib",
    "--display-name",
    "--domain",
    "--email",
    "--env",
    "--first-thread-id",
    "--first-thread-name",
    "--git-ref",
    "--gmail-account",
    "--gmail-account-id",
    "--id",
    "--image-url",
    "--ip",
    "--kubeconfig",
    "--label",
    "--linkedin-desktop",
    "--memory",
    "--memory-high",
    "--memory-high-mib",
    "--memory-max-mib",
    "--memory-mib",
    "--monthly-budget",
    "--monthly-usd",
    "--name",
    "--namespace",
    "--ns",
    "--orkestr-port",
    "--participant",
    "--owner",
    "--owner-user",
    "--owner-user-id",
    "--port",
    "--ports",
    "--public-ip",
    "--public-ip-ports",
    "--ref",
    "--repo",
    "--repo-url",
    "--route-broker-base-url",
    "--runtime-env",
    "--setup-url",
    "--slice-id",
    "--ssh-key",
    "--ssh-key-file",
    "--ssh-keys-file",
    "--ssh-public-key",
    "--storage-class",
    "--target-base-url",
    "--tasks-max",
    "--tenant-slice-id",
    "--tenant-vm-id",
    "--user",
    "--user-id",
    "--vm",
    "--vm-display-name",
    "--vm-id",
    "--vm-name",
    "--wa-account",
    "--wa-account-id",
    "--wa-admin",
    "--wa-chat-id",
    "--wa-participant",
    "--whatsapp-account-id",
    "--whatsapp-admin",
    "--whatsapp-broker-base-url",
    "--whatsapp-chat-id",
    "--whatsapp-participant",
    "--whatsapp-target-base-url",
  ]);
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (flagsWithValues.has(value)) {
      index += 1;
      continue;
    }
    if (String(value || "").startsWith("--")) continue;
    values.push(value);
  }
  return values;
}

function flagValue(argv, flag) {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : "";
}

function clean(value = "") {
  return String(value || "").trim();
}
