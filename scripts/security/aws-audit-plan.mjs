// Offline least-privilege proposal. No credentials, AWS calls or role creation.
export const auditActions = Object.freeze([
  "sts:GetCallerIdentity", "iam:ListUsers", "iam:GetUser", "iam:ListAccessKeys", "iam:GetAccessKeyLastUsed",
  "iam:GetRole", "iam:ListRolePolicies", "iam:GetRolePolicy", "iam:ListAttachedRolePolicies", "iam:GetPolicy", "iam:GetPolicyVersion",
  "cloudtrail:ListTrails", "cloudtrail:DescribeTrails", "cloudtrail:GetTrailStatus", "cloudtrail:GetEventSelectors",
  "guardduty:ListDetectors", "guardduty:GetDetector", "guardduty:GetFindingsStatistics", "guardduty:ListPublishingDestinations", "guardduty:DescribePublishingDestination",
  "access-analyzer:ListAnalyzers", "access-analyzer:GetAnalyzer", "access-analyzer:GetFindingsStatistics",
  "ecr:DescribeRegistry", "ecr:GetRegistryPolicy", "ecr:GetRegistryScanningConfiguration", "ecr:DescribeRepositories", "ecr:GetRepositoryPolicy",
  "ec2:DescribeRegions", "ec2:DescribeInstances", "eks:ListClusters", "eks:DescribeCluster",
]);

export function buildAwsAuditPlan({ principalArn, roleName, regions, owner, changeRef, authentication } = {}) {
  const match = /^arn:aws:iam::(\d{12}):(user|role)\/[A-Za-z0-9+=,.@_\/-]{1,256}$/.exec(principalArn || "");
  if (!match || !/^[A-Za-z0-9+=,.@_-]{1,64}$/.test(roleName || "") || !owner || !changeRef ||
      !Array.isArray(regions) || !regions.length || regions.length > 40 ||
      regions.some(region => typeof region !== "string" || !/^[a-z]{2}-[a-z]+-\d$/.test(region))) throw new Error("explicit_audit_scope_required");
  // Federated MFA does not populate aws:MultiFactorAuthPresent reliably.
  // Do not create a fictitious MFA guarantee for an SSO trust configuration.
  if (authentication !== "iam_mfa") throw new Error("reviewed_federated_trust_required");
  const allowedRegions = [...new Set(regions)].sort();
  const globalActions = auditActions.filter(action => /^(iam|sts):/.test(action));
  const regionalActions = auditActions.filter(action => !globalActions.includes(action));
  const permissions = { Version: "2012-10-17", Statement: [
    { Sid: "AllowGlobalMetadata", Effect: "Allow", Action: globalActions, Resource: "*" },
    { Sid: "AllowReviewedRegionalMetadata", Effect: "Allow", Action: regionalActions, Resource: "*", Condition: { StringEquals: { "aws:RequestedRegion": allowedRegions } } },
    { Sid: "DenyEveryNonAuditAction", Effect: "Deny", NotAction: [...auditActions], Resource: "*" },
    { Sid: "DenyRegionalMetadataOutsideScope", Effect: "Deny", Action: regionalActions, Resource: "*", Condition: { StringNotEquals: { "aws:RequestedRegion": allowedRegions } } },
  ] };
  return { schemaVersion: 1, roleName, owner, changeRef, maximumSessionDuration: 3600, applyEnabled: false,
    trust: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { AWS: principalArn }, Action: "sts:AssumeRole",
      Condition: { Bool: { "aws:MultiFactorAuthPresent": "true" }, NumericLessThanEquals: { "aws:MultiFactorAuthAge": "3600" } } }] },
    permissions, permissionsBoundary: structuredClone(permissions),
    requires: ["account_owner_review", "isolated_role_and_profile", "policy_simulation_with_actual_context", "readback_after_approved_creation"],
    excluded: ["secret_payloads", "image_layers", "cloudtrail_event_bodies", "finding_bodies", "credential_validation_by_use", "provider_mutations"],
  };
}

export function evaluateCredentialContainment({ accessKeyId, listedKeys, lastUsed, containmentAt, metadataObservedAt, now = Date.now() } = {}) {
  // Metadata only, never accept a secret access key or authenticate as the key.
  if (!/^(AKIA|ASIA)[A-Z0-9]{16}$/.test(accessKeyId || "") || !Array.isArray(listedKeys) ||
      !Number.isFinite(now) || !Number.isFinite(Date.parse(containmentAt)) || !Number.isFinite(Date.parse(metadataObservedAt)) ||
      Date.parse(metadataObservedAt) > now || now - Date.parse(metadataObservedAt) > 3600_000 || Date.parse(metadataObservedAt) < Date.parse(containmentAt)) {
    throw new Error("fresh_scoped_credential_metadata_required");
  }
  const matches = listedKeys.filter(key => key.AccessKeyId === accessKeyId);
  if (matches.length > 1 || matches.some(key => !["Active", "Inactive"].includes(key.Status))) throw new Error("invalid_key_metadata");
  const state = matches[0]?.Status?.toLowerCase() || "absent_from_supplied_principal";
  const usedAt = lastUsed?.LastUsedDate;
  if (usedAt && !Number.isFinite(Date.parse(usedAt))) throw new Error("invalid_last_use_metadata");
  return { state, active: state === "active", postContainmentUse: usedAt ? Date.parse(usedAt) > Date.parse(containmentAt) : null,
    independentClosure: false, requires: ["prove_principal_binding_and_complete_key_inventory", "bounded_activity_metadata_review", "approved_store_fingerprint_inventory" ] };
}
