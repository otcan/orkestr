import crypto from "node:crypto";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { incrementCounter, observeHistogram } from "../../core/src/observability.js";
import { colorMomentDistance, hammingDistanceHex, imageFingerprintForPath, mediaKindForAttachment } from "./whatsapp-media-fingerprint.js";
import {
  appendTransformedMediaEchoTerminalSuppression,
  readTransformedMediaEchoLedger,
  transformedMediaEchoRecordLimit,
  withTransformedMediaEchoLedger,
  writeTransformedMediaEchoLedger,
} from "./whatsapp-media-echo-ledger.js";
export { acquireTransformedMediaEchoLedgerLockForTest, claimTransformedMediaEchoTerminalReplayAudit, findTransformedMediaEchoTerminalSuppression, recordTransformedMediaEchoTerminalReplayAudit, rememberTransformedMediaEchoTerminalSuppression, transformedMediaEchoLedgerLockOwnerPathForTest, transformedMediaEchoLedgerLockPathForTest } from "./whatsapp-media-echo-ledger.js";

const defaultTtlMs = 30 * 60 * 1000;
const matchLatencyBucketsSeconds = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const matchDistanceBuckets = [0, 1, 2, 4, 8, 16, 24, 32, 48, 64, 96, 128, 160, 256];
const metricModes = new Set(["off", "shadow", "enforce"]);
const metricSources = new Set(["local_bridge", "router", "test", "unknown"]);
const metricMediaKinds = new Set(["image", "unknown"]);
const metricResults = new Set([
  "ambiguous",
  "disabled",
  "filter",
  "fingerprint_failed",
  "low_information",
  "missing_scope",
  "no_match",
  "not_from_me",
  "recorded",
  "shadow",
  "suppress",
  "unknown",
]);
const metricDistanceKinds = new Set(["hash", "color_hash", "color_moment"]);

function clean(value = "") {
  return String(value || "").trim();
}

function lower(value = "") {
  return clean(value).toLowerCase();
}

function clampInteger(value, fallback, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(numeric)));
}

export function transformedMediaEchoSuppressionMode(env = process.env) {
  const killed = lower(
    env.ORKESTR_WHATSAPP_TRANSFORMED_MEDIA_ECHO_KILL_SWITCH ||
    env.ORKESTR_WHATSAPP_MEDIA_ECHO_KILL_SWITCH,
  );
  if (["1", "true", "yes", "on", "kill", "disabled"].includes(killed)) return "off";
  const configured = lower(
    env.ORKESTR_WHATSAPP_TRANSFORMED_MEDIA_ECHO_MODE ||
    env.ORKESTR_WHATSAPP_TRANSFORMED_MEDIA_ECHO_SUPPRESSION ||
    env.ORKESTR_WHATSAPP_MEDIA_ECHO_SUPPRESSION ||
    "shadow",
  );
  return ["off", "shadow", "enforce"].includes(configured) ? configured : "shadow";
}

function transformedMediaEchoTtlMs(env = process.env) {
  return clampInteger(
    env.ORKESTR_WHATSAPP_TRANSFORMED_MEDIA_ECHO_TTL_MS || env.ORKESTR_WHATSAPP_OUTBOUND_ECHO_TTL_MS,
    defaultTtlMs,
    1_000,
    24 * 60 * 60 * 1000,
  );
}

function transformedMediaEchoMaxDistance(env = process.env) {
  return clampInteger(env.ORKESTR_WHATSAPP_TRANSFORMED_MEDIA_ECHO_MAX_DISTANCE, 30, 4, 80);
}

function transformedMediaEchoMaxColorDistance(env = process.env) {
  return clampInteger(env.ORKESTR_WHATSAPP_TRANSFORMED_MEDIA_ECHO_MAX_COLOR_DISTANCE, 20, 2, 80);
}

function transformedMediaEchoMaxMomentDistance(env = process.env) {
  return clampInteger(env.ORKESTR_WHATSAPP_TRANSFORMED_MEDIA_ECHO_MAX_MOMENT_DISTANCE, 45, 5, 160);
}

