#!/usr/bin/env node
// Offline only. No Kubernetes, registry, provider or credential API is called.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";

function requireValue(condition, code) {
  if (!condition) throw new Error(code);
}
const record = value => value && typeof value === "object" && !Array.isArray(value);
const text = value => typeof value === "string" && value.length > 0 && value.length <= 240 && !/[\r\n\0]/.test(value);
const name = value => typeof value === "string" && /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(value);
const digestImage = value => typeof value === "string" && /^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$/.test(value);
const mountPath = value => typeof value === "string" && /^\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(value) && !value.split("/").some(part => [".", ".."].includes(part));
const overlaps = (left, right) => left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
const sorted = value => Array.isArray(value) ? value.map(sorted) : record(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
export const registrySnapshotHash = value => createHash("sha256").update(JSON.stringify(sorted(value))).digest("hex");

function reviewed(value, code) {
  requireValue(record(value) && value.reviewed === true && text(value.evidenceRef), `${code}_review_required`);
}

function quantity(value, type) {
  requireValue(typeof value === "string", "resource_quantity_invalid");
  const match = value.match(type === "cpu" ? /^(\d+(?:\.\d+)?)(m?)$/ : /^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti|K|M|G|T)?$/);
  requireValue(match, "resource_quantity_invalid");
  const suffix = match[2] || "";
  const scale = type === "cpu" ? (suffix === "m" ? 0.001 : 1)
    : ({ Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, K: 1e3, M: 1e6, G: 1e9, T: 1e12 }[suffix] || 1);
  const result = Number(match[1]) * scale;
  requireValue(Number.isFinite(result) && result > 0, "resource_quantity_invalid");
  return result;
}

function selectorMatches(selector, labels) {
  requireValue(record(selector), "exposure_selector_required");
  if (!Object.entries(selector.matchLabels || {}).every(([key, value]) => labels[key] === value)) return false;
  for (const expression of selector.matchExpressions || []) {
    const present = Object.hasOwn(labels, expression.key), values = expression.values || [];
    switch (expression.operator) {
      case "In": if (!present || !values.includes(labels[expression.key])) return false; break;
      case "NotIn": if (present && values.includes(labels[expression.key])) return false; break;
      case "Exists": if (!present) return false; break;
      case "DoesNotExist": if (present) return false; break;
      default: throw new Error("exposure_selector_unsupported");
    }
  }
  return true;
}

function verifyExposure(snapshot, deployment, container, review) {
  reviewed(review, "exposure");
  requireValue(review.snapshotHash === registrySnapshotHash({ service: snapshot.service, networkPolicies: snapshot.networkPolicies }), "exposure_snapshot_changed");
  requireValue(review.completePolicyInventory === true && review.loopbackHostAccess === true && review.publicIpv4Denied === true && review.publicIpv6Denied === true, "exposure_review_incomplete");
  const service = snapshot.service, namespace = deployment.metadata.namespace;
  requireValue(service?.kind === "Service" && service.apiVersion === "v1" && service.metadata?.namespace === namespace, "registry_service_required");
  requireValue((service.spec?.type || "ClusterIP") === "ClusterIP" && !service.spec?.externalIPs?.length && !service.spec?.externalName && !service.spec?.loadBalancerIP, "registry_service_public_exposure");
  const labels = deployment.spec.template.metadata?.labels || {};
  requireValue(Object.keys(service.spec.selector || {}).length > 0 && Object.entries(service.spec.selector).every(([key, value]) => labels[key] === value), "registry_service_selector_mismatch");
  const pod = deployment.spec.template.spec;
  requireValue(!pod.hostNetwork && !pod.hostPID && !pod.hostIPC, "registry_host_namespace_unsupported");
  for (const port of container.ports || []) {
    requireValue(!port.hostPort || ["127.0.0.1", "::1"].includes(port.hostIP), "registry_host_port_not_loopback");
  }
  requireValue(Array.isArray(snapshot.networkPolicies), "registry_network_policy_inventory_required");
  let denied = false;
  for (const policy of snapshot.networkPolicies) {
    requireValue(policy?.kind === "NetworkPolicy" && policy.apiVersion === "networking.k8s.io/v1", "registry_network_policy_invalid");
    if (policy.metadata?.namespace !== namespace || !selectorMatches(policy.spec?.podSelector, labels)) continue;
    if (policy.spec.policyTypes && !policy.spec.policyTypes.includes("Ingress")) continue;
    requireValue(!policy.spec.ingress?.length, "registry_additive_ingress_allow");
    denied = true;
  }
  requireValue(denied, "registry_deny_all_ingress_required");
}

