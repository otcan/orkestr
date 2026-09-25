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
});
const triggers = new Set(["workflow_dispatch", "pull_request", "merge_group", "push", "schedule"]);
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const requirePolicy = (condition, code) => { if (!condition) throw new Error(code); };
function permissions(value) {
  requirePolicy(record(value) && Object.keys(value).every(key => key === "contents") && value.contents === "read", "workflow_permissions");
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
    if ("permissions" in job) permissions(job.permissions);
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
