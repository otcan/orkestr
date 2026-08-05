import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { adminPrincipal } from "../packages/core/src/principal.js";
import { resolveSecureSecretValue, setSecureSecret } from "../packages/core/src/secure-secrets.js";
import { twilioVoiceAssistantConfig, twilioVoiceWebhookUrls } from "../packages/connectors/src/twilio-voice-assistant.js";
import { loadCredentials, redactPhoneNumber, redactSid, twilioGet, twilioRequest } from "./twilio-smoke.mjs";

function clean(value = "") {
  return String(value || "").trim();
}

function parseArgs(argv = []) {
  const command = clean(argv[0] || "status");
  const options = {
    command,
    userId: "admin",
    json: false,
    yes: false,
    pageSize: 10,
    publicUrl: "",
    summaryTo: "",
    assistantLabel: "",
    webhookToken: "",
    phoneNumber: "",
    region: "",
  };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") options.json = true;
    else if (arg === "--yes" || arg === "-y") options.yes = true;
    else if (arg === "--user" || arg === "--user-id") options.userId = clean(argv[++index]) || "admin";
    else if (arg === "--page-size" || arg === "--limit") options.pageSize = Math.max(1, Math.min(20, Number(argv[++index]) || 10));
    else if (arg === "--public-url") options.publicUrl = clean(argv[++index]);
    else if (arg === "--summary-to") options.summaryTo = clean(argv[++index]);
    else if (arg === "--assistant-label") options.assistantLabel = clean(argv[++index]);
    else if (arg === "--webhook-token") options.webhookToken = clean(argv[++index]);
    else if (arg === "--phone-number" || arg === "--number") options.phoneNumber = clean(argv[++index]);
    else if (arg === "--region") options.region = clean(argv[++index]);
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`unknown_arg:${arg}`);
  }
  return options;
}

function usage() {
  return [
    "Usage:",
    "  node scripts/twilio-voice-assistant.mjs status [--user admin] [--public-url URL] [--json]",
    "  node scripts/twilio-voice-assistant.mjs configure-secrets --summary-to EMAIL --public-url URL [--assistant-label TEXT] [--webhook-token TOKEN] [--user admin] [--json]",
    "  node scripts/twilio-voice-assistant.mjs search-de [--page-size 10] [--region Berlin] [--json]",
    "  node scripts/twilio-voice-assistant.mjs buy-number --phone-number +49... --public-url URL --yes [--user admin] [--json]",
    "  node scripts/twilio-voice-assistant.mjs configure-number --phone-number +49... --public-url URL --yes [--user admin] [--json]",
    "",
    "search-de is read-only. buy-number purchases a Twilio number. configure-number mutates an owned Twilio number voice webhook. Mutating commands require --yes.",
  ].join("\n");
}

function generatedToken() {
  return randomBytes(24).toString("base64url");
}

function publicWebhookUrls(config = {}) {
  const urls = twilioVoiceWebhookUrls(config);
  const token = clean(config.webhookToken);
  if (!token) return urls;
  return Object.fromEntries(Object.entries(urls).map(([key, value]) => [
    key,
    String(value || "").replace(encodeURIComponent(token), "[token-redacted]"),
  ]));
}

async function getStoredOrProvidedToken(options = {}, env = process.env) {
  if (clean(options.webhookToken)) return clean(options.webhookToken);
  const resolved = await resolveSecureSecretValue("twilio_voice_webhook_token", {
    ownerUserId: options.userId,
    usedBy: "twilio-voice-assistant-setup",
  }, env);
  return clean(resolved?.value);
}

async function status(options = {}, env = process.env) {
  const config = await twilioVoiceAssistantConfig({
    userId: options.userId,
    publicBaseUrl: options.publicUrl,
  }, env);
  return {
    ok: Boolean(config.webhookToken && config.summaryTo && config.publicBaseUrl),
    mode: "status",
    userId: config.ownerUserId,
    configured: {
      webhookToken: Boolean(config.webhookToken),
      summaryTo: Boolean(config.summaryTo),
      publicBaseUrl: Boolean(config.publicBaseUrl),
      assistantLabel: Boolean(config.assistantLabel),
    },
    urls: config.webhookToken && config.publicBaseUrl ? publicWebhookUrls(config) : null,
  };
}