function transformedMediaEchoMinInformationScore(env = process.env) {
  return clampInteger(env.ORKESTR_WHATSAPP_TRANSFORMED_MEDIA_ECHO_MIN_INFORMATION_SCORE, 35, 0, 240);
}

function injectedAtomicWriteFailure(env = process.env, eventId = "") {
  const configured = clean(env.ORKESTR_WHATSAPP_TRANSFORMED_MEDIA_ECHO_INJECT_BEFORE_ATOMIC_WRITE_EVENT_ID);
  if (!configured) return false;
  return configured === "1" || configured === clean(eventId);
}

function boundedMetricLabel(value = "", allowed = new Set(["unknown"]), fallback = "unknown") {
  const normalized = lower(value).replace(/[^a-z0-9_.:-]+/g, "_").replace(/^_+|_+$/g, "") || fallback;
  return allowed.has(normalized) ? normalized : fallback;
}

function positiveCount(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.floor(numeric));
}

function countBucket(value) {
  const count = positiveCount(value);
  if (count <= 0) return "0";
  if (count === 1) return "1";
  if (count <= 3) return "2_3";
  if (count <= 10) return "4_10";
  return "gt_10";
}

function metricLabels({ result = "unknown", mode = "shadow", source = "unknown", mediaKind = "image" } = {}) {
  return {
    result: boundedMetricLabel(result, metricResults),
    mode: boundedMetricLabel(mode, metricModes, "shadow"),
    source: boundedMetricLabel(source, metricSources),
    mediaKind: boundedMetricLabel(mediaKind, metricMediaKinds),
  };
}

function metric(result, mode, source, mediaKind = "image", amount = 1) {
  incrementCounter(
    "orkestr_whatsapp_outbound_echo_attachment_transformed_total",
    metricLabels({ result, mode, source, mediaKind }),
    positiveCount(amount) || 1,
  );
}

function incrementPositiveCounter(name, labels = {}, amount = 0) {
  const count = positiveCount(amount);
  if (count > 0) incrementCounter(name, labels, count);
}

function imageAttachmentCount(attachments = []) {
  return (Array.isArray(attachments) ? attachments : []).filter((attachment) => mediaKindForAttachment(attachment) === "image").length;
}

function cycleSignalForOutcome({ mode = "shadow", source = "unknown", matched = [], attachments = [], candidateRecordCount = 0 } = {}) {
  const returnedImageCount = imageAttachmentCount(attachments);
  if (!returnedImageCount) return null;
  const matchedWouldRoute = mode === "shadow" && matched.length > 0;
  if (!matchedWouldRoute) return null;
  return {
    suspected: true,
    mode: boundedMetricLabel(mode, metricModes, "shadow"),
    source: boundedMetricLabel(source, metricSources),
    mediaKind: "image",
    reason: boundedMetricLabel("shadow_match", new Set([...metricResults, "shadow_match"])),
    matchedAttachmentBucket: countBucket(matched.length),
    retainedAttachmentBucket: countBucket(returnedImageCount),
    candidateRecordBucket: countBucket(candidateRecordCount),
  };
}

function recordMatchDistances({ matched = [], mode = "shadow", source = "unknown", result = "unknown" } = {}) {
  const baseLabels = metricLabels({ result, mode, source, mediaKind: "image" });
  for (const item of Array.isArray(matched) ? matched : []) {
    for (const [distanceKind, value] of [
      ["hash", item.distance],
      ["color_hash", item.colorDistance],
      ["color_moment", item.momentDistance],
    ]) {
      observeHistogram(
        "orkestr_whatsapp_outbound_echo_attachment_transformed_match_distance",
        Number(value),
        { ...baseLabels, distanceKind: boundedMetricLabel(distanceKind, metricDistanceKinds) },
        matchDistanceBuckets,
      );
    }
  }
}

