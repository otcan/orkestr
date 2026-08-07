import { clean, cleanLower, mailboxDomain, mailboxError, nowIso } from "./mailbox-normalization.js";

function truthy(value = "") {
  return ["1", "true", "yes", "on"].includes(cleanLower(value));
}

function falsey(value = "") {
  return ["0", "false", "no", "off"].includes(cleanLower(value));
}

function productionMode(env = process.env) {
  return [
    env.NODE_ENV,
    env.ORKESTR_ENV,
    env.ORKESTR_RUNTIME_ENV,
    env.ORKESTR_DEPLOYMENT_ENV,
    env.ORKESTR_INSTALL_MODE === "service" ? "production" : "",
  ].map(cleanLower).some((value) => ["prod", "production"].includes(value)) ||
    truthy(env.ORKESTR_PRODUCTION) ||
    truthy(env.ORKESTR_RELEASE_DEPLOY);
}

function safeToken(value = "", fallback = "") {
  return cleanLower(value)
    .replace(/[^a-z0-9_.:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || fallback;
}

function reservedMailboxDomain(domain = "") {
  const value = cleanLower(domain);
  return !value ||
    value === "localhost" ||
    value.endsWith(".localhost") ||
    value.endsWith(".test") ||
    value.endsWith(".example") ||
    value.endsWith(".invalid") ||
    value === "example.com" ||
    value === "example.net" ||
    value === "example.org";
}

export function mailboxInfrastructureStatus(input = {}, env = process.env) {
  const domain = cleanLower(input.domain || mailboxDomain(env));
  const reservedDomain = reservedMailboxDomain(domain);
  const production = productionMode(env);
  const developmentDomainOverride = truthy(env.ORKESTR_MAILBOX_ALLOW_RESERVED_DOMAIN) ||
    truthy(env.ORKESTR_MAILBOX_ALLOW_DEVELOPMENT_DOMAIN) ||
    truthy(env.ORKESTR_MAILBOX_DEVELOPMENT_DOMAIN_OVERRIDE);
  const reservedDomainBlocked = production && reservedDomain && !developmentDomainOverride;
  const requireReady = truthy(env.ORKESTR_MAILBOX_REQUIRE_MTA_READY) ||
    (production && !developmentDomainOverride) ||
    (!reservedDomain && !falsey(env.ORKESTR_MAILBOX_REQUIRE_MTA_READY));
  const adapter = safeToken(env.ORKESTR_MAILBOX_MTA_ADAPTER || env.ORKESTR_MAILBOX_INGEST_ADAPTER, "");
  const propagation = safeToken(env.ORKESTR_MAILBOX_MTA_PROPAGATION || env.ORKESTR_MAILBOX_RECIPIENT_PROPAGATION, adapter ? "configured" : "");
  const readyFlag = truthy(env.ORKESTR_MAILBOX_MTA_READY || env.ORKESTR_MAILBOX_INBOUND_READY);
  const ready = Boolean(!reservedDomainBlocked && (!requireReady || (readyFlag && adapter)));
  const reason = ready
    ? ""
    : reservedDomainBlocked
      ? "mailbox_reserved_domain_in_production"
      : !adapter
      ? "mailbox_mta_adapter_missing"
      : "mailbox_mta_not_ready";
  const propagationState = ready
    ? requireReady ? "complete" : "development"
    : "blocked";
  return {
    ready,
    reason,
    domain,
    reservedDomain,
    productionMode: production,
    developmentDomainOverride,
    requireReady,
    adapter,
    propagation,
    propagationState,
    mtaRevision: clean(env.ORKESTR_MAILBOX_MTA_REVISION || env.ORKESTR_MAILBOX_RECIPIENT_REVISION).slice(0, 160),
    checkedAt: nowIso(),
  };
}

export function mailboxLifecyclePatchForInfrastructure(status = {}) {
  return {
    mtaRevision: clean(status.mtaRevision),
    propagationState: cleanLower(status.propagationState || "pending"),
    propagationStartedAt: status.checkedAt || nowIso(),
    propagationCompletedAt: status.ready && status.propagationState === "complete" ? (status.checkedAt || nowIso()) : "",
    lastError: status.ready ? "" : cleanLower(status.reason || "mailbox_infrastructure_not_ready"),
  };
}

export function assertMailboxInfrastructureReady(input = {}, env = process.env) {
  const status = mailboxInfrastructureStatus(input, env);
  if (status.ready) return status;
  const error = mailboxError("mailbox_infrastructure_not_ready", 503);
  error.infrastructure = {
    ready: false,
    reason: status.reason,
    domain: status.domain,
    requireReady: status.requireReady,
    adapter: status.adapter,
    propagationState: status.propagationState,
  };
  throw error;
}
