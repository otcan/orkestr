// Offline metadata-only lint. Never fetches Secrets, execs pods or applies changes.
const workloads = new Set(["Pod", "Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Job", "CronJob"]);
const namePattern = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,252}$/;
const rules = new Set(["default_identity", "implicit_automount", "api_token", "projected_token", "legacy_token", "cluster_admin", "wildcard_rbac", "privilege_rbac", "sensitive_rbac", "aggregated_role"]);
const identity = object => ({ kind: object.kind, namespace: object.metadata?.namespace || "default", name: object.metadata?.name });
const key = object => { const id = identity(object); return `${id.kind}/${id.namespace}/${id.name}`; };
const podSpec = object => object.kind === "Pod" ? object.spec : object.kind === "CronJob"
  ? object.spec?.jobTemplate?.spec?.template?.spec : object.spec?.template?.spec;

function inventory(input) {
  const objects = Array.isArray(input) ? input : input?.kind === "List" ? input.items : [input];
  if (!Array.isArray(objects) || objects.length > 20000) throw new Error("invalid_inventory");
  const seen = new Set();
  for (const object of objects) {
    if (!object || typeof object !== "object" || !namePattern.test(object.kind || "") ||
        !namePattern.test(object.metadata?.name || "") || !namePattern.test(object.metadata?.namespace || "default")) throw new Error("invalid_inventory");
      if (seen.has(key(object))) throw new Error("duplicate_inventory_identity");
    if (["ClusterRole", "ClusterRoleBinding"].includes(object.kind) && object.metadata?.namespace) throw new Error("cluster_object_has_namespace");
    seen.add(key(object));
  }
  return objects;
}

export function inspectKubernetesPosture(input, { exceptions = [], now = Date.now() } = {}) {
  if (!Number.isFinite(now) || !Array.isArray(exceptions) || exceptions.length > 20000) throw new Error("invalid_policy");
  const accepted = new Map();
  for (const exception of exceptions) {
    const expiry = Date.parse(exception?.expiresAt);
    if (!exception || !rules.has(exception.rule) || !namePattern.test(exception.kind || "") ||
        !namePattern.test(exception.name || "") || !namePattern.test(exception.namespace || "") ||
        typeof exception.owner !== "string" || !exception.owner.trim() || typeof exception.reason !== "string" || !exception.reason.trim() ||
        !Number.isFinite(expiry) || expiry <= now || expiry - now > 90 * 86400_000) throw new Error("invalid_or_expired_exception");
    const id = `${exception.kind}/${exception.namespace}/${exception.name}/${exception.rule}`;
    if (accepted.has(id)) throw new Error("duplicate_exception");
    accepted.set(id, { owner: exception.owner, expiresAt: exception.expiresAt });
  }
  const objects = inventory(input), findings = [], waived = [];
  const accounts = new Map(objects.filter(o => o.kind === "ServiceAccount").map(o => [key(o), o]));
  const roles = new Map(objects.filter(o => o.kind === "Role" || o.kind === "ClusterRole").map(o => [key(o), o]));
  const legacyTokens = new Set(objects.filter(o => o.kind === "Secret" && o.type === "kubernetes.io/service-account-token").map(key));
  function finding(object, rule) {
    const id = `${key(object)}/${rule}`, exception = accepted.get(id);
    const row = { ...identity(object), rule };
    if (exception) waived.push({ ...row, ...exception }); else findings.push(row);
  }
  let workloadCount = 0;
  for (const object of objects) {
    if (workloads.has(object.kind)) {
      workloadCount++;
      const spec = podSpec(object);
      if (!spec || !Array.isArray(spec.containers) || !spec.containers.length) throw new Error("invalid_workload");
      const ns = object.metadata.namespace || "default", account = spec.serviceAccountName || "default";
      if (!namePattern.test(account)) throw new Error("invalid_service_account");
      if (account === "default") finding(object, "default_identity");
      const sa = accounts.get(`ServiceAccount/${ns}/${account}`);
      const explicit = spec.automountServiceAccountToken ?? sa?.automountServiceAccountToken;
      if (explicit !== undefined && typeof explicit !== "boolean") throw new Error("invalid_automount_policy");
      if (explicit === undefined) finding(object, "implicit_automount");
      if (explicit !== false) finding(object, "api_token");
      if (!sa && account !== "default") finding(object, "service_account_not_in_inventory");
      if (spec.volumes !== undefined && !Array.isArray(spec.volumes)) throw new Error("invalid_volumes");
      if (spec.volumes?.some(volume => volume.projected?.sources?.some(source => source.serviceAccountToken !== undefined))) finding(object, "projected_token");
      const secretRefs = (spec.volumes || []).flatMap(volume => [volume.secret?.secretName,
        ...(volume.projected?.sources || []).map(source => source.secret?.name)]).filter(Boolean);
      for (const container of [...spec.containers, ...(spec.initContainers || [])]) {
        secretRefs.push(...(container.env || []).map(entry => entry.valueFrom?.secretKeyRef?.name).filter(Boolean),
          ...(container.envFrom || []).map(entry => entry.secretRef?.name).filter(Boolean));
      }
      if (secretRefs.some(name => legacyTokens.has(`Secret/${ns}/${name}`))) finding(object, "legacy_token");
    }
    if (object.kind === "Role" || object.kind === "ClusterRole") {
      if (object.aggregationRule) finding(object, "aggregated_role");
      if (!Array.isArray(object.rules || [])) throw new Error("invalid_rbac_rules");
      const flags = new Set();
      for (const rule of object.rules || []) {
        if (!rule || !Array.isArray(rule.verbs) || !rule.verbs.length) throw new Error("invalid_rbac_rules");
        for (const field of ["apiGroups", "resources", "verbs", "nonResourceURLs"]) {
          if (rule[field] !== undefined && (!Array.isArray(rule[field]) || rule[field].some(value => typeof value !== "string"))) throw new Error("invalid_rbac_rules");
          if (rule[field]?.some(value => value.includes("*"))) flags.add("wildcard_rbac");
        }
        if (rule.verbs.some(verb => ["bind", "escalate", "impersonate"].includes(verb))) flags.add("privilege_rbac");
        if (rule.resources?.some(resource => ["secrets", "nodes/proxy", "pods/exec", "pods/attach", "serviceaccounts/token"].includes(resource))) flags.add("sensitive_rbac");
      }
      for (const flag of flags) finding(object, flag);
    }
    if (object.kind === "RoleBinding" || object.kind === "ClusterRoleBinding") {
      const ref = object.roleRef;
      if (!ref || !["Role", "ClusterRole"].includes(ref.kind) || !namePattern.test(ref.name || "") ||
          ref.apiGroup !== "rbac.authorization.k8s.io" || !Array.isArray(object.subjects)) throw new Error("invalid_rbac_binding");
      if (ref.kind === "ClusterRole" && ref.name === "cluster-admin") finding(object, "cluster_admin");
      const ns = ref.kind === "ClusterRole" ? "default" : object.metadata.namespace || "default";
      if (!roles.has(`${ref.kind}/${ns}/${ref.name}`)) finding(object, "role_not_in_inventory");
    }
  }
  return { schemaVersion: 1, ok: workloadCount > 0 && !findings.length, workloadCount, findings, waived,
    coverage: workloadCount > 0 ? "supplied_workloads_only" : "no_workloads_not_qualified",
    limitations: ["offline_snapshot_not_effective_authorization", "custom_resource_workloads_require_separate_review", "no_live_change_or_subject_access_review"] };
}

