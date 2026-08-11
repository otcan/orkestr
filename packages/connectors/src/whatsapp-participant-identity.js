import crypto from "node:crypto";

export const whatsappParticipantRoles = ["blocked", "owner", "trusted"];

function clean(value = "") {
  return String(value || "").trim();
}

function lower(value = "") {
  return clean(value).toLowerCase();
}

function enabled(value) {
  return ["1", "true", "yes", "on"].includes(lower(value));
}

function unique(values = []) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const text = clean(value);
    const key = lower(text);
    if (!text || seen.has(key)) continue;
    seen.add(key);
    result.push(text);
  }
  return result;
}

function listValues(...values) {
  return unique(values.flatMap((value) => Array.isArray(value) ? value : [value]));
}

function identityError(code, diagnostics = {}) {
  const error = new Error(code);
  error.statusCode = 400;
  error.diagnostics = { code, ...diagnostics };
  return error;
}

export function whatsappParticipantIdentityV2Enabled(env = process.env) {
  return enabled(env.ORKESTR_WHATSAPP_PARTICIPANT_IDENTITY_V2);
}

export function whatsappReceivingAccountId(binding = {}, fallback = "") {
  return clean(
    fallback ||
    binding.receivingAccountId ||
    binding.bridgeAccountId ||
    binding.senderAccountId ||
    binding.inboundAccountId ||
    binding.responderConnectorAccountId ||
    binding.responderAccountId ||
    binding.outboundAccountId ||
    binding.accountId
  );
}

export function canonicalWhatsAppParticipantAlias(value = "", explicitKind = "") {
  const raw = lower(value).replace(/^whatsapp:/, "");
  if (!raw) return null;
  const explicit = lower(explicitKind).replace(/_/g, "-");
  const lid = raw.match(/^([^@]+)@lid$/i);
  const jid = raw.match(/^([^@]+)@(c\.us|s\.whatsapp\.net)$/i);
  const compact = raw.replace(/[()\s.+-]+/g, "");
  const phoneDigits = compact.match(/^([0-9]{5,})$/)?.[1] || "";
  const kind = explicit || (lid ? "lid" : jid ? "jid" : phoneDigits ? "phone" : "opaque");
  if (kind === "lid" || lid) {
    const normalized = lid ? `${lid[1]}@lid` : raw;
    return { kind: "lid", value: raw, canonical: `lid:${normalized}` };
  }
  const addressDigits = jid?.[1]?.match(/^\d{5,}$/)?.[0] || phoneDigits;
  if (addressDigits) {
    return { kind: kind === "phone" ? "phone" : "jid", value: raw, canonical: `phone:${addressDigits}` };
  }
  return { kind, value: raw, canonical: `${kind}:${raw}` };
}

function aliasInput(alias) {
  if (typeof alias === "string") return { value: alias, verified: false };
  if (!alias || typeof alias !== "object" || Array.isArray(alias)) return { value: "", verified: false };
  return {
    value: clean(alias.value || alias.id || alias.alias || alias.phone || alias.jid || alias.lid),
    kind: clean(alias.kind || alias.type),
    verified: alias.verified === true,
    verifiedAt: clean(alias.verifiedAt),
    source: clean(alias.source),
  };
}

function normalizedAliases(values = []) {
  const aliases = [];
  const seen = new Set();
  for (const input of Array.isArray(values) ? values : [values]) {
    const candidate = aliasInput(input);
    const canonical = canonicalWhatsAppParticipantAlias(candidate.value, candidate.kind);
    const aliasKey = canonical ? `${canonical.kind}:${lower(candidate.value)}` : "";
    if (!canonical || seen.has(aliasKey)) continue;
    seen.add(aliasKey);
    aliases.push({
      kind: canonical.kind,
      value: candidate.value,
      canonical: canonical.canonical,
      verified: candidate.verified === true,
      ...(candidate.verifiedAt ? { verifiedAt: candidate.verifiedAt } : {}),
      ...(candidate.source ? { source: candidate.source } : {}),
    });
  }
  return aliases;
}

