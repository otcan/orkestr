import { defaultWhatsAppReplyPrefix } from "../../core/src/whatsapp-defaults.js";
import { getThread, updateThread } from "../../core/src/threads.js";
import { withCanonicalPublicReferenceLock } from "../../core/src/canonical-public-reference-lock.js";
import { readConnectorConfig } from "../../storage/src/config.js";
import { bridgeRequestHeaders, configuredWhatsAppBridgeUrl, whatsappBridgeEndpointUrl } from "./whatsapp.js";
import { createLocalWhatsAppChat, normalizeGroupParticipantIds } from "./whatsapp-local-bridge.js";
import { dualWriteWhatsAppParticipantIdentity } from "./whatsapp-participant-identity.js";
import { canonicalWhatsAppAccountId } from "./whatsapp-account-identity.js";
import {
  newWhatsAppGroupProvisioningOperation,
  patchWhatsAppGroupProvisioningOperation,
  publicWhatsAppGroupProvisioningOperation,
  whatsappGroupProvisioningOperation,
  withWhatsAppGroupProvisioningLock,
} from "./whatsapp-group-provisioning.js";
import {
  transitionWhatsAppGroupProvisioning,
  whatsappGroupProvisioningContextMatches,
} from "./whatsapp-group-provisioning-store.js";
import { adaptWhatsAppGroupCreateResult, publicWhatsAppGroupCreateFailure } from "./whatsapp-group-create-evidence.js";

function clean(value) {
  return String(value || "").trim();
}

function optionalBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function completeGroupId(value = "") {
  const id = clean(value);
  return /^[A-Za-z0-9._-]{1,180}@g\.us$/i.test(id) ? id : "";
}

function currentBinding(thread = {}) {
  return thread.binding && typeof thread.binding === "object" ? thread.binding : {};
}

function displayName(thread = {}, options = {}) {
  return clean(options.name || options.displayName || currentBinding(thread).displayName || thread.bindingName || thread.name || thread.title || thread.id);
}

function threadGroupBinding(thread = {}, group = {}, options = {}, env = process.env) {
  const current = currentBinding(thread);
  return dualWriteWhatsAppParticipantIdentity({
    ...current,
    connector: "whatsapp",
    chatId: clean(group.chat?.id || group.chatId || current.chatId),
    displayName: displayName(thread, options),
    enabled: optionalBoolean(options.enabled, current.enabled !== false),
    allowOtherPeople: optionalBoolean(options.allowOtherPeople, current.allowOtherPeople !== false),
    additionalParticipantsEnabled: false,
    additionalParticipantIds: [],
    additionalParticipantLabels: {},
    mirrorToWhatsApp: optionalBoolean(options.mirrorToWhatsApp, current.mirrorToWhatsApp !== false),
    replyPrefix: clean(options.replyPrefix || current.replyPrefix) || defaultWhatsAppReplyPrefix(),
    senderAccountId: clean(options.senderAccountId || group.senderAccountId || current.senderAccountId) || null,
    responderAccountId: clean(options.responderAccountId || options.outboundAccountId || group.responderAccountId || current.responderAccountId || current.outboundAccountId) || null,
    outboundAccountId: clean(options.outboundAccountId || options.responderAccountId || group.responderAccountId || current.outboundAccountId || current.responderAccountId) || null,
    senderContactId: clean(group.senderContactId || options.senderContactId || current.senderContactId) || null,
    responderContactId: clean(group.responderContactId || options.responderContactId || current.responderContactId) || null,
    generated: true,
    ownerAuthorTags: Array.isArray(current.ownerAuthorTags) ? current.ownerAuthorTags : [],
    trustedOverrideAuthorTags: Array.isArray(current.trustedOverrideAuthorTags) ? current.trustedOverrideAuthorTags : [],
    updatedAt: new Date().toISOString(),
  }, env);
}

function operationFailure(operation, patch = {}) {
  return {
    operationId: clean(operation?.id),
    operation: "whatsapp_group_provisioning",
    stage: clean(patch.stage) || "external_create",
    code: clean(patch.code) || "whatsapp_group_create_outcome_unknown",
    resultKind: clean(patch.resultKind) || "unknown",
    externalOutcome: clean(patch.externalOutcome) || "outcome_unknown",
    retryable: patch.retryable === true,
    nextAction: clean(patch.nextAction) || "reconcile_operation",
    correlationId: clean(patch.correlationId),
    clientVersion: clean(patch.clientVersion),
    resultFingerprint: clean(patch.resultFingerprint),
  };
}

