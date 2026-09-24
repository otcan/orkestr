import { appendEvent } from "../../storage/src/store.js";
import { withCanonicalPublicReferenceLock } from "./canonical-public-reference-lock.js";
import { assertResourceAccess, policyError } from "./policy.js";
import { getThread, updateThread } from "./threads.js";
import { threadUsesClaudeCode } from "./runtime-claude-code-adapter.js";

const defaultModels = ["sonnet", "opus"];
const efforts = ["low", "medium", "high", "max"];
const normalModes = ["acceptEdits", "plan", "dontAsk"];

function clean(value = "") { return String(value || "").trim(); }
function enabled(value = "") { return ["1", "true", "yes", "on", "enabled"].includes(clean(value).toLowerCase()); }
function validModel(value = "") { return /^[a-zA-Z0-9._:-]{1,120}$/.test(clean(value)); }

export function claudeBypassPermissionsEnabled(env = process.env) {
  return enabled(env.ORKESTR_CLAUDE_CODE_ALLOW_BYPASS_PERMISSIONS);
}

export function claudeModelCatalog(thread = {}, env = process.env) {
  const configured = clean(env.ORKESTR_CLAUDE_CODE_MODELS).split(",").map(clean).filter(validModel);
  const current = clean(thread.claudeModel || thread.executor?.metadata?.claudeModel);
  return [...new Set([...(configured.length ? configured : defaultModels), ...(validModel(current) ? [current] : [])])]
    .map((id, index) => ({ id, isDefault: index === 0, defaultReasoningEffort: "high", supportedReasoningEfforts: efforts }));
}

export async function readClaudeModelControls(thread, principal, env = process.env) {
  assertResourceAccess(principal, thread, "thread.model-settings", env);
  if (!threadUsesClaudeCode(thread)) throw policyError("Claude settings require a Claude Code thread.", 409);
  const metadata = thread.executor?.metadata || {};
  const working = [thread.state, thread.runtime?.state].map((value) => clean(value).toLowerCase()).includes("working");
  return {
    provider: "anthropic",
    models: claudeModelCatalog(thread, env),
    model: clean(thread.claudeModel || metadata.claudeModel) || null,
    effort: clean(thread.claudeEffort || metadata.claudeEffort) || "high",
    permissionMode: clean(thread.claudePermissionMode || metadata.claudePermissionMode) || "acceptEdits",
    permissionModes: [...normalModes, ...(claudeBypassPermissionsEnabled(env) ? ["bypassPermissions"] : [])],
    readOnly: working,
    readOnlyReason: working ? "Wait for the active Claude turn to finish before changing settings." : "",
  };
}

export async function changeClaudeModelControls(thread, input = {}, principal, env = process.env) {
  assertResourceAccess(principal, thread, "thread.model-settings", env);
  const expectedOwner = thread.ownerUserId;
  const model = clean(input.model);
  const effort = clean(input.effort);
  const permissionMode = clean(input.permissionMode || thread.claudePermissionMode || thread.executor?.metadata?.claudePermissionMode || "acceptEdits");
  const models = claudeModelCatalog(thread, env).map((entry) => entry.id);
  if (!models.includes(model)) throw policyError("Select an available Claude model.", 400);
  if (!efforts.includes(effort)) throw policyError("Select a supported Claude effort.", 400);
  if (![...normalModes, "bypassPermissions"].includes(permissionMode)) throw policyError("Select a supported Claude permission mode.", 400);
  if (permissionMode === "bypassPermissions" && !claudeBypassPermissionsEnabled(env)) {
    throw policyError("Claude YOLO mode is disabled by host policy.", 403);
  }
  const updated = await withCanonicalPublicReferenceLock(async () => {
    const current = await getThread(thread.id, env);
    if (!current || current.ownerUserId !== expectedOwner || !threadUsesClaudeCode(current)) throw policyError("The thread changed while applying settings.", 409);
    if ([current.state, current.runtime?.state].map((value) => clean(value).toLowerCase()).includes("working")) {
      throw policyError("Wait for the active Claude turn to finish before changing settings.", 409);
    }
    const metadata = { ...(current.executor?.metadata || {}), claudeModel: model, claudeEffort: effort, claudePermissionMode: permissionMode };
    return updateThread(current.id, {
      claudeModel: model,
      claudeEffort: effort,
      claudePermissionMode: permissionMode,
      claudeModelUpdatedAt: new Date().toISOString(),
      executor: { ...(current.executor || {}), metadata },
    }, env);
  }, env);
  await appendEvent({ type: "claude_model_controls", threadId: thread.id, outcome: "completed", model, effort, permissionMode }, env).catch(() => {});
  return { ok: true, thread: updated, model, effort, permissionMode };
}
