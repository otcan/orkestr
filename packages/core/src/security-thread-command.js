import { appendEvent } from "../../storage/src/store.js";
import { openVirtualBrowser } from "../../browsers/src/browsers.js";
import { approveDesktopShareChallenge, createDesktopShare } from "./desktop-shares.js";
import { adminPrincipal, userPrincipal } from "./principal.js";
import { resourceOwnerUserId } from "./policy.js";
import { approvePairingChallenge } from "./security.js";
import { defaultAdminUser, normalizeUserId } from "./users.js";
import { rawDesktopShareApproveChallenge, rawDesktopShareRequestSlug, rawSecurityApproveChallengeId } from "./raw-terminal-commands.js";
import { readRuntimeSettings } from "./runtime-settings.js";
import { appendThreadMessage, updateThread, updateThreadMessage } from "./threads.js";

function clean(value) {
  return String(value || "").trim();
}

function nowIso() {
  return new Date().toISOString();
}

function publicError(error) {
  return clean(error?.message || error?.stderr || error?.stdout || String(error || ""));
}

function approvedByForMessage(message = {}) {
  const source = clean(message.source).toLowerCase();
  if (source === "whatsapp" || clean(message.connector).toLowerCase() === "whatsapp") return "whatsapp-thread";
  return "thread";
}

export function threadSecurityApproveChallengeId(message = {}) {
  return rawSecurityApproveChallengeId(message.text);
}

export function threadDesktopShareApproveChallenge(message = {}) {
  return rawDesktopShareApproveChallenge(message.text);
}

export function threadDesktopShareRequestSlug(message = {}) {
  return rawDesktopShareRequestSlug(message.text, "__default__");
}

function desktopPrincipalForThread(thread = {}, env = process.env) {
  const ownerUserId = resourceOwnerUserId(thread, env);
  const adminId = normalizeUserId(defaultAdminUser(env).id);
  return ownerUserId === adminId
    ? adminPrincipal(defaultAdminUser(env))
    : userPrincipal({ id: ownerUserId, role: "user", source: "thread" });
}

async function completeDesktopShareApproval(thread, message, challenge, env = process.env) {
  const deliveredAt = nowIso();
  try {
    const result = await approveDesktopShareChallenge(challenge, {
      env,
      approvedBy: approvedByForMessage(message),
    });
    const updated = await updateThreadMessage(thread.id, message.id, {
      state: "completed",
      deliveryState: "delivered",
      observedVia: "orkestr_desktop_share_approve_command",
      deliveredAt,
      error: null,
    }, env);
    const reply = await appendThreadMessage(thread.id, {
      role: "assistant",
      source: "desktop_share_command",
      phase: "final_answer",
      text: `Approved desktop access for ${result.share?.desktopSlug || "desktop"}. Return to the browser page; it should open automatically.`,
      state: "completed",
      parentMessageId: message.id,
      observedVia: "orkestr_desktop_share_approve_command",
    }, env);
    await updateThread(thread.id, { state: "ready", lastError: null }, env).catch(() => {});
    await appendEvent({
      type: "thread_desktop_share_challenge_approved",
      threadId: thread.id,
      messageId: message.id,
      shareId: result.share?.id || null,
      desktopSlug: result.share?.desktopSlug || null,
      approvedBy: approvedByForMessage(message),
    }, env).catch(() => {});
    return { handled: true, ok: true, messageId: updated.id, message: updated, reply, share: result.share };
  } catch (error) {
    const errorText = publicError(error) || "approval_failed";
    const updated = await updateThreadMessage(thread.id, message.id, {
      state: "completed",
      deliveryState: "delivered",
      observedVia: "orkestr_desktop_share_approve_command_failed",
      deliveredAt,
      error: errorText,
    }, env);
    const reply = await appendThreadMessage(thread.id, {
      role: "assistant",
      source: "desktop_share_command",
      phase: "final_answer",
      text: `Could not approve desktop access: ${errorText}`,
      state: "completed",
      parentMessageId: message.id,
      observedVia: "orkestr_desktop_share_approve_command_failed",
    }, env);
    await updateThread(thread.id, { state: "ready", lastError: errorText }, env).catch(() => {});
    return { handled: true, ok: false, messageId: updated.id, message: updated, reply, error: errorText };
  }
}

