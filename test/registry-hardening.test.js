import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { planRegistryHardening, qualifyRegistryHardening, registrySnapshotHash } from "../scripts/security/registry-hardening.mjs";

const image = `registry.example.test/distribution@sha256:${"a".repeat(64)}`;
const approved = fields => ({ reviewed: true, evidenceRef: "review:synthetic-fixture", ...fields });
function fixture() {
  const deployment = {
    apiVersion: "apps/v1", kind: "Deployment", metadata: { name: "registry", namespace: "images", uid: "fixture-registry-uid", resourceVersion: "21" },
    spec: { replicas: 1, template: { metadata: { labels: { app: "registry" } }, spec: {
      containers: [{ name: "registry", image: "registry:2", ports: [{ containerPort: 5000, hostPort: 5000, hostIP: "127.0.0.1" }],
        env: [{ name: "REGISTRY_STORAGE_DELETE_ENABLED", value: "true" }, { name: "PRESERVED_PRIVATE_VALUE", value: "fixture-never-emit-this-value" }],
        volumeMounts: [{ name: "registry-data", mountPath: "/var/lib/registry" }],
        resources: { limits: { "ephemeral-storage": "1Gi" } },
      }], volumes: [{ name: "registry-data", persistentVolumeClaim: { claimName: "registry-private-data" } }],
    } } },
  };
  const snapshot = { deployment,
    service: { apiVersion: "v1", kind: "Service", metadata: { name: "registry", namespace: "images" }, spec: { type: "ClusterIP", selector: { app: "registry" }, ports: [{ port: 5000 }] } },
    networkPolicies: [{ apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy", metadata: { name: "registry-deny", namespace: "images" }, spec: { podSelector: { matchLabels: { app: "registry" } }, policyTypes: ["Ingress"], ingress: [] } }],
  };
  const pod = deployment.spec.template.spec;
  const review = {
    target: { ...deployment.metadata, containerName: "registry" }, templateHash: registrySnapshotHash(deployment.spec.template), image,
    compatibility: approved({ image, sourceImage: "registry:2", implementation: "distribution", nonRoot: true, readOnlyRoot: true, envConfigurationVerified: true, runAsUser: 10001, runAsGroup: 10001, writableMounts: ["/var/lib/registry"] }),
    storage: approved({ snapshotHash: registrySnapshotHash({ volumes: pod.volumes, mounts: pod.containers[0].volumeMounts }), volumeName: "registry-data", mountPath: "/var/lib/registry", permissionsCompatible: true, scratchWritesCovered: true, noServiceAccountCredentials: true }),
    exposure: approved({ snapshotHash: registrySnapshotHash({ service: snapshot.service, networkPolicies: snapshot.networkPolicies }), completePolicyInventory: true, loopbackHostAccess: true, publicIpv4Denied: true, publicIpv6Denied: true }),
    resources: approved({ requests: { cpu: "50m", memory: "64Mi" }, limits: { cpu: "500m", memory: "256Mi" } }),
    auth: approved({ mode: "htpasswd", secretName: "registry-credentials", secretKey: "htpasswd", volumeName: "registry-auth", mountPath: "/run/registry-auth", secretKeyVerified: true, consumerCredentialsStaged: true, fileReadableByReviewedIdentity: true,
      consumers: [{ id: "fixture-workload", credentialRef: "secret-reference:workload-pull", evidenceRef: "review:consumer-compatibility" }] }),
    deletion: approved({ disabled: true }),
    rollout: approved({ windowRef: "change:planned-window", rollbackSnapshotRef: "private-artifact:deployment-before", noCanaryMutation: true }),
    recovery: approved({ immutableOffHostDestinationRef: "backup:approved-immutable-destination", isolatedRestorePlanRef: "runbook:isolated-restore" }),
  };
  return { snapshot, review };
}

function refreshHashes(input) {
  const pod = input.snapshot.deployment.spec.template.spec;
  input.review.templateHash = registrySnapshotHash(input.snapshot.deployment.spec.template);
  input.review.storage.snapshotHash = registrySnapshotHash({ volumes: pod.volumes, mounts: pod.containers[0].volumeMounts });
  input.review.exposure.snapshotHash = registrySnapshotHash({ service: input.snapshot.service, networkPolicies: input.snapshot.networkPolicies });
}

function applyPatch(source, operations) {
  const result = structuredClone(source);
  for (const operation of operations) {
    const keys = operation.path.split("/").slice(1), key = keys.pop();
    const parent = keys.reduce((value, part) => value[part], result);
    if (operation.op === "test") assert.deepEqual(parent[key], operation.value);
    else if (key === "-") parent.push(structuredClone(operation.value));
    else parent[key] = structuredClone(operation.value);
  }
  return result;
}

test("offline patch hardens the exact registry while preserving storage, exposure and unrelated values", () => {
  const input = fixture(), original = structuredClone(input), plan = planRegistryHardening(input);
  assert.deepEqual(input, original, "planning is non-mutating");
  assert.equal(plan.qualification.status, "pending");
  assert.equal(plan.qualification.missing.length, 15);
  assert.equal(JSON.stringify(plan).includes("fixture-never-emit-this-value"), false);
  const patched = applyPatch(input.snapshot.deployment, plan.patch), pod = patched.spec.template.spec, container = pod.containers[0];
  assert.equal(container.image, image); assert.equal(pod.automountServiceAccountToken, false);
  assert.deepEqual(pod.securityContext.seccompProfile, { type: "RuntimeDefault" });
  assert.deepEqual(container.securityContext, { runAsNonRoot: true, runAsUser: 10001, runAsGroup: 10001, privileged: false, allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] }, seccompProfile: { type: "RuntimeDefault" } });
  assert.deepEqual(pod.volumes[0], input.snapshot.deployment.spec.template.spec.volumes[0]);
  assert.deepEqual(container.volumeMounts[0], input.snapshot.deployment.spec.template.spec.containers[0].volumeMounts[0]);
  assert.deepEqual(container.ports, input.snapshot.deployment.spec.template.spec.containers[0].ports);
  assert.equal(container.resources.limits["ephemeral-storage"], "1Gi");
  assert.equal(container.env.find(row => row.name === "REGISTRY_STORAGE_DELETE_ENABLED").value, "false");
  assert.equal(container.env.find(row => row.name === "PRESERVED_PRIVATE_VALUE").value, "fixture-never-emit-this-value");
  assert.deepEqual(pod.volumes[1].secret, { secretName: "registry-credentials", defaultMode: 292, items: [{ key: "htpasswd", path: "htpasswd" }] });
  assert.equal(container.volumeMounts[1].readOnly, true);
  assert.equal(plan.patch.every(operation => operation.path.startsWith("/spec/template/spec/") || operation.op === "test"), true);
  const stale = structuredClone(input.snapshot.deployment); stale.metadata.resourceVersion = "22";
  assert.throws(() => applyPatch(stale, plan.patch));
});

