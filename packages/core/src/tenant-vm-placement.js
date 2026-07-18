export const DEFAULT_TENANT_VM_KUBECONFIG = "/etc/rancher/k3s/k3s.yaml";

function clean(value = "") {
  return String(value || "").trim();
}

export function resolveTenantVmPlacement(input = {}, env = process.env) {
  const explicitKubeconfig = clean(input.kubeconfig);
  const configuredKubeconfig = clean(env.ORKESTR_TENANT_VM_KUBECONFIG);
  const kubeconfig = explicitKubeconfig || configuredKubeconfig || DEFAULT_TENANT_VM_KUBECONFIG;
  const source = explicitKubeconfig
    ? "request"
    : configuredKubeconfig
      ? "tenant-vm-config"
      : "local-k3s-default";
  return {
    provider: "kubevirt",
    target: source === "local-k3s-default" ? "local-k3s" : "explicit-kubeconfig",
    kubeconfig,
    source,
  };
}

export function tenantVmProvisioningEnv(input = {}, env = process.env, baseEnv = process.env) {
  const placement = resolveTenantVmPlacement(input, env);
  return {
    ...baseEnv,
    ...env,
    // Never let an ambient KUBECONFIG choose where tenant VMs are created.
    KUBECONFIG: placement.kubeconfig,
  };
}
