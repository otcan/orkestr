#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { sendReleaseWhatsAppNotifications } from "../packages/connectors/src/release-whatsapp-notifications.js";

function argValue(argv, flag, fallback = "") {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] || fallback : fallback;
}

async function cliAuthToken(env = process.env) {
  const explicit = String(env.ORKESTR_API_TOKEN || env.ORKESTR_CLI_AUTH_TOKEN || "").trim();
  if (explicit) return explicit;
  const home = String(env.ORKESTR_HOME || "").trim();
  if (!home) return "";
  try {
    const raw = await fs.readFile(path.join(home, "secrets", "cli-auth.json"), "utf8");
    const parsed = JSON.parse(raw);
    const token = String(parsed?.token || "").trim();
    if (!token) return "";
    const expiresAt = Date.parse(String(parsed?.expiresAt || ""));
    if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) return "";
    return token;
  } catch {
    return "";
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const result = await sendReleaseWhatsAppNotifications({
    releaseId: argValue(argv, "--release-id", process.env.ORKESTR_RELEASE_ID || ""),
    channel: argValue(argv, "--channel", process.env.ORKESTR_DEPLOY_CHANNEL || ""),
    commit: argValue(argv, "--commit", process.env.ORKESTR_RELEASE_COMMIT || ""),
    deployedAt: argValue(argv, "--deployed-at", ""),
    apiBase: argValue(argv, "--api-base", process.env.ORKESTR_API_BASE || ""),
    token: argValue(argv, "--token", "") || await cliAuthToken(process.env),
  }, process.env, fetch);

  const line = [
    `Release WhatsApp notifications: ${result.enabled ? "enabled" : "disabled"}`,
    `targets=${result.targetCount}`,
    `sent=${result.sent}`,
    `failed=${result.failed}`,
    `skippedDelivered=${result.skippedDelivered}`,
    `skippedPending=${result.skippedPending}`,
  ].join(" ");
  if (argv.includes("--json")) console.log(JSON.stringify(result, null, 2));
  else console.log(line);
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  main().catch((error) => {
    console.error(`Release WhatsApp notifications failed: ${error?.stack || error?.message || String(error)}`);
    process.exitCode = 1;
  });
}