// Exact JSON Patch includes preconditions: a stale snapshot cannot silently
// clobber a changed template. Rollback is bound to the resulting resourceVersion
// by the release operator after apply; this function never talks to a cluster.
export function planDisableTokenAutomount(object, { owner, reason, kubernetesApiRequired } = {}) {
  if (!workloads.has(object?.kind) || object.kind === "Pod" || typeof owner !== "string" || !owner.trim() || typeof reason !== "string" || !reason.trim() || kubernetesApiRequired !== false) throw new Error("reviewed_no_api_workload_required");
  inventory([object]);
  const prefix = object.kind === "CronJob" ? "/spec/jobTemplate/spec/template/spec" : "/spec/template/spec";
  const spec = podSpec(object), version = object.metadata.resourceVersion;
  if (!spec || typeof version !== "string" || !version || spec.volumes?.some(v => v.projected?.sources?.some(s => s.serviceAccountToken))) throw new Error("review_required_before_patch");
  const field = `${prefix}/automountServiceAccountToken`, previous = spec.automountServiceAccountToken;
  if (previous !== undefined && typeof previous !== "boolean") throw new Error("invalid_automount_policy");
  return { ...identity(object), owner, reason, requiresRollout: previous !== false,
    patch: [{ op: "test", path: "/metadata/resourceVersion", value: version },
      ...(previous === false ? [] : [{ op: previous === undefined ? "add" : "replace", path: field, value: false }])],
    rollbackTemplate: previous === undefined ? [{ op: "remove", path: field }] : [{ op: "replace", path: field, value: previous }],
    applyEnabled: false, rollbackRequiresReviewedResourceVersion: true };
}