test("every rollout review is mandatory and source versions, storage and compatibility cannot drift", () => {
  for (const section of ["compatibility", "storage", "exposure", "resources", "auth", "deletion", "rollout", "recovery"]) {
    const input = fixture(); input.review[section].reviewed = false;
    assert.throws(() => planRegistryHardening(input), /review_required/, section);
  }
  for (const [mutate, code] of [
    [input => { input.review.target.resourceVersion = "20"; }, /target_version_changed/],
    [input => { input.review.target.uid = "other"; }, /target_version_changed/],
    [input => { input.snapshot.deployment.spec.template.spec.containers[0].image = "registry:latest"; }, /template_review_changed/],
    [input => { input.review.image = "registry:latest"; }, /approved_digest_required/],
    [input => { input.review.compatibility.runAsUser = 0; }, /non_root_identity_required/],
    [input => { input.review.compatibility.readOnlyRoot = false; }, /runtime_compatibility_required/],
    [input => { input.review.compatibility.writableMounts = []; }, /writable_mount_review_changed/],
    [input => { input.review.storage.snapshotHash = "changed"; }, /storage_review_changed/],
    [input => { input.review.resources.limits.cpu = "1m"; }, /limit_below_request/],
    [input => { input.review.resources.requests.memory = "0"; }, /quantity_invalid/],
    [input => { input.review.auth.password = "must-not-be-used"; }, /secret_values_forbidden/],
    [input => { input.review.auth.consumers = []; }, /auth_consumers_required/],
    [input => { input.review.auth.mountPath = "/var/lib"; }, /mount_overlaps_storage/],
    [input => { input.review.auth.consumerCredentialsStaged = false; }, /auth_rollout_review_required/],
    [input => { input.review.deletion.disabled = false; }, /deletion_must_be_disabled/],
    [input => { input.review.recovery.isolatedRestorePlanRef = ""; }, /recovery_plan_required/],
  ]) {
    const input = fixture(); mutate(input); assert.throws(() => planRegistryHardening(input), code);
  }
});

