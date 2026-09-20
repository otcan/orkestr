import assert from "node:assert/strict";
import test from "node:test";
import { auditActions, buildAwsAuditPlan, evaluateCredentialContainment } from "../scripts/security/aws-audit-plan.mjs";
const policy = () => buildAwsAuditPlan({ principalArn: "arn:aws:iam::111111111111:user/example-operator", roleName: "ExampleAudit",
  regions: ["eu-central-1"], owner: "example-owner", changeRef: "EXAMPLE-1", authentication: "iam_mfa" });

test("audit role proposal has exact read allowlist and explicit deny complement", () => {
  const plan = policy();
  assert.equal(plan.applyEnabled, false);
  assert.deepEqual(plan.permissionsBoundary, plan.permissions);
  assert.deepEqual(plan.permissions.Statement.find(s => s.NotAction).NotAction, [...auditActions]);
  assert.equal(plan.trust.Statement[0].Condition.Bool["aws:MultiFactorAuthPresent"], "true");
  for (const action of auditActions) assert.match(action, /:(Get|List|Describe)/);
  for (const denied of ["secretsmanager:GetSecretValue", "ssm:GetParameter", "ecr:BatchGetImage", "cloudtrail:LookupEvents", "guardduty:GetFindings", "iam:CreateAccessKey", "sts:AssumeRole"]) assert.equal(auditActions.includes(denied), false);
});

test("audit plan refuses wildcard principals, guessed SSO MFA and missing scope", () => {
  const args = { principalArn: "arn:aws:iam::111111111111:role/example", roleName: "Example", regions: ["eu-central-1"], owner: "owner", changeRef: "EXAMPLE", authentication: "iam_mfa" };
  for (const patch of [{ principalArn: "*" }, { regions: ["*"] }, { owner: "" }, { authentication: "sso" }]) assert.throws(() => buildAwsAuditPlan({ ...args, ...patch }));
  assert.ok(policy().permissions.Statement.some(s => s.Effect === "Deny" && s.Condition?.StringNotEquals?.["aws:RequestedRegion"]));
});

test("key absence never falsely proves deletion; later usage is flagged without key exposure", () => {
  const input = { accessKeyId: "AKIA" + "Z".repeat(16), listedKeys: [], containmentAt: "2026-01-01T00:00:00Z", metadataObservedAt: "2026-01-02T00:00:00Z", now: Date.parse("2026-01-02T00:01:00Z") };
  const missing = evaluateCredentialContainment(input);
  assert.equal(missing.state, "absent_from_supplied_principal");
  assert.equal(missing.independentClosure, false);
  const result = evaluateCredentialContainment({ ...input, listedKeys: [{ AccessKeyId: input.accessKeyId, Status: "Inactive" }], lastUsed: { LastUsedDate: "2026-01-01T01:00:00Z" } });
  assert.equal(result.postContainmentUse, true);
  assert.doesNotMatch(JSON.stringify(result), /AKIA|ZZZZ/);
  assert.throws(() => evaluateCredentialContainment({ ...input, now: input.now + 7200_000 }), /fresh_scoped/);
});
