import { requestJson } from "./api-client.js";

export async function destroyTenantSliceCommand(argv, ctx) {
  const json = argv.includes("--json");
  const tenantSliceId = tenantSliceIdFromArgs(argv);
  if (!tenantSliceId) throw new Error("Usage: orkestr vm-slice destroy <slice-id> [--execute] [--json]");
  const execute = argv.includes("--execute") || argv.includes("--apply");
  const payload = await requestJson(`/api/tenant-slices/${encodeURIComponent(tenantSliceId)}/destroy`, {
    ...ctx,
    method: "POST",
    body: { execute, dryRun: !execute || argv.includes("--dry-run") || argv.includes("--plan") },
  });
  if (json) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else ctx.stdout.write(formatTenantSliceDestructionResult(payload));
  return payload.ok === false ? 1 : 0;
}

function tenantSliceIdFromArgs(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (["--id", "--slice-id", "--tenant-slice-id"].includes(value)) return argv[index + 1] || "";
    if (!String(value || "").startsWith("--")) return value;
  }
  return "";
}

function formatTenantSliceDestructionResult(payload = {}) {
  const slice = payload.tenantSlice || {};
  const lines = [
    `Tenant VM slice ${payload.dryRun === false ? "destroyed" : "destruction plan"}: ${slice.id || "-"}`,
    `Namespace: ${payload.namespace || "-"}`,
    `VM: ${payload.vmName || "-"}`,
  ];
  if (payload.dryRun === false) lines.push("The slice VM resources and its local OAuth state were removed.");
  else lines.push("No resources were changed. Rerun with --execute to remove the VM resources and local OAuth state.");
  return lines.join("\n") + "\n";
}