async function completeDesktopShareRequest(thread, message, slug, env = process.env) {
  const deliveredAt = nowIso();
  try {
    const resolvedSlug = await desktopShareSlug(slug, env);
    const principal = desktopPrincipalForThread(thread, env);
    const browser = await openVirtualBrowser(resolvedSlug, env, "", { principal });
    const result = await createDesktopShare({
      desktopSlug: resolvedSlug,
      principal,
      label: browser?.label || resolvedSlug,
      env,
    });
    const updated = await updateThreadMessage(thread.id, message.id, {
      state: "completed",
      deliveryState: "delivered",
      observedVia: "orkestr_desktop_share_request",
      deliveredAt,
      error: null,
    }, env);
    const reply = await appendThreadMessage(thread.id, {
      role: "assistant",
      source: "desktop_share_command",
      phase: "final_answer",
      text: [
        `Desktop link for ${browser?.label || resolvedSlug}:`,
        result.url,
        "",
        "Open it on your phone, copy the Orkestr desktop challenge shown there, and paste it back here.",
      ].join("\n"),
      state: "completed",
      parentMessageId: message.id,
      observedVia: "orkestr_desktop_share_request",
    }, env);
    await updateThread(thread.id, { state: "ready", lastError: null }, env).catch(() => {});
    await appendEvent({
      type: "thread_desktop_share_created",
      threadId: thread.id,
      messageId: message.id,
      shareId: result.share?.id || null,
      desktopSlug: resolvedSlug,
    }, env).catch(() => {});
    return { handled: true, ok: true, messageId: updated.id, message: updated, reply, share: result.share, url: result.url };
  } catch (error) {
    const errorText = publicError(error) || "desktop_share_failed";
    const updated = await updateThreadMessage(thread.id, message.id, {
      state: "completed",
      deliveryState: "delivered",
      observedVia: "orkestr_desktop_share_request_failed",
      deliveredAt,
      error: errorText,
    }, env);
    const reply = await appendThreadMessage(thread.id, {
      role: "assistant",
      source: "desktop_share_command",
      phase: "final_answer",
      text: `Could not create desktop link for ${slug === "__default__" ? "default desktop" : slug}: ${errorText}`,
      state: "completed",
      parentMessageId: message.id,
      observedVia: "orkestr_desktop_share_request_failed",
    }, env);
    await updateThread(thread.id, { state: "ready", lastError: errorText }, env).catch(() => {});
    return { handled: true, ok: false, messageId: updated.id, message: updated, reply, error: errorText };
  }
}

async function desktopShareSlug(slug, env = process.env) {
  if (slug && slug !== "__default__") return slug;
  const settings = await readRuntimeSettings(env).catch(() => null);
  return clean(settings?.desktops?.default) || clean(settings?.desktops?.manualIntervention) || "desktop";
}

export async function completeThreadSecurityApproveCommand(thread, message, env = process.env) {
  const desktopChallenge = threadDesktopShareApproveChallenge(message);
  if (desktopChallenge) return completeDesktopShareApproval(thread, message, desktopChallenge, env);

  const desktopSlug = threadDesktopShareRequestSlug(message);
  if (desktopSlug) return completeDesktopShareRequest(thread, message, desktopSlug, env);

  const challengeId = threadSecurityApproveChallengeId(message);
  if (!challengeId) return null;

  const deliveredAt = nowIso();
  try {
    const result = await approvePairingChallenge(challengeId, {
      env,
      approvedBy: approvedByForMessage(message),
    });
    const updated = await updateThreadMessage(thread.id, message.id, {
      state: "completed",
      deliveryState: "delivered",
      observedVia: "orkestr_security_approve_command",
      deliveredAt,
      error: null,
    }, env);
    const reply = await appendThreadMessage(thread.id, {
      role: "assistant",
      source: "security_command",
      phase: "final_answer",
      text: `Approved pairing challenge ${result.challenge?.id || challengeId}.`,
      state: "completed",
      parentMessageId: message.id,
      observedVia: "orkestr_security_approve_command",
    }, env);
    await updateThread(thread.id, { state: "ready", lastError: null }, env).catch(() => {});
    await appendEvent({
      type: "thread_security_challenge_approved",
      threadId: thread.id,
      messageId: message.id,
      challengeId,
      approvedBy: approvedByForMessage(message),
    }, env).catch(() => {});
    return { handled: true, ok: true, messageId: updated.id, message: updated, reply, challenge: result.challenge };
  } catch (error) {
    const errorText = publicError(error) || "approval_failed";
    const updated = await updateThreadMessage(thread.id, message.id, {
      state: "completed",
      deliveryState: "delivered",
      observedVia: "orkestr_security_approve_command_failed",
      deliveredAt,
      error: errorText,
    }, env);
    const reply = await appendThreadMessage(thread.id, {
      role: "assistant",
      source: "security_command",
      phase: "final_answer",
      text: `Could not approve pairing challenge ${challengeId}: ${errorText}`,
      state: "completed",
      parentMessageId: message.id,
      observedVia: "orkestr_security_approve_command_failed",
    }, env);
    await updateThread(thread.id, { state: "ready", lastError: errorText }, env).catch(() => {});
    await appendEvent({
      type: "thread_security_challenge_approve_failed",
      threadId: thread.id,
      messageId: message.id,
      challengeId,
      error: errorText,
      approvedBy: approvedByForMessage(message),
    }, env).catch(() => {});
    return { handled: true, ok: false, messageId: updated.id, message: updated, reply, error: errorText };
  }
}
