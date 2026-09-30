import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument, visit } from "yaml";

// Verified against the official actions/* tag refs. Updating this inventory
// requires review together with the workflow and immutable upstream commit.
export const actionPins = Object.freeze({
  "actions/checkout": "d23441a48e516b6c34aea4fa41551a30e30af803", // v6.1.0
  "actions/setup-node": "249970729cb0ef3589644e2896645e5dc5ba9c38", // v6.5.0
  "actions/upload-artifact": "ea165f8d65b6e75b540449e92b4886f43607fa02", // v4.6.2
  "actions/download-artifact": "d3f86a106a0bac45b974a628896c90dbdf5c8093", // v4.3.0
  "actions/attest-build-provenance": "4d101475d8b20a2381f78447822ac1eab6504dd8", // v4.2.2
});
const attestAction = "actions/attest-build-provenance";
// Only these actions may run in a job that holds OIDC/attestation write
// permissions; the job must not build or execute candidate package code.
const attestJobActions = new Set(["actions/checkout", "actions/setup-node", "actions/download-artifact", attestAction]);
const trustedEventCondition = "${{ github.event_name == 'push' || github.event_name == 'workflow_dispatch' }}";
const triggers = new Set(["workflow_dispatch", "pull_request", "merge_group", "push", "schedule"]);
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const requirePolicy = (condition, code) => { if (!condition) throw new Error(code); };
function permissions(value) {
  requirePolicy(record(value) && Object.keys(value).every(key => key === "contents") && value.contents === "read", "workflow_permissions");
}
// Job-level attestation permissions: exactly contents:read + id-token:write +
// attestations:write, only for an attestation job gated to trusted events that
// runs no npm scripts and only uses the reviewed action subset.
function attestationJob(job) {
  const value = job.permissions;
  if (!record(value) || !("id-token" in value || "attestations" in value)) return false;
  requirePolicy(Object.keys(value).sort().join(",") === "attestations,contents,id-token" && value.contents === "read" &&
    value["id-token"] === "write" && value.attestations === "write", "workflow_permissions");
  requirePolicy(job.if === trustedEventCondition, "workflow_attestation_event");
  const uses = (job.steps || []).filter(step => record(step) && typeof step.uses === "string").map(step => step.uses.split("@")[0]);
  requirePolicy(uses.includes(attestAction) && uses.every(name => attestJobActions.has(name)), "workflow_attestation_actions");
  requirePolicy((job.steps || []).every(step => !/\bnpm\b|\bnpx\b/.test(String(step?.run || ""))), "workflow_attestation_candidate_code");
  return true;
}
// Job-level registry publish permissions: exactly contents:read + packages:write,
// only for trusted main/v* refs. The job may only download the image artifact
// built by an unprivileged job (same run, fixed inputs) and run plain docker
// load/login/tag/push: no checkout, no npm/npx/node, no custom shell, no command
// substitution or redirection, so no candidate code ever runs with the token.
const publishCondition = "${{ (github.event_name == 'push' || github.event_name == 'workflow_dispatch') && " +
  "(github.ref == 'refs/heads/main' || startsWith(github.ref, 'refs/tags/v')) }}";
