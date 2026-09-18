import { whatsappGroupCreateFailureEnvelope } from "./whatsapp-group-create-evidence.js";

// Runs only on the page owned by the connector client, never a discovered CDP target.
// Keep this function self-contained: Puppeteer serializes it into that page.
export async function browserWhatsAppGroupCreate({ title = "", participantIds = [], probeOnly = false } = {}) {
  const serialized = (wid) => typeof wid === "string" ? wid
    : wid?._serialized || wid?.$1 || (wid?.user && wid?.server ? `${wid.user}@${wid.server}` : "");
  const diagnose = (error) => {
    const names = ["Error", "TypeError", "ReferenceError", "ServerStatusCodeError", "GroupAlreadyExistsError"];
    const message = String(error?.message || "");
    const missing = message.match(/Cannot read properties of (?:undefined|null) \(reading '([A-Za-z_$]{1,48})'\)/);
    return {
      name: names.includes(error?.name) ? error.name : "Error",
      reason: missing ? `missing_property_${missing[1]}` : /is not a function/.test(message) ? "missing_function" : "upstream_error",
      status: Number.isInteger(error?.statusCode) ? error.statusCode : Number.isInteger(error?.status) ? error.status : null,
    };
  };
  let stage = "prepared";
  let protocol = { adapter: "group_create_v1", available: false };
  try {
    const job = window.require("WAWebGroupCreateJob");
    const factory = window.require("WAWebWidFactory");
    const query = window.require("WAWebQueryExistsJob");
    const me = window.require("WAWebUserPrefsMeUser");
    protocol = {
      ...protocol,
      available: typeof job?.createGroup === "function" && typeof factory?.createWid === "function" &&
        typeof query?.queryWidExists === "function" && typeof me?.getMaybeMePnUser === "function",
      version: /^\d+(?:\.\d+){1,5}$/.test(window.Debug?.VERSION || "") ? window.Debug.VERSION : "",
      // Protocol shape only; no page source, identities, or session material.
      createArity: typeof job?.createGroup === "function" ? job.createGroup.length : null,
    };
    if (probeOnly) return { ok: protocol.available, readOnly: true, protocol };
    if (!protocol.available) return { ok: false, stage, code: "whatsapp_group_protocol_unavailable", protocol };
    const selfIds = new Set([serialized(me.getMaybeMePnUser()), serialized(me.getMaybeMeLidUser?.())].filter(Boolean));
    if (!selfIds.size) return { ok: false, stage, code: "whatsapp_group_self_identity_unavailable", protocol };
    const participants = [];
    const seen = new Set();
    for (const id of participantIds) {
      if (selfIds.has(id)) continue;
      const result = await query.queryWidExists(factory.createWid(id));
      const wid = result?.wid;
      const resolved = serialized(wid);
      if (!resolved) return { ok: false, stage, code: "whatsapp_group_participant_unresolved", protocol };
      if (selfIds.has(resolved) || seen.has(resolved)) continue;
      seen.add(resolved);
      participants.push({ phoneNumber: wid });
    }
    // Use resolved WIDs and let WhatsApp choose the addressing mode. Forcing
    // LID while supplying only phone-number participants is not a valid contract
    // across Web builds. The creator is automatically included by WhatsApp.
    stage = "external_create";
    const result = await job.createGroup({
      title, ephemeralDuration: 0, announce: true, restrict: false,
      membershipApprovalMode: false, memberAddMode: false,
    }, participants);
    const gid = serialized(result?.wid || result?.gid);
    if (!/^[A-Za-z0-9._-]{1,180}@g\.us$/i.test(gid)) {
      return { ok: false, stage, code: "whatsapp_group_id_unrecognized", protocol };
    }
    // Return the group identity before optional metadata, invitations, admin
    // changes or picture work. None of those may turn creation into a retry.
    return { ok: true, gid, protocol };
  } catch (error) {
    return { ok: false, stage, code: "whatsapp_group_protocol_error", protocol, diagnostic: diagnose(error) };
  }
}

export async function inspectWhatsAppGroupCreateProtocol(client) {
  if (typeof client?.pupPage?.evaluate !== "function") return { available: false, adapter: "sdk" };
  try {
    const result = await client.pupPage.evaluate(browserWhatsAppGroupCreate, { probeOnly: true });
    return result?.protocol || { available: false, adapter: "group_create_v1" };
  } catch {
    return { available: false, adapter: "group_create_v1" };
  }
}

export async function createWhatsAppGroupWithClient(client, title, participants, options, context = {}) {
  // Alternate/test clients may expose only the public SDK contract.
  if (typeof client?.pupPage?.evaluate !== "function") return client.createGroup(title, participants, options);
  const result = await client.pupPage.evaluate(browserWhatsAppGroupCreate, { title, participantIds: participants });
  if (result?.ok && result.gid) return { gid: result.gid, protocol: result.protocol };
  const prepared = result?.stage === "prepared";
  const failure = whatsappGroupCreateFailureEnvelope({ ...context, stage: prepared ? "prepared" : "external_create", result });
  failure.code = /^whatsapp_group_[a-z_]+$/.test(result?.code || "") ? result.code : failure.code;
  failure.externalOutcome = prepared ? "not_created" : "outcome_unknown";
  failure.resultKind = prepared ? "not_dispatched" : "protocol_error";
  failure.nextAction = prepared ? "inspect_group_protocol" : "reconcile_operation";
  failure.clientVersion = result?.protocol?.version || "";
  failure.diagnostic = result?.diagnostic || null;
  throw Object.assign(new Error(failure.code), { statusCode: 502, groupCreateFailure: failure });
}