function recordFilterTelemetry({ action = "unknown", mode = "shadow", source = "unknown", startedAtMs = null, matched = [], ambiguous = 0, unmatched = 0, cycleSignal = null } = {}) {
  const labels = metricLabels({ result: action, mode, source, mediaKind: "image" });
  metric(action, mode, source, "image");
  if (Number.isFinite(startedAtMs)) {
    observeHistogram(
      "orkestr_whatsapp_outbound_echo_attachment_transformed_match_duration_seconds",
      Math.max(0, performance.now() - startedAtMs) / 1000,
      labels,
      matchLatencyBucketsSeconds,
    );
  }
  recordMatchDistances({ matched, mode, source, result: action });
  incrementPositiveCounter("orkestr_whatsapp_outbound_echo_attachment_transformed_unmatched_total", {
    mode: labels.mode,
    source: labels.source,
    reason: labels.result,
  }, unmatched);
  incrementPositiveCounter("orkestr_whatsapp_outbound_echo_attachment_transformed_ambiguous_total", {
    mode: labels.mode,
    source: labels.source,
  }, ambiguous);
  if (cycleSignal?.suspected) {
    incrementCounter("orkestr_whatsapp_outbound_echo_attachment_transformed_cycle_suspected_total", {
      mode: cycleSignal.mode || labels.mode,
      source: cycleSignal.source || labels.source,
      reason: boundedMetricLabel(cycleSignal.reason, new Set([...metricResults, "shadow_match"])),
    });
  }
}

function hasSufficientImageInformation(fingerprint = {}, env = process.env) {
  const score = Number(fingerprint.informationScore);
  return Number.isFinite(score) && score >= transformedMediaEchoMinInformationScore(env);
}

export async function rememberTransformedOutboundMediaEcho({
  accountId = "",
  chatId = "",
  attachment = {},
  deliveredMessageId = "",
  crossAccount = true,
  env = process.env,
} = {}) {
  const mode = transformedMediaEchoSuppressionMode(env);
  if (mode === "off") {
    metric("disabled", mode, "local_bridge", "image");
    return { recorded: false, reason: "disabled", mode };
  }
  const mediaKind = mediaKindForAttachment(attachment);
  if (mediaKind !== "image") return { recorded: false, reason: "unsupported_media_kind", mode };
  const fingerprint = await imageFingerprintForPath(attachment.path);
  if (!fingerprint) {
    metric("fingerprint_failed", mode, "local_bridge", mediaKind);
    return { recorded: false, reason: "fingerprint_failed", mode, mediaKind };
  }
  const nowMs = Date.now();
  const ttlMs = transformedMediaEchoTtlMs(env);
  const record = {
    id: crypto.randomUUID(),
    accountId: clean(accountId),
    chatId: clean(chatId),
    mediaKind,
    crossAccount: crossAccount !== false,
    deliveredMessageId: clean(deliveredMessageId),
    sentAtMs: nowMs,
    expiresAtMs: nowMs + ttlMs,
    fingerprint,
    width: fingerprint.width,
    height: fingerprint.height,
  };
  if (!record.accountId || !record.chatId || !record.deliveredMessageId) {
    metric("missing_scope", mode, "local_bridge", mediaKind);
    return { recorded: false, reason: "missing_scope", mode, mediaKind };
  }
  await withTransformedMediaEchoLedger(env, async (filePath) => {
    const ledger = await readTransformedMediaEchoLedger(filePath, env);
    const records = [record, ...ledger.records]
      .sort((left, right) => right.sentAtMs - left.sentAtMs)
      .slice(0, transformedMediaEchoRecordLimit(env));
    await writeTransformedMediaEchoLedger(filePath, { ...ledger, records });
  });
  metric("recorded", mode, "local_bridge", mediaKind);
  return { recorded: true, mode, mediaKind };
}

function candidateRecords(records = [], { accountId = "", chatId = "", mediaKind = "image", fromMe = false } = {}) {
  const scopedAccountId = clean(accountId);
  const scopedChatId = clean(chatId);
  return records.filter((record) => {
    if (record.mediaKind !== mediaKind || record.chatId !== scopedChatId) return false;
    return record.accountId === scopedAccountId && fromMe === true;
  });
}

function normalizedText(value = "") {
  return clean(value).replace(/\s+/g, " ").toLowerCase();
}