function provisioningError(operation, failure, statusCode = 409) {
  const error = new Error(clean(failure?.code) || "whatsapp_group_provisioning_failed");
  error.statusCode = statusCode;
  error.groupCreateFailure = failure;
  error.provisioning = publicWhatsAppGroupProvisioningOperation({ ...operation, failure });
  return error;
}

function provisionContext(thread = {}, options = {}, env = process.env) {
  const binding = currentBinding(thread);
  const selectedAccountId = clean(options.responderAccountId || options.outboundAccountId || binding.responderAccountId || binding.outboundAccountId || options.senderAccountId || binding.senderAccountId);
  return {
    principalId: clean(options.ownerUserId || options.userId || thread.ownerUserId),
    instanceId: clean(options.instanceId || env.ORKESTR_INSTANCE_ID || env.ORKESTR_RELEASE_INSTANCE_ID),
    accountId: canonicalWhatsAppAccountId({ accountId: selectedAccountId }, env) || selectedAccountId,
  };
}

async function persistOperation(thread, operation, dependencies, env) {
  return (dependencies.updateThread || updateThread)(thread.id, { whatsappGroupProvisioning: operation }, env);
}

async function prepareWhatsAppGroupProvisioning(thread, context, dependencies, env) {
  return withCanonicalPublicReferenceLock(async () => {
    const readThread = dependencies.getThread || getThread;
    let current = await readThread(thread.id, env) || thread;
    if (clean(currentBinding(current).chatId)) return { current, operation: null };
    let operation = whatsappGroupProvisioningOperation(current);
    if (!operation) {
      operation = newWhatsAppGroupProvisioningOperation({ thread: current, ...context });
      current = await persistOperation(current, operation, dependencies, env);
    }
    return { current, operation };
  }, env);
}

async function claimWhatsAppGroupCreateDispatch(thread, operation, context, dependencies, env) {
  let claimed = false;
  const settled = await transitionWhatsAppGroupProvisioning({
    threadId: thread.id,
    operationId: operation.id,
    context,
    dependencies,
    env,
    transition: ({ operation: active }) => {
      if (completeGroupId(active.groupId)) return null;
      const retryableRejection = active.state === "rejected" && active.retryable === true;
      if (active.state !== "prepared" && !retryableRejection) return null;
      claimed = true;
      return {
        operation: patchWhatsAppGroupProvisioningOperation(active, {
          state: "dispatched", stage: "external_create", externalOutcome: "pending", retryable: false, nextAction: "await_result",
        }),
      };
    },
  });
  return { claimed: claimed && settled.accepted, current: settled.current || thread, operation: settled.operation || operation, reason: settled.reason || "" };
}

async function reconcileProvisioning(thread, operation, dependencies, env) {
  if (completeGroupId(operation.groupId)) return { ok: true, groupId: operation.groupId, source: "persisted_group_id" };
  if (typeof dependencies.reconcileOperation !== "function") return { ok: false, source: "no_authoritative_evidence" };
  const result = await dependencies.reconcileOperation({
    operation: publicWhatsAppGroupProvisioningOperation(operation),
    threadId: thread.id,
    readOnly: true,
    maxAttempts: 1,
    env,
  });
  const groupId = completeGroupId(result?.groupId || result?.chat?.id);
  return groupId && result?.authoritative === true
    ? { ok: true, groupId, source: clean(result.source) || "authoritative_read" }
    : { ok: false, source: clean(result?.source) || "no_authoritative_evidence" };
}