const qualificationChecks = Object.freeze([
  "rolloutReady", "digestVerified", "nonRootReadOnlyVerified", "tokenNotMounted",
  "loopbackOnly", "clusterIpOnly", "denyAllIngress", "publicIpv4Denied", "publicIpv6Denied",
  "unauthenticatedMutationDenied", "approvedConsumerDigestReadable", "deletionDisabled",
  "immutableOffHostBackupFresh", "isolatedRestoreVerified", "rollbackAvailable",
]);

export function qualifyRegistryHardening(plan, evidence = {}, now = Date.now()) {
  const samePlan = evidence.planHash === plan.planHash && evidence.targetUid === plan.target.uid && evidence.image === plan.image &&
    /^\d+$/.test(evidence.deployedResourceVersion || "") && evidence.deployedResourceVersion !== plan.target.resourceVersion;
  const observed = Date.parse(evidence.observedAt || "");
  const current = Number.isFinite(observed) && observed <= now && now - observed <= 24 * 60 * 60_000;
  const missing = qualificationChecks.filter(key => !samePlan || !current || evidence.checks?.[key]?.passed !== true || !text(evidence.checks?.[key]?.evidenceRef));
  return {
    source: "operator_supplied_evidence_not_executed_by_this_tool",
    status: missing.length ? "pending" : "recorded_evidence_complete",
    missing,
  };
}