function stableIdentityId(accountId = "", aliases = []) {
  const seed = `${lower(accountId)}\n${aliases.map((alias) => alias.canonical).sort().join("\n")}`;
  return `wa-person-${crypto.createHash("sha256").update(seed).digest("hex").slice(0, 16)}`;
}

function configSource(binding = {}) {
  if (binding.participantIdentityV2 && typeof binding.participantIdentityV2 === "object" && !Array.isArray(binding.participantIdentityV2)) {
    return binding.participantIdentityV2;
  }
  if (binding.participantIdentity && typeof binding.participantIdentity === "object" && !Array.isArray(binding.participantIdentity)) {
    return binding.participantIdentity;
  }
  if (Array.isArray(binding.participantIdentities) || Array.isArray(binding.participantGrants)) {
    return { identities: binding.participantIdentities, grants: binding.participantGrants };
  }
  return null;
}

export function normalizeWhatsAppParticipantIdentityConfig(binding = {}, options = {}) {
  const source = options.config || configSource(binding);
  if (!source) return null;
  const accountId = whatsappReceivingAccountId(binding, source.accountId || options.accountId);
  if (!accountId) throw identityError("wa_participant_identity_account_required");
  const sourceIdentities = Array.isArray(source.identities) ? source.identities : [];
  const identities = sourceIdentities.map((identity, index) => {
    const identityAccountId = clean(identity?.accountId || accountId);
    if (lower(identityAccountId) !== lower(accountId)) {
      throw identityError("wa_participant_identity_account_scope_mismatch", { identityId: clean(identity?.id), accountId });
    }
    const aliases = normalizedAliases(identity?.aliases || identity?.verifiedAliases || []);
    if (!aliases.length) throw identityError("wa_participant_identity_alias_required", { identityId: clean(identity?.id) });
    return {
      id: clean(identity?.id || identity?.identityId) || stableIdentityId(accountId, aliases),
      accountId,
      aliases,
      ...(clean(identity?.label) ? { label: clean(identity.label) } : {}),
    };
  });
  const identityIds = new Set(identities.map((identity) => identity.id));
  if (identityIds.size !== identities.length) throw identityError("wa_participant_identity_id_collision");

  const grants = [];
  const sourceGrants = Array.isArray(source.grants) ? source.grants : [];
  for (const grant of sourceGrants) {
    const identityId = clean(grant?.identityId || grant?.participantIdentityId || grant?.participantId);
    const role = lower(grant?.role).replace(/_/g, "-");
    if (!identityIds.has(identityId)) throw identityError("wa_participant_identity_grant_target_missing", { identityId });
    if (!whatsappParticipantRoles.includes(role)) throw identityError("wa_participant_identity_role_invalid", { identityId, role });
    if (!grants.some((item) => item.identityId === identityId && item.role === role)) grants.push({ identityId, role });
  }
  for (let index = 0; index < identities.length; index += 1) {
    const identity = identities[index];
    const sourceIdentity = sourceIdentities[index] || {};
    for (const role of listValues(sourceIdentity.role, sourceIdentity.roles).map((value) => lower(value))) {
      if (!role) continue;
      if (!whatsappParticipantRoles.includes(role)) throw identityError("wa_participant_identity_role_invalid", { identityId: identity.id, role });
      if (!grants.some((item) => item.identityId === identity.id && item.role === role)) grants.push({ identityId: identity.id, role });
    }
  }

  const aliasOwners = new Map();
  for (const identity of identities) {
    for (const alias of identity.aliases.filter((item) => item.verified)) {
      const prior = aliasOwners.get(alias.canonical);
      if (prior && prior !== identity.id) {
        throw identityError("wa_participant_identity_alias_collision", { identityIds: [prior, identity.id] });
      }
      aliasOwners.set(alias.canonical, identity.id);
    }
  }
  for (const identity of identities) {
    const roles = new Set(grants.filter((grant) => grant.identityId === identity.id).map((grant) => grant.role));
    if (roles.size > 0 && !identity.aliases.some((alias) => alias.verified)) {
      throw identityError("wa_participant_identity_verified_alias_required", { identityId: identity.id });
    }
    if (roles.has("owner") && roles.has("trusted")) {
      throw identityError("wa_participant_identity_owner_trusted_overlap", { identityId: identity.id });
    }
  }
  const revisionSeed = JSON.stringify({ accountId: lower(accountId), identities, grants });
  return {
    version: 2,
    accountId,
    identities,
    grants,
    revision: clean(source.revision) || `wa-pi2-${crypto.createHash("sha256").update(revisionSeed).digest("hex").slice(0, 16)}`,
  };
}