function attachmentSummaryCandidates(attachments = []) {
  const items = Array.isArray(attachments) ? attachments : [];
  if (!items.length) return [];
  const bridgeSummary = [
    "WhatsApp attachment received.",
    ...items.map((attachment, index) => [
      `Attachment ${index + 1}: ${clean(attachment.path)}`,
      clean(attachment.filename) ? `filename: ${clean(attachment.filename)}` : "",
      clean(attachment.mimetype) ? `mimetype: ${clean(attachment.mimetype)}` : "",
    ].filter(Boolean).join("\n")),
  ].join("\n\n");
  const routerSummary = [
    "WhatsApp attachment received.",
    ...items.map((attachment, index) => [
      `Attachment ${index + 1}: ${clean(attachment.filename || path.basename(clean(attachment.path)) || "attachment")}`,
      clean(attachment.mimetype) ? `mimetype: ${clean(attachment.mimetype)}` : "",
    ].filter(Boolean).join("\n")),
  ].join("\n\n");
  return [bridgeSummary, routerSummary].filter(Boolean).map(normalizedText);
}

function retainedEchoText(text = "", matchedAttachments = []) {
  const raw = clean(text);
  if (!raw) return "";
  const normalized = normalizedText(raw);
  const matchedNames = matchedAttachments
    .map((attachment) => normalizedText(attachment.filename || path.basename(clean(attachment.path))))
    .filter(Boolean);
  if (attachmentSummaryCandidates(matchedAttachments).some((summary) => summary && normalized === summary)) return "";
  if (matchedNames.some((name) => name && normalized === name)) return "";
  return raw;
}

