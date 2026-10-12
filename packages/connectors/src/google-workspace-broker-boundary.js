import { getTenantVm } from "../../core/src/tenant-vm-registry.js";
import { normalizeUserId } from "../../core/src/users.js";

function clean(value = "") {
  return String(value ?? "").trim();
}

function denied(code, statusCode = 403) {
  return Object.assign(new Error(code), { code, statusCode });
}

export async function assertBrokerGoogleWorkspaceTenant(record = {}, payload = {}, env = process.env) {
  const tenantVmId = clean(payload.tenantVmId);
  const userId = normalizeUserId(payload.userId || "");
  if (!tenantVmId || !userId) throw denied("broker_google_workspace_tenant_required", 400);
  const vm = await getTenantVm(tenantVmId, env);
  if (!vm || vm.deletedAt) throw denied("broker_google_workspace_tenant_not_found", 404);
  if (clean(vm.labels?.brokerInstanceId) !== clean(record.instanceId) || vm.ownerUserId !== userId) {
    throw denied("broker_google_workspace_tenant_mismatch");
  }
  return { tenantVmId: vm.id, userId: vm.ownerUserId };
}

export function assertBrokerGoogleWorkspaceGrantDestination(registration = {}, payload = {}, env = process.env) {
  const registeredInstance = clean(registration.instanceId);
  const statedInstance = clean(payload.brokerInstanceId);
  const tenantVmId = clean(env.ORKESTR_TENANT_VM_ID);
  if (!registeredInstance || !tenantVmId || !statedInstance || !clean(payload.tenantVmId)) {
    throw denied("broker_google_workspace_grant_destination_required", 400);
  }
  if (statedInstance !== registeredInstance || clean(payload.tenantVmId) !== tenantVmId) {
    throw denied("broker_google_workspace_grant_destination_mismatch");
  }
  return { brokerInstanceId: registeredInstance, tenantVmId };
}