export async function createExternalWhatsAppChat(options = {}, env = process.env, fetchImpl = fetch) {
  const bridgeUrl = await configuredWhatsAppBridgeUrl(env);
  if (!bridgeUrl) return null;
  const config = await readConnectorConfig("whatsapp", env);
  const response = await fetchImpl(whatsappBridgeEndpointUrl(bridgeUrl, "/chats"), {
    method: "POST",
    headers: bridgeRequestHeaders(config, env, { "content-type": "application/json" }),
    body: JSON.stringify({
      name: clean(options.name),
      senderAccountId: clean(options.senderAccountId),
      responderAccountId: clean(options.responderAccountId),
      participantIds: normalizeGroupParticipantIds(options.participantIds || []),
      adminParticipantIds: normalizeGroupParticipantIds(options.adminParticipantIds || []),
      promoteParticipantsAsAdmins: optionalBoolean(options.promoteParticipantsAsAdmins, false),
      generatePicture: optionalBoolean(options.generatePicture, true),
      deferSetup: true,
      operationId: clean(options.operationId),
      correlationId: clean(options.correlationId),
    }),
    signal: AbortSignal.timeout(Number(env.WHATSAPP_CHAT_CREATE_TIMEOUT_MS || 30_000)),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.ok === false) {
    const error = new Error(payload?.error || `whatsapp_chat_create_failed_${response.status}`);
    error.statusCode = response.status || 502;
    error.groupCreateFailure = payload?.groupCreateFailure || null;
    throw error;
  }
  const evidence = adaptWhatsAppGroupCreateResult(payload?.chat?.id || payload?.chatId || payload);
  if (evidence.ok && typeof options.onGroupCreated === "function") {
    await options.onGroupCreated({
      chatId: evidence.groupId,
      resultKind: evidence.resultKind,
      resultFingerprint: evidence.resultFingerprint,
      clientVersion: clean(payload?.createEvidence?.clientVersion || payload?.clientVersion),
    });
  }
  if (payload?.setupPending === true && evidence.ok) {
    payload.setup = await completeExternalWhatsAppGroupSetup({ bridgeUrl, config, options, groupId: evidence.groupId, env, fetchImpl });
  }
  return payload;
}

async function completeExternalWhatsAppGroupSetup({ bridgeUrl, config, options, groupId, env, fetchImpl }) {
  const accountId = clean(options.responderAccountId || options.outboundAccountId || options.senderAccountId);
  if (!accountId) return { ok: false, error: "whatsapp_group_setup_account_required" };
  try {
    const response = await fetchImpl(whatsappBridgeEndpointUrl(bridgeUrl, `/accounts/${encodeURIComponent(accountId)}/chats/${encodeURIComponent(groupId)}/setup`), {
      method: "POST",
      headers: bridgeRequestHeaders(config, env, { "content-type": "application/json" }),
      body: JSON.stringify({
        name: clean(options.name),
        adminParticipantIds: normalizeGroupParticipantIds(options.adminParticipantIds || []),
        generatePicture: optionalBoolean(options.generatePicture, true),
      }),
      signal: AbortSignal.timeout(Number(env.WHATSAPP_GROUP_SETUP_TIMEOUT_MS || 30_000)),
    });
    const payload = await response.json().catch(() => ({}));
    return response.ok && payload?.ok !== false
      ? payload
      : { ok: false, error: "whatsapp_group_setup_unavailable" };
  } catch {
    return { ok: false, error: "whatsapp_group_setup_unavailable" };
  }
}

async function bindKnownGroup(thread, operation, group, options, context, dependencies, env) {
  let binding = null;
  try {
    const settled = await transitionWhatsAppGroupProvisioning({
      threadId: thread.id,
      operationId: operation.id,
      context,
      dependencies,
      env,
      transition: ({ current, operation: active }) => {
        const groupId = completeGroupId(active.groupId || group?.chat?.id || group?.chatId);
        binding = threadGroupBinding(current, { ...group, chat: { ...(group?.chat || {}), id: groupId } }, options, env);
        if (!groupId || !completeGroupId(binding.chatId)) return null;
        return {
          operation: patchWhatsAppGroupProvisioningOperation(active, {
            state: "bound", stage: "bound", externalOutcome: "created", groupId: binding.chatId,
            failure: null, retryable: false, nextAction: "none",
          }),
          threadPatch: { binding, bindingName: binding.displayName },
        };
      },
    });
    if (!settled.accepted || !binding) {
      const failure = operationFailure(settled.operation || operation, {
        stage: "created",
        code: settled.reason === "context_mismatch" ? "whatsapp_group_provisioning_context_mismatch" : "whatsapp_group_provisioning_operation_lost",
        nextAction: "review_operation",
      });
      throw provisioningError(settled.operation || operation, failure, 409);
    }
    return { updated: settled.current, binding: settled.current.binding || binding, operation: settled.operation };
  } catch (error) {
    if (error?.groupCreateFailure) throw error;
    const failure = operationFailure(operation, {
      stage: "bound", code: "whatsapp_group_binding_save_failed", resultKind: "group_id",
      externalOutcome: "created", retryable: true, nextAction: "resume_binding",
    });
    const failed = await transitionWhatsAppGroupProvisioning({
      threadId: thread.id,
      operationId: operation.id,
      context,
      dependencies,
      env,
      transition: ({ operation: active }) => ({
        operation: patchWhatsAppGroupProvisioningOperation(active, {
          state: "created", stage: "bound", externalOutcome: "created", failure, retryable: true, nextAction: "resume_binding",
        }),
      }),
    }).catch(() => null);
    throw provisioningError(failed?.operation || operation, failure, Number(error?.statusCode || 503));
  }
}

export async function createAndBindWhatsAppThreadGroup(thread, options = {}, env = process.env, dependencies = {}) {
  if (!thread?.id) throw Object.assign(new Error("thread_not_found"), { statusCode: 404 });
  const name = displayName(thread, options);
  if (!name) throw Object.assign(new Error("whatsapp_chat_name_required"), { statusCode: 400 });
  const context = provisionContext(thread, options, env);
  const lockKey = `${thread.id}:${context.principalId}:${context.instanceId}:${context.accountId}`;
  return withWhatsAppGroupProvisioningLock(lockKey, async () => {
    const readThread = dependencies.getThread || getThread;
    let current = await readThread(thread.id, env) || thread;
    if (clean(currentBinding(current).chatId)) {
      const binding = threadGroupBinding(current, { chat: { id: currentBinding(current).chatId } }, options, env);
      const prior = whatsappGroupProvisioningOperation(current);
      let operation = prior;
      let updated;
      if (prior) {
        const settled = await transitionWhatsAppGroupProvisioning({
          threadId: current.id,
          operationId: prior.id,
          context,
          dependencies,
          env,
          transition: ({ operation: active }) => ({
            operation: patchWhatsAppGroupProvisioningOperation(active, {
              state: "bound", stage: "bound", groupId: binding.chatId, externalOutcome: "created", nextAction: "none",
            }),
            threadPatch: { binding, bindingName: binding.displayName },
          }),
        });
        updated = settled.current || current;
        operation = settled.operation || prior;
      } else {
        updated = await (dependencies.updateThread || updateThread)(current.id, { binding, bindingName: binding.displayName }, env);
      }
      return { ok: true, created: false, reused: true, thread: updated, chat: { id: binding.chatId, name: binding.displayName, isGroup: true, generated: currentBinding(current).generated === true }, binding, ...(operation ? { operation: publicWhatsAppGroupProvisioningOperation(operation) } : {}) };
    }

    let operation = whatsappGroupProvisioningOperation(current);
    if (!operation) ({ current, operation } = await prepareWhatsAppGroupProvisioning(current, context, dependencies, env));
    if (!operation && clean(currentBinding(current).chatId)) {
      const binding = threadGroupBinding(current, { chat: { id: currentBinding(current).chatId } }, options, env);
      const updated = await (dependencies.updateThread || updateThread)(current.id, { binding, bindingName: binding.displayName }, env);
      return { ok: true, created: false, reused: true, thread: updated, chat: { id: binding.chatId, name: binding.displayName, isGroup: true, generated: currentBinding(current).generated === true }, binding };
    }
    if (!whatsappGroupProvisioningContextMatches(operation, context, current.id)) {
      throw provisioningError(operation, operationFailure(operation, { code: "whatsapp_group_provisioning_context_mismatch", nextAction: "review_operation" }));
    }
    if (["dispatched", "outcome_unknown"].includes(operation.state) && !completeGroupId(operation.groupId)) {
      const reconciled = await reconcileProvisioning(current, operation, dependencies, env);
      if (!reconciled.ok) {
        const failure = operationFailure(operation, { stage: "reconcile", code: "whatsapp_group_outcome_unknown", nextAction: "review_operation" });
        const unknown = patchWhatsAppGroupProvisioningOperation(operation, { state: "outcome_unknown", stage: "reconcile", externalOutcome: "outcome_unknown", failure, nextAction: failure.nextAction });
        const settled = await transitionWhatsAppGroupProvisioning({
          threadId: current.id, operationId: operation.id, context, dependencies, env,
          transition: () => ({ operation: unknown }),
        });
        current = settled.current || current;
        operation = settled.operation || operation;
        if (!completeGroupId(operation.groupId)) {
          const code = settled.reason === "context_mismatch" ? "whatsapp_group_provisioning_context_mismatch" : failure.code;
          throw provisioningError(operation, operationFailure(operation, { ...failure, code }), 409);
        }
      } else {
        const created = patchWhatsAppGroupProvisioningOperation(operation, {
          state: "created", stage: "created", externalOutcome: "created", groupId: reconciled.groupId, reconciliationSource: reconciled.source,
        });
        const settled = await transitionWhatsAppGroupProvisioning({
          threadId: current.id, operationId: operation.id, context, dependencies, env,
          transition: () => ({ operation: created }),
        });
        current = settled.current || current;
        operation = settled.operation || operation;
        if (!completeGroupId(operation.groupId)) {
          throw provisioningError(operation, operationFailure(operation, {
            code: settled.reason === "context_mismatch" ? "whatsapp_group_provisioning_context_mismatch" : "whatsapp_group_provisioning_operation_lost",
            nextAction: "review_operation",
          }), 409);
        }
      }
    }
    if (completeGroupId(operation.groupId)) {
      const bound = await bindKnownGroup(current, operation, { chat: { id: operation.groupId, name, generated: true } }, options, context, dependencies, env);
      return { ok: true, created: false, resumed: true, thread: bound.updated, chat: { id: bound.binding.chatId, name: bound.binding.displayName, isGroup: true, generated: true }, binding: bound.binding, operation: publicWhatsAppGroupProvisioningOperation(bound.operation) };
    }

    const dispatch = await claimWhatsAppGroupCreateDispatch(current, operation, context, dependencies, env);
    current = dispatch.current;
    operation = dispatch.operation;
    if (!dispatch.claimed) {
      if (completeGroupId(operation.groupId)) {
        const bound = await bindKnownGroup(current, operation, { chat: { id: operation.groupId, name, generated: true } }, options, context, dependencies, env);
        return { ok: true, created: false, resumed: true, thread: bound.updated, chat: { id: bound.binding.chatId, name: bound.binding.displayName, isGroup: true, generated: true }, binding: bound.binding, operation: publicWhatsAppGroupProvisioningOperation(bound.operation) };
      }
      throw provisioningError(operation, operationFailure(operation, {
        code: "whatsapp_group_create_in_progress",
        externalOutcome: "outcome_unknown",
        nextAction: "reconcile_operation",
      }));
    }
    const participantIds = normalizeGroupParticipantIds(options.participantIds || options.participants || []);
    const createChat = dependencies.createChat || (await configuredWhatsAppBridgeUrl(env)
      ? async (input) => createExternalWhatsAppChat(input, env, dependencies.fetchImpl || fetch)
      : createLocalWhatsAppChat);
    let group;
    try {
      group = await createChat({
        name,
        senderAccountId: clean(options.senderAccountId || currentBinding(current).senderAccountId),
        responderAccountId: clean(options.responderAccountId || options.outboundAccountId || currentBinding(current).responderAccountId || currentBinding(current).outboundAccountId),
        participantIds,
        adminParticipantIds: normalizeGroupParticipantIds(options.adminParticipantIds || []),
        promoteParticipantsAsAdmins: optionalBoolean(options.promoteParticipantsAsAdmins, participantIds.length > 0),
        generatePicture: optionalBoolean(options.generatePicture, true),
        operationId: operation.id,
        correlationId: operation.id,
        onGroupCreated: async ({ chatId, resultKind, resultFingerprint, clientVersion }) => {
          const settled = await transitionWhatsAppGroupProvisioning({
            threadId: current.id,
            operationId: operation.id,
            context,
            dependencies,
            env,
            transition: ({ operation: active }) => ({
              operation: patchWhatsAppGroupProvisioningOperation(active, {
                state: "created", stage: "created", externalOutcome: "created", groupId: chatId,
                resultKind, resultFingerprint, clientVersion, nextAction: "bind_group",
              }),
            }),
          });
          current = settled.current || current;
          operation = settled.operation || operation;
          if (!completeGroupId(operation.groupId)) {
            throw provisioningError(operation, operationFailure(operation, {
              code: settled.reason === "context_mismatch" ? "whatsapp_group_provisioning_context_mismatch" : "whatsapp_group_provisioning_operation_lost",
              nextAction: "review_operation",
            }), 409);
          }
        },
        env,
      });
    } catch (error) {
      const failure = publicWhatsAppGroupCreateFailure(error) || operationFailure(operation);
      const rejected = failure.externalOutcome === "not_created" && failure.stage === "prepared";
      const settled = patchWhatsAppGroupProvisioningOperation(operation, {
        state: rejected ? "rejected" : "outcome_unknown",
        stage: failure.stage || "external_create",
        externalOutcome: rejected ? "not_created" : failure.externalOutcome || "outcome_unknown",
        failure: { ...failure, operationId: operation.id },
        retryable: rejected && failure.retryable === true,
        nextAction: rejected ? failure.nextAction || "restore_sender_capability" : "reconcile_operation",
      });
      const persisted = await transitionWhatsAppGroupProvisioning({
        threadId: current.id, operationId: operation.id, context, dependencies, env,
        transition: () => ({ operation: settled }),
      }).catch(() => null);
      current = persisted?.current || current;
      operation = persisted?.operation || operation;
      if (completeGroupId(operation.groupId)) {
        const bound = await bindKnownGroup(current, operation, { chat: { id: operation.groupId, name, generated: true } }, options, context, dependencies, env);
        return { ok: true, created: false, resumed: true, thread: bound.updated, chat: { id: bound.binding.chatId, name: bound.binding.displayName, isGroup: true, generated: true }, binding: bound.binding, operation: publicWhatsAppGroupProvisioningOperation(bound.operation) };
      }
      throw provisioningError(persisted?.operation || settled, settled.failure, Number(error?.statusCode || 502));
    }
    const groupId = completeGroupId(group?.chat?.id || group?.chatId);
    if (!groupId) {
      const failure = operationFailure(operation, { code: "whatsapp_group_id_unrecognized", resultKind: "unrecognized_group_id" });
      const unknown = patchWhatsAppGroupProvisioningOperation(operation, { state: "outcome_unknown", stage: "external_create", externalOutcome: "outcome_unknown", failure, nextAction: failure.nextAction });
      const persisted = await transitionWhatsAppGroupProvisioning({
        threadId: current.id, operationId: operation.id, context, dependencies, env,
        transition: () => ({ operation: unknown }),
      });
      current = persisted.current || current;
      operation = persisted.operation || operation;
      if (!completeGroupId(operation.groupId)) throw provisioningError(operation, failure, 502);
    }
    if (operation.groupId !== groupId) {
      const created = patchWhatsAppGroupProvisioningOperation(operation, { state: "created", stage: "created", externalOutcome: "created", groupId, nextAction: "bind_group" });
      const persisted = await transitionWhatsAppGroupProvisioning({
        threadId: current.id, operationId: operation.id, context, dependencies, env,
        transition: () => ({ operation: created }),
      });
      current = persisted.current || current;
      operation = persisted.operation || operation;
    }
    const bound = await bindKnownGroup(current, operation, { ...group, chat: { ...(group.chat || {}), id: operation.groupId || groupId, name } }, options, context, dependencies, env);
    return {
      ok: true, created: true, reused: false, thread: bound.updated,
      chat: group.chat || { id: bound.binding.chatId, name: bound.binding.displayName }, binding: bound.binding,
      senderAccountId: bound.binding.senderAccountId, responderAccountId: bound.binding.responderAccountId,
      setup: group.setup || null, adminPromotion: group.adminPromotion || group.setup?.adminPromotion || null,
      picture: group.picture || group.setup?.picture || null,
      operation: publicWhatsAppGroupProvisioningOperation(bound.operation),
    };
  });
}