async function configureSecrets(options = {}, env = process.env) {
  if (!clean(options.summaryTo)) throw new Error("summary_to_required");
  if (!clean(options.publicUrl)) throw new Error("public_url_required");
  const userId = clean(options.userId) || "admin";
  const principal = adminPrincipal(env.ORKESTR_ADMIN_USER_ID || "admin");
  const token = clean(options.webhookToken) || await getStoredOrProvidedToken(options, env) || generatedToken();
  const writes = [
    await setSecureSecret({ scope: "user", ownerUserId: userId, name: "twilio_voice_summary_to", value: options.summaryTo }, principal, env),
    await setSecureSecret({ scope: "user", ownerUserId: userId, name: "twilio_voice_webhook_token", value: token }, principal, env),
    await setSecureSecret({ scope: "user", ownerUserId: userId, name: "twilio_voice_public_url", value: options.publicUrl }, principal, env),
  ];
  if (clean(options.assistantLabel)) {
    writes.push(await setSecureSecret({ scope: "user", ownerUserId: userId, name: "twilio_voice_assistant_label", value: options.assistantLabel }, principal, env));
  }
  const config = await twilioVoiceAssistantConfig({
    userId,
    publicBaseUrl: options.publicUrl,
    webhookToken: token,
    summaryTo: options.summaryTo,
    assistantLabel: options.assistantLabel,
  }, env);
  return {
    ok: true,
    mode: "configure_secrets",
    userId,
    secrets: writes.map((item) => item.secret?.handle).filter(Boolean),
    urls: publicWebhookUrls(config),
  };
}

async function searchGermanNumbers(options = {}, env = process.env) {
  const credentials = await loadCredentials({ userId: options.userId }, env);
  const params = new URLSearchParams({
    VoiceEnabled: "true",
    PageSize: String(options.pageSize || 10),
  });
  if (clean(options.region)) params.set("InRegion", clean(options.region));
  const payload = await twilioGet(`/2010-04-01/Accounts/${encodeURIComponent(credentials.accountSid)}/AvailablePhoneNumbers/DE/Local.json?${params.toString()}`, credentials);
  const numbers = Array.isArray(payload.available_phone_numbers) ? payload.available_phone_numbers : [];
  return {
    ok: true,
    mode: "search_de",
    country: "DE",
    numberType: "Local",
    count: numbers.length,
    numbers: numbers.map((item) => ({
      phoneNumber: clean(item.phone_number),
      locality: clean(item.locality),
      region: clean(item.region),
      isoCountry: clean(item.iso_country),
      capabilities: item.capabilities && typeof item.capabilities === "object"
        ? Object.fromEntries(Object.entries(item.capabilities).map(([key, value]) => [key, Boolean(value)]))
        : {},
      beta: Boolean(item.beta),
    })),
  };
}

async function ownedNumberSid(credentials = {}, phoneNumber = "") {
  const params = new URLSearchParams({ PhoneNumber: phoneNumber });
  const payload = await twilioGet(`/2010-04-01/Accounts/${encodeURIComponent(credentials.accountSid)}/IncomingPhoneNumbers.json?${params.toString()}`, credentials);
  const items = Array.isArray(payload.incoming_phone_numbers) ? payload.incoming_phone_numbers : [];
  return clean(items[0]?.sid);
}

async function configureOwnedNumber(options = {}, env = process.env) {
  if (!options.yes) throw new Error("configure_number_requires_yes");
  if (!clean(options.phoneNumber)) throw new Error("phone_number_required");
  if (!clean(options.publicUrl)) throw new Error("public_url_required");
  const token = await getStoredOrProvidedToken(options, env);
  if (!token) throw new Error("twilio_voice_webhook_token_missing: run configure-secrets first");
  const config = await twilioVoiceAssistantConfig({
    userId: options.userId,
    publicBaseUrl: options.publicUrl,
    webhookToken: token,
  }, env);
  const credentials = await loadCredentials({ userId: options.userId }, env);
  const sid = await ownedNumberSid(credentials, options.phoneNumber);
  if (!sid) throw new Error("twilio_number_not_owned");
  const body = new URLSearchParams({
    VoiceUrl: twilioVoiceWebhookUrls(config).incoming,
    VoiceMethod: "POST",
  });
  const updated = await twilioRequest("POST", `/2010-04-01/Accounts/${encodeURIComponent(credentials.accountSid)}/IncomingPhoneNumbers/${encodeURIComponent(sid)}.json`, credentials, { body });
  return {
    ok: true,
    mode: "configure_number",
    phoneNumber: redactPhoneNumber(options.phoneNumber),
    numberSid: redactSid(updated.sid || sid),
    voiceUrlConfigured: Boolean(updated.voice_url),
    voiceMethod: clean(updated.voice_method),
  };
}