function verifiedAlias(value = "", source = "legacy-binding") {
  const canonical = canonicalWhatsAppParticipantAlias(value);
  return canonical ? { kind: canonical.kind, value: clean(value), verified: true, source } : null;
}

function legacyRoleAliases(binding = {}, role = "owner") {
  const inbound = binding.inboundSecurity && typeof binding.inboundSecurity === "object" && !Array.isArray(binding.inboundSecurity)
    ? binding.inboundSecurity
    : {};
  if (role === "owner") {
    return listValues(
      binding.senderContactId,
      binding.ownerContactId,
      binding.ownerContactIds,
      binding.ownerContactAliases,
      binding.authorizedContactId,
      binding.authorizedContactIds,
      binding.authorizedContactAliases,
      inbound.ownerParticipantIds,
      inbound.ownerParticipants,
      inbound.ownerContactIds,
      inbound.ownerContactAliases,
    );
  }
  if (role === "trusted") {
    return listValues(
      inbound.trustedParticipantIds,
      inbound.trustedParticipants,
      binding.additionalParticipantsEnabled === true || binding.allowOtherPeopleConfirmed === true ? binding.additionalParticipantIds : [],
    );
  }
  return listValues(binding.blockedParticipantIds, inbound.blockedParticipantIds, inbound.blockedParticipants);
}

export function legacyWhatsAppParticipantIdentityConfig(binding = {}) {
  const accountId = whatsappReceivingAccountId(binding);
  if (!accountId) return null;
  const identities = [];
  const grants = [];
  const add = (role, aliases, group = false) => {
    const groups = group ? [aliases] : aliases.map((alias) => [alias]);
    for (const values of groups) {
      const verified = values.map((value) => verifiedAlias(value)).filter(Boolean);
      if (!verified.length) continue;
      const canonical = normalizedAliases(verified).map((alias) => alias.canonical);
      const existing = identities.find((identity) => normalizedAliases(identity.aliases).some((alias) => canonical.includes(alias.canonical)));
      const identityId = existing?.id || stableIdentityId(accountId, normalizedAliases(verified));
      if (!existing) identities.push({ id: identityId, accountId, aliases: verified });
      grants.push({ identityId, role });
    }
  };
  add("owner", legacyRoleAliases(binding, "owner"), true);
  add("trusted", legacyRoleAliases(binding, "trusted"));
  add("blocked", legacyRoleAliases(binding, "blocked"));
  if (!identities.length) return null;
  return normalizeWhatsAppParticipantIdentityConfig(binding, { config: { version: 2, accountId, identities, grants } });
}

export function dualWriteWhatsAppParticipantIdentity(binding = {}, env = process.env) {
  const explicit = configSource(binding);
  if (explicit) return { ...binding, participantIdentityV2: normalizeWhatsAppParticipantIdentityConfig(binding) };
  if (binding.participantIdentityV2Rollback && typeof binding.participantIdentityV2Rollback === "object") return binding;
  if (!whatsappParticipantIdentityV2Enabled(env)) return binding;
  const migrated = legacyWhatsAppParticipantIdentityConfig(binding);
  return migrated ? { ...binding, participantIdentityV2: migrated } : binding;
}

