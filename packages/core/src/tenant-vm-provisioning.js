import { spawn } from "node:child_process";
import { tenantBootstrapProfileJson, buildTenantBootstrapProfile } from "./tenant-bootstrap-profile.js";
import { getTenantVm, publicTenantVm, setTenantVmStatus } from "./tenant-vm-registry.js";

const defaultImageUrl = "https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img";
const defaultBootstrapUrl = "https://raw.githubusercontent.com/otcan/orkestr/main/scripts/bootstrap-vps.sh";
const defaultRepoUrl = "https://github.com/otcan/orkestr.git";

function clean(value = "") {
  return String(value || "").trim();
}

function safeName(value = "", fallback = "orkestr-tenant") {
  const name = clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
  return name || fallback;
}

function safeLabelValue(value = "", fallback = "unknown") {
  const label = clean(value)
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "")
    .slice(0, 63);
  return label || fallback;
}

function singleQuote(value = "") {
  return `'${String(value).replace(/'/g, "'\"'\"'")}'`;
}

function envFileValue(value = "") {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function safePublicUrl(value, fallback, field) {
  const raw = clean(value || fallback);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    const error = new Error(`${field}_invalid`);
    error.statusCode = 400;
    throw error;
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    const error = new Error(`${field}_unsupported_protocol`);
    error.statusCode = 400;
    throw error;
  }
  if (parsed.username || parsed.password) {
    const error = new Error(`${field}_must_not_include_credentials`);
    error.statusCode = 400;
    throw error;
  }
  return raw;
}

function stringList(values = []) {
  const list = Array.isArray(values) ? values : String(values || "").split("\n");
  return [...new Set(list.map((value) => clean(value)).filter(Boolean))];
}

function sshPublicKeys(values = []) {
  return stringList(values)
    .filter((value) => /^(ssh-|ecdsa-|sk-ssh-|sk-ecdsa-)/.test(value))
    .filter((value) => !/[\r\n]/.test(value))
    .map((value) => value.slice(0, 4096));
}

function commandList(...items) {
  return items.flat().filter(Boolean);
}

function runtimeEnv(input = {}, env = process.env) {
  const source = input.runtimeEnv && typeof input.runtimeEnv === "object" && !Array.isArray(input.runtimeEnv) ? input.runtimeEnv : {};
  const demoEnabled = input.demoMode === true ||
    clean(source.ORKESTR_DEMO_MODE) ||
    clean(input.whatsappNumber || input.demoWhatsappNumber || env.ORKESTR_DEMO_WHATSAPP_NUMBER) ||
    clean(input.brokerBaseUrl || input.demoBrokerBaseUrl || env.ORKESTR_DEMO_BROKER_BASE_URL || env.ORKESTR_BROKER_BASE_URL);
  const values = {
    ORKESTR_DEMO_MODE: demoEnabled ? "1" : "",
    ORKESTR_DEMO_WHATSAPP_NUMBER: demoEnabled ? input.whatsappNumber || input.demoWhatsappNumber || env.ORKESTR_DEMO_WHATSAPP_NUMBER : "",
    ORKESTR_DEMO_BROKER_BASE_URL: demoEnabled ? input.brokerBaseUrl || input.demoBrokerBaseUrl || env.ORKESTR_DEMO_BROKER_BASE_URL || env.ORKESTR_BROKER_BASE_URL : "",
    ORKESTR_CONNECT_PUBLIC_BASE_URL: demoEnabled ? input.connectPublicBaseUrl || input.publicConnectBaseUrl || env.ORKESTR_CONNECT_PUBLIC_BASE_URL : "",
    ORKESTR_DEMO_BROKER_REGISTRATION_TOKEN: demoEnabled ? input.brokerRegistrationToken || env.ORKESTR_DEMO_BROKER_REGISTRATION_TOKEN || env.ORKESTR_BROKER_REGISTRATION_TOKEN : "",
    ORKESTR_INSTANCE_DESKTOPS_PROVISIONED: demoEnabled ? input.instanceDesktopsProvisioned ?? env.ORKESTR_INSTANCE_DESKTOPS_PROVISIONED ?? "0" : "",
    ORKESTR_BROKER_INSTANCE_STORE: demoEnabled ? input.brokerInstanceStore || env.ORKESTR_BROKER_INSTANCE_STORE || "sqlite" : "",
    ORKESTR_DEPLOY_CHANNEL: demoEnabled ? input.deployChannel || env.ORKESTR_DEPLOY_CHANNEL : "",
    ORKESTR_DEPLOY_TAGS_ONLY: demoEnabled ? input.deployTagsOnly ?? env.ORKESTR_DEPLOY_TAGS_ONLY : "",
    ORKESTR_UPDATE_REF: demoEnabled ? input.updateRef || env.ORKESTR_UPDATE_REF : "",
    ORKESTR_DEMO_CLOUDFLARE_DISABLE: demoEnabled ? input.demoCloudflareDisable ?? env.ORKESTR_DEMO_CLOUDFLARE_DISABLE ?? "1" : "",
    ...source,
  };
  return Object.fromEntries(
    Object.entries(values)
      .map(([key, value]) => [clean(key), clean(value)])
      .filter(([key, value]) => /^[A-Z][A-Z0-9_]*$/.test(key) && value && !/[\0\r\n]/.test(value)),
  );
}