async function buyNumber(options = {}, env = process.env) {
  if (!options.yes) throw new Error("buy_number_requires_yes");
  if (!clean(options.phoneNumber)) throw new Error("phone_number_required");
  if (!clean(options.publicUrl)) throw new Error("public_url_required");
  const token = await getStoredOrProvidedToken(options, env);
  if (!token) throw new Error("twilio_voice_webhook_token_missing: run configure-secrets first");
  const config = await twilioVoiceAssistantConfig({
    userId: options.userId,
    publicBaseUrl: options.publicUrl,
    webhookToken: token,
  }, env);
  const credentials = await loadCredentials({ userId: options.userId }, env);
  const body = new URLSearchParams({
    PhoneNumber: options.phoneNumber,
    VoiceUrl: twilioVoiceWebhookUrls(config).incoming,
    VoiceMethod: "POST",
  });
  const purchased = await twilioRequest("POST", `/2010-04-01/Accounts/${encodeURIComponent(credentials.accountSid)}/IncomingPhoneNumbers.json`, credentials, { body });
  return {
    ok: true,
    mode: "buy_number",
    phoneNumber: clean(purchased.phone_number || options.phoneNumber),
    numberSid: redactSid(purchased.sid),
    voiceUrlConfigured: Boolean(purchased.voice_url),
    voiceMethod: clean(purchased.voice_method),
  };
}

function formatResult(result = {}) {
  if (result.mode === "search_de") {
    return [
      `German Twilio voice numbers found: ${result.count}`,
      ...(result.numbers || []).map((number) => [
        number.phoneNumber,
        [number.locality, number.region].filter(Boolean).join(", "),
        number.capabilities?.voice ? "voice" : "",
      ].filter(Boolean).join(" - ")),
    ].join("\n") + "\n";
  }
  if (result.mode === "configure_secrets") {
    return [
      "Twilio voice assistant config stored.",
      `Incoming webhook: ${result.urls?.incoming || "-"}`,
      "Secret values were not printed.",
    ].join("\n") + "\n";
  }
  if (result.mode === "configure_number") {
    return [
      "Twilio number webhook configured.",
      `Number: ${result.phoneNumber}`,
      `Number SID: ${result.numberSid}`,
      `Voice method: ${result.voiceMethod || "-"}`,
    ].join("\n") + "\n";
  }
  if (result.mode === "buy_number") {
    return [
      "Twilio German number purchased and webhook configured.",
      `Number: ${result.phoneNumber}`,
      `Number SID: ${result.numberSid}`,
      `Voice method: ${result.voiceMethod || "-"}`,
    ].join("\n") + "\n";
  }
  return JSON.stringify(result, null, 2) + "\n";
}

async function run(options = parseArgs(process.argv.slice(2)), env = process.env) {
  if (options.help) return { help: true };
  if (options.command === "status") return status(options, env);
  if (options.command === "configure-secrets") return configureSecrets(options, env);
  if (options.command === "search-de") return searchGermanNumbers(options, env);
  if (options.command === "buy-number") return buyNumber(options, env);
  if (options.command === "configure-number") return configureOwnedNumber(options, env);
  throw new Error(`unknown_command:${options.command}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    process.exit(0);
  }
  run(options).then((result) => {
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else process.stdout.write(formatResult(result));
  }).catch((error) => {
    console.error(error?.message || String(error));
    process.exit(1);
  });
}

export { buyNumber, configureOwnedNumber, configureSecrets, run, searchGermanNumbers, status };
