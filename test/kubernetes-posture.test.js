import assert from "node:assert/strict";
import test from "node:test";
import { inspectKubernetesPosture as inspect, planDisableTokenAutomount as plan } from "../scripts/security/kubernetes-posture.mjs";

const account = { kind: "ServiceAccount", metadata: { name: "app", namespace: "example" }, automountServiceAccountToken: false };
const workload = () => ({ kind: "Deployment", metadata: { name: "app", namespace: "example", resourceVersion: "42" },
  spec: { template: { spec: { serviceAccountName: "app", containers: [{ name: "app", image: "example.invalid/app:example" }] } } } });
const rules = report => report.findings.map(f => f.rule);

test("effective service-account automount honors pod override and default identity", () => {
  const pod = workload();
  assert.equal(inspect([pod, account]).ok, true);
  pod.spec.template.spec.automountServiceAccountToken = true;
  assert.deepEqual(rules(inspect([pod, account])), ["api_token"]);
  delete pod.spec.template.spec.serviceAccountName;
  delete pod.spec.template.spec.automountServiceAccountToken;
  assert.deepEqual(rules(inspect([pod])), ["default_identity", "implicit_automount", "api_token", "service_account_not_in_inventory"]);
});

test("manual projected tokens are caught even when automount is false", () => {
  const pod = workload();
  pod.spec.template.spec.volumes = [{ name: "manual", projected: { sources: [{ serviceAccountToken: { path: "token" } }] } }];
  assert.deepEqual(rules(inspect([pod, account])), ["projected_token"]);
  assert.throws(() => plan(pod, { owner: "operator", reason: "no API", kubernetesApiRequired: false }), /review_required/);
});

test("default identity exception cannot waive missing service-account inventory", () => {
  const pod = workload();
  delete pod.spec.template.spec.serviceAccountName;
  pod.spec.template.spec.automountServiceAccountToken = false;
  const policy = { now: Date.parse("2026-01-01"), exceptions: [{ kind: "Deployment", namespace: "example", name: "app",
    rule: "default_identity", owner: "operator", reason: "reviewed migration", expiresAt: "2026-01-02" }] };
  const report = inspect([pod], policy);
  assert.equal(report.ok, false);
  assert.deepEqual(rules(report), ["service_account_not_in_inventory"]);
  assert.equal(inspect([pod, { ...account, metadata: { name: "default", namespace: "example" } }], policy).ok, true);
  assert.throws(() => inspect([pod], { ...policy, exceptions: [{ ...policy.exceptions[0], rule: "service_account_not_in_inventory" }] }), /invalid_or_expired_exception/);
});

test("ephemeral container legacy-token references cannot evade workload lint", () => {
  const pod = workload();
  pod.spec.template.spec.ephemeralContainers = [{ name: "debug", env: [{ name: "TOKEN",
    valueFrom: { secretKeyRef: { name: "legacy", key: "token" } } }] }];
  const secret = { kind: "Secret", metadata: { name: "legacy", namespace: "example" }, type: "kubernetes.io/service-account-token" };
  const report = inspect([pod, account, secret]);
  assert.equal(report.ok, false);
  assert.deepEqual(rules(report), ["legacy_token"]);
  assert.doesNotMatch(JSON.stringify(report), /debug|TOKEN|secretKeyRef/);
});

test("legacy token Secret metadata detects volume, projection and environment mounting", () => {
  const secret = { kind: "Secret", metadata: { name: "legacy", namespace: "example" }, type: "kubernetes.io/service-account-token" };
  for (const volume of [{ name: "token", secret: { secretName: "legacy" } },
    { name: "token", projected: { sources: [{ secret: { name: "legacy" } }] } }]) {
    const pod = workload(); pod.spec.template.spec.volumes = [volume];
    assert.deepEqual(rules(inspect([pod, account, secret])), ["legacy_token"]);
  }
  const pod = workload(); pod.spec.template.spec.containers[0].envFrom = [{ secretRef: { name: "legacy" } }];
  assert.deepEqual(rules(inspect([pod, account, secret])), ["legacy_token"]);
  assert.equal(inspect([]).ok, false);
  assert.throws(() => inspect([{ kind: "ClusterRole", metadata: { name: "role", namespace: "unexpected" } }]), /cluster_object_has_namespace/);
});

test("exceptions require exact identity, owner, reason and bounded expiry", () => {
  const pod = workload(); pod.spec.template.spec.automountServiceAccountToken = true;
  const now = Date.parse("2026-01-01"), exception = { kind: "Deployment", namespace: "example", name: "app", rule: "api_token", owner: "operator", reason: "reviewed API dependency", expiresAt: "2026-01-02" };
  assert.equal(inspect([pod, account], { now, exceptions: [exception] }).waived.length, 1);
  assert.equal(inspect([pod, account], { now, exceptions: [{ ...exception, name: "other" }] }).ok, false);
  for (const change of [{ expiresAt: "2025-01-01" }, { expiresAt: "2030-01-01" }, { owner: "" }, { name: "*" }]) {
    assert.throws(() => inspect([pod, account], { now, exceptions: [{ ...exception, ...change }] }), /invalid_or_expired/);
  }
});

test("RBAC detects privileged bindings, aggregation, wildcard and sensitive access", () => {
  const role = { kind: "ClusterRole", metadata: { name: "cluster-admin" }, aggregationRule: {},
    rules: [{ apiGroups: ["*"], resources: ["nodes/proxy", "secrets"], verbs: ["get", "impersonate"] }] };
  const binding = { kind: "ClusterRoleBinding", metadata: { name: "example" },
    roleRef: { kind: "ClusterRole", name: "cluster-admin", apiGroup: "rbac.authorization.k8s.io" }, subjects: [] };
  assert.deepEqual(rules(inspect([role, binding])), ["aggregated_role", "wildcard_rbac", "privilege_rbac", "sensitive_rbac", "cluster_admin"]);
});

test("inventory output contains no env, annotations, token or Secret payload", () => {
  const pod = workload(); pod.spec.template.spec.containers[0].env = [{ name: "SECRET", value: "private-value" }];
  const report = inspect([pod, account, { kind: "Secret", metadata: { name: "hidden" }, data: { token: "private-value" } }]);
  assert.doesNotMatch(JSON.stringify(report), /private-value|hidden|SECRET/);
});

test("no-API patch is version fenced, preserves the template and provides rollback", () => {
  const pod = workload(), before = JSON.stringify(pod);
  const result = plan(pod, { owner: "operator", reason: "reviewed", kubernetesApiRequired: false });
  assert.equal(JSON.stringify(pod), before);
  assert.deepEqual(result.patch[0], { op: "test", path: "/metadata/resourceVersion", value: "42" });
  assert.equal(result.patch[1].path, "/spec/template/spec/automountServiceAccountToken");
  assert.equal(result.applyEnabled, false);
  assert.throws(() => plan(pod, { owner: "operator", reason: "guess", kubernetesApiRequired: true }), /reviewed_no_api/);
});

test("malformed and duplicate inventory fails closed", () => {
  assert.throws(() => inspect([workload(), workload()]), /duplicate/);
  assert.throws(() => inspect([{ kind: "Pod", metadata: { name: "bad" }, spec: {} }]), /invalid_workload/);
  const pod = workload(); pod.spec.template.spec.automountServiceAccountToken = "false";
  assert.throws(() => inspect([pod, account]), /invalid_automount/);
});