function runtimeEnvFile(input = {}, env = process.env) {
  const entries = Object.entries(runtimeEnv(input, env));
  if (!entries.length) return "";
  return `${entries.map(([key, value]) => `${key}=${envFileValue(value)}`).join("\n")}\n`;
}

function tenantBootstrapProfilePath(input, env) {
  const value = clean(input.tenantBootstrapProfilePath || input.bootstrapProfilePath || env.ORKESTR_TENANT_BOOTSTRAP_PROFILE_PATH);
  if (!value) return "/etc/orkestr/tenant-bootstrap-profile.json";
  if (!value.startsWith("/") || /[\0\r\n]/.test(value)) {
    const error = new Error("tenant_bootstrap_profile_path_invalid");
    error.statusCode = 400;
    throw error;
  }
  return value;
}

function bootstrapArgs(vm, input, env) {
  const repoUrl = safePublicUrl(input.repoUrl || env.ORKESTR_PUBLIC_REPO_URL, defaultRepoUrl, "repo_url");
  const gitRef = clean(input.gitRef || env.ORKESTR_PUBLIC_GIT_REF || "main");
  const domain = clean(input.domain || vm.endpoint.domain);
  const acmeEmail = clean(input.acmeEmail || input.email || env.ORKESTR_ACME_EMAIL);
  const args = ["--repo", repoUrl, "--ref", gitRef, "--release-updates", "--channel", clean(input.channel || "tenant")];
  if (gitRef === "main") args.push("--track-main");
  if (domain) args.push("--domain", domain);
  if (acmeEmail) args.push("--email", acmeEmail);
  if (vm.capabilities.includes("whatsapp") || input.withWhatsapp === true) args.push("--with-whatsapp");
  args.push("--tenant-bootstrap-profile", tenantBootstrapProfilePath(input, env));
  if (input.noTailscale !== false) args.push("--no-tailscale");
  return args;
}