export function planRegistryHardening(input) {
  requireValue(record(input?.snapshot) && record(input?.review), "registry_snapshot_and_review_required");
  const { snapshot, review } = input, deployment = snapshot.deployment;
  requireValue(deployment?.kind === "Deployment" && deployment.apiVersion === "apps/v1", "registry_deployment_required");
  const metadata = deployment.metadata || {}, target = review.target || {};
  requireValue(name(metadata.name) && name(metadata.namespace) && text(metadata.uid) && /^\d+$/.test(metadata.resourceVersion || ""), "registry_version_identity_required");
  requireValue(["name", "namespace", "uid", "resourceVersion"].every(key => target[key] === metadata[key]), "registry_target_version_changed");
  const template = deployment.spec?.template, pod = template?.spec;
  requireValue(record(pod) && review.templateHash === registrySnapshotHash(template), "registry_template_review_changed");
  requireValue(pod.containers?.length === 1 && !pod.initContainers?.length && !pod.ephemeralContainers?.length, "registry_single_container_required");
  const container = pod.containers[0];
  requireValue(container.name === target.containerName && name(container.name), "registry_container_mismatch");
  requireValue(digestImage(review.image), "registry_approved_digest_required");
  reviewed(review.compatibility, "compatibility");
  const compatibility = review.compatibility;
  requireValue(compatibility.image === review.image && compatibility.sourceImage === container.image && compatibility.implementation === "distribution", "registry_image_compatibility_mismatch");
  requireValue(compatibility.nonRoot === true && compatibility.readOnlyRoot === true && compatibility.envConfigurationVerified === true, "registry_runtime_compatibility_required");
  requireValue(Number.isSafeInteger(compatibility.runAsUser) && compatibility.runAsUser > 0 && Number.isSafeInteger(compatibility.runAsGroup) && compatibility.runAsGroup > 0, "registry_non_root_identity_required");
  reviewed(review.storage, "storage");
  const mounts = container.volumeMounts || [], volumes = pod.volumes || [];
  requireValue(Array.isArray(mounts) && Array.isArray(volumes), "registry_storage_shape_invalid");
  requireValue(!volumes.some(volume => (volume.projected?.sources || []).some(source => source.serviceAccountToken)), "registry_explicit_service_account_token");
  requireValue(review.storage.snapshotHash === registrySnapshotHash({ volumes, mounts }), "registry_storage_review_changed");
  requireValue(review.storage.permissionsCompatible === true && review.storage.scratchWritesCovered === true && review.storage.noServiceAccountCredentials === true, "registry_storage_compatibility_required");
  requireValue(Array.isArray(compatibility.writableMounts), "registry_writable_mount_review_required");
  requireValue(mounts.every(mount => mountPath(mount.mountPath) && name(mount.name)), "registry_mount_invalid");
  requireValue(registrySnapshotHash(compatibility.writableMounts.slice().sort()) === registrySnapshotHash(mounts.filter(mount => mount.readOnly !== true).map(mount => mount.mountPath).sort()), "registry_writable_mount_review_changed");
  requireValue(mounts.some(mount => mount.name === review.storage.volumeName && mount.mountPath === review.storage.mountPath && mount.readOnly !== true), "registry_persistent_storage_mount_required");
  const storage = volumes.find(volume => volume.name === review.storage.volumeName);
  requireValue(storage && (storage.persistentVolumeClaim || storage.hostPath), "registry_persistent_storage_required");
  verifyExposure(snapshot, deployment, container, review.exposure);

  reviewed(review.resources, "resources");
  const resources = review.resources;
  for (const kind of ["cpu", "memory"]) requireValue(quantity(resources.requests?.[kind], kind) <= quantity(resources.limits?.[kind], kind), "registry_resources_limit_below_request");
  reviewed(review.auth, "auth");
  const auth = review.auth;
  requireValue(auth.mode === "htpasswd" && name(auth.secretName) && name(auth.volumeName) && typeof auth.secretKey === "string" && /^[A-Za-z0-9._-]{1,253}$/.test(auth.secretKey), "registry_auth_secret_reference_required");
  requireValue(auth.secretKeyVerified === true && auth.consumerCredentialsStaged === true && auth.fileReadableByReviewedIdentity === true, "registry_auth_rollout_review_required");
  requireValue(Array.isArray(auth.consumers) && auth.consumers.length > 0 && auth.consumers.every(consumer => text(consumer.id) && text(consumer.credentialRef) && text(consumer.evidenceRef)), "registry_auth_consumers_required");
  requireValue(!["secretValue", "password", "username", "data", "stringData", "token"].some(key => Object.hasOwn(auth, key)), "registry_secret_values_forbidden");
  requireValue(mountPath(auth.mountPath) && auth.mountPath !== "/" && !mounts.some(mount => overlaps(mount.mountPath, auth.mountPath)), "registry_auth_mount_overlaps_storage");
  requireValue(!volumes.some(volume => volume.name === auth.volumeName), "registry_auth_volume_already_exists");
  reviewed(review.deletion, "deletion");
  requireValue(review.deletion.disabled === true, "registry_deletion_must_be_disabled");
  reviewed(review.rollout, "rollout");
  requireValue(text(review.rollout.windowRef) && text(review.rollout.rollbackSnapshotRef) && review.rollout.noCanaryMutation === true, "registry_rollout_rollback_required");
  reviewed(review.recovery, "recovery");
  requireValue(text(review.recovery.immutableOffHostDestinationRef) && text(review.recovery.isolatedRestorePlanRef), "registry_recovery_plan_required");

  const patch = [
    { op: "test", path: "/metadata/uid", value: metadata.uid },
    { op: "test", path: "/metadata/resourceVersion", value: metadata.resourceVersion },
  ];
  const add = (path, value) => patch.push({ op: "add", path, value });
  const podPath = "/spec/template/spec", containerPath = `${podPath}/containers/0`;
  add(`${containerPath}/image`, review.image);
  add(`${podPath}/automountServiceAccountToken`, false);
  if (!record(pod.securityContext)) add(`${podPath}/securityContext`, {});
  add(`${podPath}/securityContext/seccompProfile`, { type: "RuntimeDefault" });
  if (!record(container.securityContext)) add(`${containerPath}/securityContext`, {});
  for (const [key, value] of Object.entries({ runAsNonRoot: true, runAsUser: compatibility.runAsUser, runAsGroup: compatibility.runAsGroup,
    privileged: false, allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] }, seccompProfile: { type: "RuntimeDefault" } })) add(`${containerPath}/securityContext/${key}`, value);
  // Preserve any reviewed extended resources instead of replacing the map.
  if (!record(container.resources)) add(`${containerPath}/resources`, {});
  for (const type of ["requests", "limits"]) {
    if (!record(container.resources?.[type])) add(`${containerPath}/resources/${type}`, {});
    for (const kind of ["cpu", "memory"]) add(`${containerPath}/resources/${type}/${kind}`, resources[type][kind]);
  }
  if (!Array.isArray(pod.volumes)) add(`${podPath}/volumes`, []);
  add(`${podPath}/volumes/-`, { name: auth.volumeName, secret: { secretName: auth.secretName, defaultMode: 292, items: [{ key: auth.secretKey, path: "htpasswd" }] } });
  if (!Array.isArray(container.volumeMounts)) add(`${containerPath}/volumeMounts`, []);
  add(`${containerPath}/volumeMounts/-`, { name: auth.volumeName, mountPath: auth.mountPath, readOnly: true });
  if (!Array.isArray(container.env)) add(`${containerPath}/env`, []);
  for (const [key, value] of Object.entries({ REGISTRY_AUTH: "htpasswd", REGISTRY_AUTH_HTPASSWD_REALM: "Registry", REGISTRY_AUTH_HTPASSWD_PATH: `${auth.mountPath}/htpasswd`, REGISTRY_STORAGE_DELETE_ENABLED: "false" })) {
    const entries = (container.env || []).flatMap((entry, index) => entry.name === key ? [index] : []);
    requireValue(entries.length <= 1, "registry_duplicate_managed_env");
    patch.push({ op: entries.length ? "replace" : "add", path: `${containerPath}/env/${entries.length ? entries[0] : "-"}`, value: { name: key, value } });
  }
  const plan = {
    schemaVersion: 1, mode: "offline_only", target: Object.fromEntries(["name", "namespace", "uid", "resourceVersion", "containerName"].map(key => [key, target[key]])), image: review.image,
    sourceTemplateHash: review.templateHash, sourceExposureHash: review.exposure.snapshotHash, reviewHash: registrySnapshotHash(review), patch,
    rollback: { snapshotRef: review.rollout.rollbackSnapshotRef, requiresFreshVersionAndReview: true },
    preservation: ["existing_storage_volumes_and_mounts", "workload_ports", "service", "network_policies", "unrelated_environment"],
    warnings: ["No registry or Kubernetes API was contacted.", "Secret values are neither required nor generated.", "Applying this patch is a separate reviewed rollout. No image pulls or mutation probes are authorized by this plan."],
  };
  plan.planHash = registrySnapshotHash(plan);
  plan.qualification = qualifyRegistryHardening(plan, input.qualification);
  return plan;
}

async function main() {
  requireValue(process.argv.length === 4 && process.argv[2] === "--input", "usage_registry_hardening_--input_reviewed_json");
  const file = await fs.open(process.argv[3], "r");
  let input;
  try {
    requireValue((await file.stat()).size <= 1024 * 1024, "registry_input_too_large");
    input = JSON.parse(await file.readFile("utf8"));
  } finally { await file.close(); }
  process.stdout.write(`${JSON.stringify(planRegistryHardening(input), null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    const code = /^[a-z0-9_-]+$/.test(error.message) ? error.message : "registry_input_invalid";
    process.stderr.write(`${JSON.stringify({ ok: false, error: code })}\n`); process.exitCode = 2;
  });
}
