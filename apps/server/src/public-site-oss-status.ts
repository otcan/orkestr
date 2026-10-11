// Single source for the public Orkestr OSS capability status. The /open-source
// page renders this table, and test/public-site-oss.test.js checks that the
// README status table carries the same rows. Only change a row when the
// evidence changed; keep the wording plain and do not round up.

export type OssEvidence = "simulation" | "offline-tested" | "live-verified";

export type OssCapabilityStatus = {
  capability: string;
  status: string;
  evidence: OssEvidence;
  note: string;
};

export const ossStatusAsOf = "2026-10-11";

export const ossEvidenceLabels: Record<OssEvidence, { label: string; meaning: string }> = {
  simulation: {
    label: "Simulation",
    meaning: "Exercised only with the built-in simulated provider or fake external systems. No real model and no real external service took part.",
  },
  "offline-tested": {
    label: "Offline-tested",
    meaning: "Real code paths covered by automated tests without network access or real accounts. Not yet observed against a live service.",
  },
  "live-verified": {
    label: "Live-verified",
    meaning: "Observed working on a real provider or a released build, in a controlled test run with synthetic content.",
  },
};

export const ossCapabilityStatus: OssCapabilityStatus[] = [
  {
    capability: "Codex jobs",
    status: "live-verified once on production build (approval pause -> approve -> single-use approval consumed, effect ledgered)",
    evidence: "live-verified",
    note: "One controlled run on a real Codex login with an isolated ORKESTR_HOME. One run is not a reliability measurement.",
  },
  {
    capability: "Claude Code jobs",
    status: "NOT supported yet (permission hook not enforced in live test; refused unless configured)",
    evidence: "offline-tested",
    note: "The executor passes its offline tests, but in the live test the per-call permission hook did not run, so tool approvals cannot be relied on. Where no Claude login is configured for jobs, runs are refused. A host whose own Claude login is active can still start them today; set ORKESTR_AGENT_JOB_CLAUDE_CODE_EXECUTOR=0 to turn them off.",
  },
  {
    capability: "YAML/JSON job specs",
    status: "verified",
    evidence: "live-verified",
    note: "A YAML job spec was loaded by the released CLI, and JSON job specs also loaded on the released build. Specs are validated before a job is registered.",
  },
  {
    capability: "WhatsApp/email notifications",
    status: "built, not live-verified",
    evidence: "offline-tested",
    note: "The dispatcher delivers each notification at most once in tests. No real job notification has been sent yet.",
  },
  {
    capability: "Webhooks (HMAC)",
    status: "built and tested offline",
    evidence: "offline-tested",
    note: "Signed trigger endpoint and signed outgoing webhooks (HMAC-SHA256), covered by automated tests only.",
  },
  {
    capability: "Guarantees G1-G11",
    status: "tested with simulated/fake providers",
    evidence: "simulation",
    note: "Durable admission, dedupe, at-most-once effects, approvals, audit, notification-once and cancellation are tested with the simulated provider and a fake code host. The single-use approval path has additionally been seen once on a live Codex run (row above).",
  },
  {
    capability: "orkestr demo",
    status: "simulation by design",
    evidence: "simulation",
    note: "Uses a simulated AI and a fake code host in a throwaway home directory. It shows the runtime's crash recovery and approval flow; it does not call a real model.",
  },
];