function cloudInitUserData(vm, input, env) {
  const vmName = safeName(vm.kubevirt.vmName || vm.id);
  const keys = sshPublicKeys(input.sshPublicKeys || input.sshKeys || []);
  const bootstrapUrl = safePublicUrl(input.bootstrapUrl || env.ORKESTR_BOOTSTRAP_VPS_URL, defaultBootstrapUrl, "bootstrap_url");
  const profilePath = tenantBootstrapProfilePath(input, env);
  const profileB64 = Buffer.from(tenantBootstrapProfileJson(vm, input, env), "utf8").toString("base64");
  const envFile = runtimeEnvFile(input, env);
  const args = bootstrapArgs(vm, input, env).map(singleQuote).join(" ");
  const bootstrapCommand = `curl -fsSL ${singleQuote(bootstrapUrl)} | bash -s -- ${args}`;
  const notifyCommand = "set -a; [ -r /etc/orkestr/orkestr.env ] && . /etc/orkestr/orkestr.env; set +a; if [ -n \"${ORKESTR_DEMO_WHATSAPP_NUMBER:-}\" ]; then cd \"${ORKESTR_CURRENT_LINK:-/opt/orkestr/current}\" || cd /opt/orkestr/app; node scripts/demo-vm-ready-notify.mjs; fi";
  const sshLines = keys.length
    ? ["    ssh_authorized_keys:", ...keys.map((key) => `      - ${key}`)]
    : [];
  const envFileLines = envFile
    ? [
      "  - path: /etc/orkestr/orkestr.env",
      "    owner: root:root",
      "    permissions: '0600'",
      "    encoding: b64",
      `    content: ${Buffer.from(envFile, "utf8").toString("base64")}`,
    ]
    : [];

  return [
    "#cloud-config",
    `hostname: ${vmName}`,
    "manage_etc_hosts: true",
    "ssh_pwauth: false",
    "users:",
    "  - default",
    "  - name: orkestr",
    "    gecos: Orkestr Tenant",
    "    groups: sudo",
    "    shell: /bin/bash",
    "    sudo: ALL=(ALL) NOPASSWD:ALL",
    "    lock_passwd: true",
    ...sshLines,
    "write_files:",
    `  - path: ${profilePath}`,
    "    owner: root:root",
    "    permissions: '0644'",
    "    encoding: b64",
    `    content: ${profileB64}`,
    ...envFileLines,
    "package_update: true",
    "packages:",
    "  - ca-certificates",
    "  - curl",
    "  - git",
    "  - openssh-server",
    "  - qemu-guest-agent",
    "runcmd:",
    "  - [systemctl, enable, --now, qemu-guest-agent]",
    "  - [systemctl, enable, --now, ssh]",
    `  - ${JSON.stringify(bootstrapCommand)}`,
    `  - ${JSON.stringify(notifyCommand)}`,
    "",
  ].join("\n");
}

export function buildTenantVmProvisioningPlan(vm, input = {}, env = process.env) {
  const namespace = safeName(input.namespace || vm.kubevirt.namespace || "orkestr-tenants");
  const vmName = safeName(input.vmName || vm.kubevirt.vmName || vm.id);
  const cloudInitSecretName = safeName(`${vmName}-cloudinit`, "orkestr-cloudinit");
  const imageUrl = safePublicUrl(input.imageUrl || env.ORKESTR_TENANT_VM_IMAGE_URL, defaultImageUrl, "image_url");
  const storageClass = clean(input.storageClass || vm.kubevirt.storageClass || env.ORKESTR_TENANT_VM_STORAGE_CLASS || "local-path");
  const memoryInput = Number(vm.resources.memoryMiB || 8192);
  const diskInput = Number(vm.resources.diskGiB || 100);
  const cpuInput = Number(vm.resources.vcpus || 2);
  const memoryMiB = Number.isFinite(memoryInput) ? Math.max(512, memoryInput) : 8192;
  const diskGiB = Number.isFinite(diskInput) ? Math.max(5, diskInput) : 100;
  const vcpus = Number.isFinite(cpuInput) ? Math.max(1, cpuInput) : 2;
  const publicIp = clean(input.publicIp || vm.endpoint.publicIp);
  const publicIpPorts = clean(input.publicIpPorts || input.ports || "22,80,443");

  const manifestObject = {
    apiVersion: "v1",
    kind: "List",
    items: [
      {
        apiVersion: "v1",
        kind: "Namespace",
        metadata: {
          name: namespace,
          labels: {
            "app.kubernetes.io/name": "orkestr-tenant",
            "orkestr.example.test/tenant-vm-id": safeLabelValue(vm.id),
            "orkestr.example.test/owner-user-id": safeLabelValue(vm.ownerUserId),
          },
        },
      },
      {
        apiVersion: "v1",
        kind: "Secret",
        metadata: {
          name: cloudInitSecretName,
          namespace,
          labels: {
            app: vmName,
            "app.kubernetes.io/name": "orkestr-tenant",
            "orkestr.example.test/tenant-vm-id": safeLabelValue(vm.id),
            "orkestr.example.test/owner-user-id": safeLabelValue(vm.ownerUserId),
          },
        },
        type: "Opaque",
        stringData: {
          userdata: cloudInitUserData(vm, input, env),
        },
      },
      {
        apiVersion: "kubevirt.io/v1",
        kind: "VirtualMachine",
        metadata: {
          name: vmName,
          namespace,
          labels: {
            app: vmName,
            "app.kubernetes.io/name": "orkestr-tenant",
            "orkestr.example.test/tenant-vm-id": safeLabelValue(vm.id),
            "orkestr.example.test/owner-user-id": safeLabelValue(vm.ownerUserId),
          },
        },
        spec: {
          runStrategy: "Always",
          dataVolumeTemplates: [
            {
              metadata: { name: `${vmName}-rootdisk` },
              spec: {
                source: { http: { url: imageUrl } },
                pvc: {
                  accessModes: ["ReadWriteOnce"],
                  storageClassName: storageClass,
                  resources: { requests: { storage: `${diskGiB}Gi` } },
                },
              },
            },
          ],
          template: {
            metadata: { labels: { app: vmName, "kubevirt.io/domain": vmName } },
            spec: {
              domain: {
                cpu: { cores: vcpus },
                resources: { requests: { memory: `${memoryMiB}Mi` } },
                devices: {
                  disks: [
                    { name: "rootdisk", disk: { bus: "virtio" } },
                    { name: "cloudinitdisk", disk: { bus: "virtio" } },
                  ],
                  interfaces: [{ name: "default", bridge: {} }],
                },
              },
              networks: [{ name: "default", pod: {} }],
              volumes: [
                { name: "rootdisk", dataVolume: { name: `${vmName}-rootdisk` } },
                { name: "cloudinitdisk", cloudInitNoCloud: { secretRef: { name: cloudInitSecretName } } },
              ],
            },
          },
        },
      },
    ],
  };

  return {
    namespace,
    vmName,
    cloudInitSecretName,
    bootstrapProfilePath: tenantBootstrapProfilePath(input, env),
    bootstrapProfile: buildTenantBootstrapProfile(vm, input, env),
    manifestObject,
    manifest: `${JSON.stringify(manifestObject, null, 2)}\n`,
    commands: {
      apply: commandList(clean(env.ORKESTR_KUBECTL || "kubectl"), "apply", "-f", "-"),
      publicIpRoute: publicIp
        ? commandList(
          "bash",
          "scripts/k3s-vm-public-ip.sh",
          "install-systemd",
          "--namespace",
          namespace,
          "--vm",
          vmName,
          "--public-ip",
          publicIp,
          "--ports",
          publicIpPorts,
        )
        : [],
    },
  };
}