test("review cannot authorize public exposure, explicit API tokens or additive ingress policies", () => {
  for (const [mutate, code] of [
    [input => { input.snapshot.service.spec.type = "NodePort"; }, /service_public_exposure/],
    [input => { input.snapshot.service.spec.externalIPs = ["203.0.113.20"]; }, /service_public_exposure/],
    [input => { input.snapshot.networkPolicies[0].spec.ingress = [{}]; }, /additive_ingress_allow/],
    [input => { input.snapshot.networkPolicies.push({ ...structuredClone(input.snapshot.networkPolicies[0]), spec: { podSelector: {}, ingress: [{}] } }); }, /additive_ingress_allow/],
    [input => { input.snapshot.networkPolicies = []; }, /deny_all_ingress_required/],
    [input => { input.snapshot.deployment.spec.template.spec.containers[0].ports[0].hostIP = "0.0.0.0"; }, /host_port_not_loopback/],
    [input => { input.snapshot.deployment.spec.template.spec.hostNetwork = true; }, /host_namespace_unsupported/],
    [input => { input.snapshot.deployment.spec.template.spec.volumes.push({ name: "api-token", projected: { sources: [{ serviceAccountToken: { path: "token" } }] } }); }, /explicit_service_account_token/],
    [input => { input.snapshot.deployment.spec.template.spec.initContainers = [{ name: "unreviewed" }]; }, /single_container_required/],
  ]) {
    const input = fixture(); mutate(input); refreshHashes(input); assert.throws(() => planRegistryHardening(input), code);
  }
});

test("qualification remains pending until current post-rollout evidence covers the exact plan", () => {
  const input = fixture(), plan = planRegistryHardening(input), now = Date.now();
  const evidence = { planHash: plan.planHash, targetUid: plan.target.uid, deployedResourceVersion: "22", image, observedAt: new Date(now).toISOString(),
    checks: Object.fromEntries(plan.qualification.missing.map(key => [key, { passed: true, evidenceRef: `evidence:${key}` }])) };
  assert.equal(qualifyRegistryHardening(plan, evidence, now).status, "recorded_evidence_complete");
  assert.match(qualifyRegistryHardening(plan, evidence, now).source, /not_executed_by_this_tool/);
  for (const override of [{ planHash: "other" }, { deployedResourceVersion: "21" }, { image: "registry:latest" }, { observedAt: new Date(now - 25 * 60 * 60_000).toISOString() }]) {
    assert.equal(qualifyRegistryHardening(plan, { ...evidence, ...override }, now).status, "pending");
  }
  evidence.checks.isolatedRestoreVerified.passed = false;
  assert.deepEqual(qualifyRegistryHardening(plan, evidence, now).missing, ["isolatedRestoreVerified"]);
  input.review.rollout.evidenceRef = "review:changed-rollout";
  assert.notEqual(planRegistryHardening(input).planHash, plan.planHash);
});

test("CLI uses only the supplied offline file and fails without printing malformed input", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "registry-plan-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "input.json"); await fs.writeFile(file, JSON.stringify(fixture()));
  const command = ["scripts/security/registry-hardening.mjs", "--input", file];
  const planned = spawnSync(process.execPath, command, { encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.equal(planned.status, 0, planned.stderr); assert.equal(JSON.parse(planned.stdout).mode, "offline_only");
  await fs.writeFile(file, "not-json fixture-secret-never-echo");
  const rejected = spawnSync(process.execPath, command, { encoding: "utf8", env: {} });
  assert.equal(rejected.status, 2); assert.equal(rejected.stdout, "");
  assert.equal(rejected.stderr.includes("fixture-secret-never-echo"), false);
});