const publishJobActions = new Set(["actions/download-artifact"]);
const publishDownloadInputs = new Set(["name", "path"]);
const publishCommands = new Set(["docker", "echo", "set", "test", "[["]);
const publishDockerCommands = new Set(["load", "login", "logout", "tag", "push"]);
export function publishRunAllowed(run) {
  if (typeof run !== "string" || /[`<>]|\$\(|\b(?:npm|npx|node|eval|exec|source)\b/.test(run)) return false;
  return run.split(/\n|&&|\|\||;|\|/).every(segment => {
    const words = segment.trim().split(/\s+/).filter(Boolean);
    while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();
    if (!words.length || words[0].startsWith("#")) return true;
    if (!publishCommands.has(words[0])) return false;
    return words[0] !== "docker" || publishDockerCommands.has(words[1]);
  });
}
function publishJob(job) {
  const value = job.permissions;
  if (!record(value) || !("packages" in value)) return false;
  requirePolicy(Object.keys(value).sort().join(",") === "contents,packages" && value.contents === "read" &&
    value.packages === "write", "workflow_permissions");
  requirePolicy(job.if === publishCondition, "workflow_publish_event");
  requirePolicy(!("defaults" in job), "workflow_publish_shell");
  for (const step of job.steps || []) {
    requirePolicy(record(step) && !("shell" in step), "workflow_publish_shell");
    if (typeof step.uses === "string") {
      requirePolicy(publishJobActions.has(step.uses.split("@")[0]), "workflow_publish_actions");
      requirePolicy(Object.keys(step.with || {}).every(key => publishDownloadInputs.has(key)), "workflow_publish_actions");
    } else requirePolicy(publishRunAllowed(step.run), "workflow_publish_candidate_code");
  }
  return true;
}

export function validateWorkflow(source) {
  requirePolicy(typeof source === "string" && Buffer.byteLength(source) <= 256 * 1024, "workflow_size");
  const document = parseDocument(source, { strict: true, uniqueKeys: true, stringKeys: true, prettyErrors: false, logLevel: "silent" });
  requirePolicy(!document.errors.length && !document.warnings.length, "workflow_yaml");
  visit(document, (_key, node) => requirePolicy(!node?.anchor && !node?.tag && node?.constructor?.name !== "Alias", "workflow_yaml_indirection"));
  const workflow = document.toJS({ maxAliasCount: 0 });
  requirePolicy(record(workflow), "workflow_shape");
  permissions(workflow.permissions);
  const events = typeof workflow.on === "string" ? [workflow.on] : Array.isArray(workflow.on) ? workflow.on : record(workflow.on) ? Object.keys(workflow.on) : [];
  requirePolicy(events.length > 0 && events.every(event => triggers.has(event)), "workflow_trigger");
  requirePolicy(record(workflow.jobs) && Object.keys(workflow.jobs).length > 0, "workflow_jobs");
  let actions = 0;
  for (const job of Object.values(workflow.jobs)) {
    requirePolicy(record(job) && job["runs-on"] === "ubuntu-latest", "workflow_runner");
    requirePolicy(!["uses", "secrets", "container", "services", "environment"].some(key => key in job), "workflow_privileged_job");
    if ("permissions" in job && !attestationJob(job) && !publishJob(job)) permissions(job.permissions);
    requirePolicy(!job["continue-on-error"], "workflow_ignored_failure");
    requirePolicy(Array.isArray(job.steps) && job.steps.length > 0, "workflow_steps");
    for (const step of job.steps) {
      requirePolicy(record(step) && !step["continue-on-error"], "workflow_ignored_failure");
      if (!Object.hasOwn(step, "uses")) continue;
      requirePolicy(typeof step.uses === "string", "workflow_action_pin");
      const [name, sha, extra] = step.uses.split("@");
      requirePolicy(!extra && /^[a-f0-9]{40}$/.test(sha || "") && actionPins[name] === sha, "workflow_action_pin");
      if (name === "actions/checkout") requirePolicy(step.with?.["persist-credentials"] === false, "workflow_checkout_credentials");
      actions++;
    }
  }
  requirePolicy(!/\bsecrets\s*(?:\.|\[)/.test(source), "workflow_secrets");
  return { jobs: Object.keys(workflow.jobs).length, actions };
}

export async function checkWorkflows(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const workflows = entries.filter(entry => /\.ya?ml$/i.test(entry.name));
  requirePolicy(workflows.length > 0, "workflow_missing");
  for (const entry of workflows) {
    requirePolicy(entry.isFile(), "workflow_regular_file");
    validateWorkflow(await fs.readFile(path.join(directory, entry.name), "utf8"));
  }
  return { ok: true, workflows: workflows.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await checkWorkflows(path.resolve(".github/workflows")))); }
  catch { console.error("workflow_policy_failed"); process.exitCode = 1; }
}