function spawnWithInput(command, args, options, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const error = new Error(`kubectl_apply_failed:${code}`);
      error.statusCode = 500;
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
    child.stdin.end(input);
  });
}

export async function provisionTenantVm(tenantVmId, input = {}, env = process.env, options = {}) {
  const vm = await getTenantVm(tenantVmId, env);
  if (!vm) {
    const error = new Error("tenant_vm_not_found");
    error.statusCode = 404;
    throw error;
  }
  const plan = buildTenantVmProvisioningPlan(vm, input, env);
  const execute = input.execute === true && input.dryRun !== true;
  const result = {
    ok: true,
    dryRun: !execute,
    tenantVm: publicTenantVm(vm),
    namespace: plan.namespace,
    vmName: plan.vmName,
    cloudInitSecretName: plan.cloudInitSecretName,
    bootstrapProfilePath: plan.bootstrapProfilePath,
    bootstrapProfile: plan.bootstrapProfile,
    manifest: plan.manifest,
    commands: plan.commands,
  };
  if (!execute) return result;

  const [command, ...args] = plan.commands.apply;
  const runner = options.spawnWithInput || spawnWithInput;
  try {
    const output = await runner(command, args, {
      env: { ...process.env, ...env, ...(input.kubeconfig ? { KUBECONFIG: clean(input.kubeconfig) } : {}) },
      maxBuffer: 1024 * 1024 * 16,
    }, plan.manifest);
    const tenantVm = await setTenantVmStatus(tenantVmId, "provisioning", { lastError: "" }, env);
    return { ...result, dryRun: false, tenantVm: publicTenantVm(tenantVm), output };
  } catch (error) {
    await setTenantVmStatus(tenantVmId, "error", { lastError: clean(error.stderr || error.message).slice(0, 1000) }, env).catch(() => {});
    throw error;
  }
}