export function resolveWhatsAppParticipantIdentity(binding = {}, input = {}, env = process.env) {
  const active = whatsappParticipantIdentityV2Enabled(env) && Boolean(configSource(binding));
  if (!active) return { enabled: false, effectiveRole: "unknown", identityId: "", revision: "" };
  let config;
  try {
    config = normalizeWhatsAppParticipantIdentityConfig(binding);
  } catch (error) {
    return {
      enabled: true,
      valid: false,
      effectiveRole: "unknown",
      identityId: "",
      revision: "",
      reason: clean(error?.message || "wa_participant_identity_invalid"),
      remediation: "Repair the WhatsApp participant identity binding before replaying the event.",
    };
  }
  const accountId = whatsappReceivingAccountId(binding, input.accountId);
  if (!accountId || lower(accountId) !== lower(config.accountId)) {
    return { enabled: true, valid: true, effectiveRole: "unknown", identityId: "", revision: config.revision, reason: "account_scope_mismatch" };
  }
  if (input.fromMe === true) {
    return { enabled: true, valid: true, effectiveRole: "owner", identityId: "self", revision: config.revision, reason: "verified_self_account" };
  }
  const alias = canonicalWhatsAppParticipantAlias(input.senderId || input.from || input.participantId);
  if (!alias) return { enabled: true, valid: true, effectiveRole: "unknown", identityId: "", revision: config.revision, reason: "sender_alias_missing" };
  const identity = config.identities.find((candidate) => candidate.aliases.some((item) => item.verified && item.canonical === alias.canonical));
  if (!identity) return { enabled: true, valid: true, effectiveRole: "unknown", identityId: "", revision: config.revision, reason: "sender_alias_unknown" };
  const roles = new Set(config.grants.filter((grant) => grant.identityId === identity.id).map((grant) => grant.role));
  const effectiveRole = roles.has("blocked") ? "blocked" : roles.has("owner") ? "owner" : roles.has("trusted") ? "trusted" : "unknown";
  return {
    enabled: true,
    valid: true,
    effectiveRole,
    identityId: identity.id,
    revision: config.revision,
    reason: effectiveRole === "unknown" ? "participant_grant_missing" : "verified_alias_grant",
  };
}

export function whatsappParticipantIdentityStatus(binding = {}, env = process.env) {
  const source = configSource(binding);
  if (!source) return { enabled: whatsappParticipantIdentityV2Enabled(env), configured: false, valid: true, revision: "", roles: { owner: [], trusted: [], blocked: [] } };
  try {
    const config = normalizeWhatsAppParticipantIdentityConfig(binding);
    const roles = { owner: [], trusted: [], blocked: [] };
    for (const identity of config.identities) {
      const granted = new Set(config.grants.filter((grant) => grant.identityId === identity.id).map((grant) => grant.role));
      const effectiveRole = granted.has("blocked") ? "blocked" : granted.has("owner") ? "owner" : granted.has("trusted") ? "trusted" : "";
      if (!effectiveRole) continue;
      roles[effectiveRole].push({
        identityId: identity.id,
        aliases: identity.aliases.filter((alias) => alias.verified).map((alias) => ({ kind: alias.kind, value: alias.value })),
      });
    }
    return { enabled: whatsappParticipantIdentityV2Enabled(env), configured: true, valid: true, revision: config.revision, accountId: config.accountId, roles };
  } catch (error) {
    return {
      enabled: whatsappParticipantIdentityV2Enabled(env),
      configured: true,
      valid: false,
      revision: "",
      error: clean(error?.message || "wa_participant_identity_invalid"),
      roles: { owner: [], trusted: [], blocked: [] },
    };
  }
}