export async function filterTransformedMediaEchoAttachments({
  accountId = "",
  chatId = "",
  eventId = "",
  terminalEventId = eventId,
  fromMe = false,
  text = "",
  attachments = [],
  env = process.env,
  source = "unknown",
} = {}) {
  const startedAtMs = performance.now();
  const mode = transformedMediaEchoSuppressionMode(env);
  const items = Array.isArray(attachments) ? attachments : [];
  if (mode === "off") return { mode, matched: [], attachments: items, text: clean(text), action: "off" };
  if (!items.length) return { mode, matched: [], attachments: items, text: clean(text), action: "no_attachments" };
  if (fromMe !== true) {
    metric("not_from_me", mode, source, "image");
    return { mode, matched: [], attachments: items, text: clean(text), action: "not_from_me" };
  }

  const prepared = [];
  let fingerprintFailures = 0;
  let lowInformation = 0;
  for (const [index, attachment] of items.entries()) {
    const mediaKind = mediaKindForAttachment(attachment);
    if (mediaKind !== "image") {
      prepared.push({ index, attachment, mediaKind, fingerprint: null });
      continue;
    }
    const fingerprint = await imageFingerprintForPath(attachment.path);
    if (!fingerprint) {
      fingerprintFailures += 1;
      prepared.push({ index, attachment, mediaKind, fingerprint: null });
      continue;
    }
    if (!hasSufficientImageInformation(fingerprint, env)) lowInformation += 1;
    prepared.push({ index, attachment, mediaKind, fingerprint });
  }

  const maxDistance = transformedMediaEchoMaxDistance(env);
  const maxColorDistance = transformedMediaEchoMaxColorDistance(env);
  const maxMomentDistance = transformedMediaEchoMaxMomentDistance(env);
  const matchedResult = await withTransformedMediaEchoLedger(env, async (filePath) => {
    const ledger = await readTransformedMediaEchoLedger(filePath, env);
    const usedRecords = new Set();
    const consumedRecords = new Set();
    const matched = [];
    let ambiguous = 0;
    let unmatched = 0;
    let imageCandidates = 0;
    let candidateRecordCount = 0;
    let terminalSuppressionRecord = null;
    for (const item of prepared) {
      if (!item.fingerprint || item.mediaKind !== "image") continue;
      if (!hasSufficientImageInformation(item.fingerprint, env)) continue;
      imageCandidates += 1;
      const scopedCandidates = candidateRecords(ledger.records, {
        accountId,
        chatId,
        mediaKind: item.mediaKind,
        fromMe,
      })
        .filter((record) => !usedRecords.has(record.id))
        .filter((record) => hasSufficientImageInformation(record.fingerprint, env));
      candidateRecordCount += scopedCandidates.length;
      const candidates = scopedCandidates
        .map((record) => ({
          record,
          distance: hammingDistanceHex(item.fingerprint.value, record.fingerprint.value),
          colorDistance: hammingDistanceHex(item.fingerprint.colorValue, record.fingerprint.colorValue),
          momentDistance: colorMomentDistance(item.fingerprint.colorMoments, record.fingerprint.colorMoments),
        }))
        .filter((candidate) =>
          candidate.distance <= maxDistance &&
          candidate.colorDistance <= maxColorDistance &&
          candidate.momentDistance <= maxMomentDistance
        )
        .sort((left, right) =>
          (left.distance + left.colorDistance + left.momentDistance) -
          (right.distance + right.colorDistance + right.momentDistance)
        );
      if (candidates.length !== 1) {
        if (candidates.length > 1) ambiguous += 1;
        else unmatched += 1;
        continue;
      }
      const [candidate] = candidates;
      usedRecords.add(candidate.record.id);
      consumedRecords.add(candidate.record.id);
      matched.push({
        index: item.index,
        attachment: item.attachment,
        recordId: candidate.record.id,
        mediaKind: item.mediaKind,
        distance: candidate.distance,
        colorDistance: candidate.colorDistance,
        momentDistance: candidate.momentDistance,
        deliveredMessageId: candidate.record.deliveredMessageId,
      });
    }
    const matchedIndexes = new Set(matched.map((item) => item.index));
    const retained = mode === "enforce"
      ? items.filter((_attachment, index) => !matchedIndexes.has(index))
      : items;
    const retainedText = mode === "enforce" && matched.length
      ? retainedEchoText(text, matched.map((item) => item.attachment))
      : clean(text);
    const action = matched.length
      ? (mode === "shadow" ? "shadow" : (retained.length ? "filter" : "suppress"))
      : (ambiguous ? "ambiguous" : (fingerprintFailures ? "fingerprint_failed" : (lowInformation ? "low_information" : "no_match")));
    const records = mode === "enforce" && consumedRecords.size
      ? ledger.records.filter((record) => !consumedRecords.has(record.id))
      : ledger.records;
    let nextLedger = { ...ledger, records };
    const terminal = mode === "enforce" && matched.length > 0 && !retainedText && retained.length === 0;
    const scopedTerminalEventId = clean(terminalEventId);
    if (terminal && scopedTerminalEventId) {
      const appended = appendTransformedMediaEchoTerminalSuppression(nextLedger, {
        accountId,
        chatId,
        eventId: scopedTerminalEventId,
        result: { mode, action, matched, attachments: retained },
        env,
      });
      terminalSuppressionRecord = appended.record;
      if (!terminalSuppressionRecord) throw new Error("transformed_media_echo_terminal_event_scope_required");
      nextLedger = appended.ledger;
    }
    if (injectedAtomicWriteFailure(env, eventId)) {
      throw new Error("transformed_media_echo_atomic_write_injected_failure");
    }
    await writeTransformedMediaEchoLedger(filePath, nextLedger);
    return {
      matched,
      ambiguous,
      unmatched,
      imageCandidates,
      candidateRecordCount,
      retained,
      retainedText,
      action,
      terminal,
      terminalSuppressionRecorded: Boolean(terminalSuppressionRecord),
    };
  });

  const matched = matchedResult.matched;
  const ambiguous = matchedResult.ambiguous;
  const unmatched = matchedResult.unmatched;
  const cycleSignal = cycleSignalForOutcome({
    mode,
    source,
    matched,
    attachments: matchedResult.retained,
    candidateRecordCount: matchedResult.candidateRecordCount,
  });
  recordFilterTelemetry({
    action: matchedResult.action,
    mode,
    source,
    startedAtMs,
    matched,
    ambiguous,
    unmatched,
    cycleSignal,
  });
  return {
    mode,
    action: matchedResult.action,
    matched,
    attachments: matchedResult.retained,
    text: matchedResult.retainedText,
    ambiguous,
    unmatched,
    fingerprintFailures,
    lowInformation,
    imageCandidates: matchedResult.imageCandidates,
    candidateRecordCount: matchedResult.candidateRecordCount,
    terminal: matchedResult.terminal,
    terminalSuppressionRecorded: matchedResult.terminalSuppressionRecorded,
    cycleSignal,
  };
}
