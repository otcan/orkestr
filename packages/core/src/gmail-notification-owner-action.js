// Gmail notification failures that only the owner can fix (revoked or
// missing Gmail connection, missing OAuth client config, ambiguous account). Retrying them every interval
// cannot succeed, so the runner marks the rule blocked, reports it once and
// re-checks on a slower cadence until the owner reconnects.
import { classifyGmailConnectorError } from "../../connectors/src/gmail.js";

const defaultBlockedRecheckMs = 30 * 60_000;

const OWNER_ACTIONS = {
  reconnect_required: "reconnect",
  gmail_reauthorization_required: "reconnect",
  gmail_reauth_required: "reconnect",
  gmail_token_missing_access_token: "reconnect",
  gmail_oauth_config_required: "configure",
  gmail_refresh_config_required: "configure",
  gmail_not_connected: "connect",
  google_workspace_not_connected: "connect",
  connector_selection_required: "choose_account",
  connector_account_not_found: "choose_account",
};

const OWNER_MESSAGES = {
  reconnect: "Gmail notifications are paused: the Gmail connection was revoked or expired. Reconnect Gmail in Setup > Connectors.",
  configure: "Gmail notifications are paused: the Gmail OAuth client is not configured. Add the Google OAuth client in Setup > Connectors, then connect Gmail.",
  connect: "Gmail notifications are paused: Gmail is not connected. Connect Gmail in Setup > Connectors.",
  choose_account: "Gmail notifications are paused: the Gmail account for this rule is missing or ambiguous. Pick an account for the rule or reconnect it.",
};

function clean(value) {
  return String(value ?? "").trim();
}

export function gmailNotificationBlockedRecheckMs(env = process.env) {
  const parsed = Number(env.ORKESTR_GMAIL_NOTIFICATION_BLOCKED_RECHECK_MS || defaultBlockedRecheckMs);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : defaultBlockedRecheckMs;
}

// Returns { code, action, message } for owner-fixable failures, else null.
export function gmailNotificationOwnerAction(error) {
  const raw = clean(error?.code || error?.message || error);
  let code = OWNER_ACTIONS[raw] ? raw : "";
  if (!code && classifyGmailConnectorError(error || {}).state === "reauth_required") code = "gmail_reauthorization_required";
  if (!code) return null;
  const action = OWNER_ACTIONS[code];
  return { code, action, message: OWNER_MESSAGES[action] };
}

// Store patch, minimum re-check delay and event for a failed run. Owner-fixable
// failures are reported once as gmail_notification_blocked (not on every
// re-check); other failures keep emitting gmail_notification_run_failed.
export function gmailNotificationFailureOutcome(push = {}, error, now = new Date(), env = process.env) {
  const ownerAction = gmailNotificationOwnerAction(error);
  const errorText = clean(error?.message || error).slice(0, 500);
  const alreadyBlocked = Boolean(ownerAction) && clean(push.blockedReason) === ownerAction.code;
  const event = alreadyBlocked ? null : {
    ts: now.toISOString(),
    type: ownerAction ? "gmail_notification_blocked" : "gmail_notification_run_failed",
    notificationId: push.id,
    ownerUserId: push.ownerUserId,
    targetType: push.targetType,
    target: push.target,
    error: ownerAction ? ownerAction.code : errorText,
    ...(ownerAction ? { action: ownerAction.action, message: ownerAction.message } : {}),
  };
  return {
    ownerAction,
    minDelayMs: ownerAction ? gmailNotificationBlockedRecheckMs(env) : 0,
    patch: {
      lastError: ownerAction ? ownerAction.message : errorText,
      lastErrorAt: now.toISOString(),
      failureCount: Number(push.failureCount || 0) + 1,
      blockedReason: ownerAction?.code || "",
    },
    event,
  };
}
