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
    mode: "",
    calleGoal: "",
    calleLanguage: "",
    calleRegion: "",
    calleLiveStreamUrl: "",
    calleCallbackMessage: "",
    twilioAuthToken: "",
    introMessage: "",
    introMessageEnglish: "",
    englishLanguage: "",
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
    else if (arg === "--mode") options.mode = clean(argv[++index]);
    else if (arg === "--calle-goal") options.calleGoal = clean(argv[++index]);
    else if (arg === "--calle-language") options.calleLanguage = clean(argv[++index]);
    else if (arg === "--calle-region") options.calleRegion = clean(argv[++index]);
    else if (arg === "--calle-live-stream-url") options.calleLiveStreamUrl = clean(argv[++index]);
    else if (arg === "--calle-callback-message") options.calleCallbackMessage = clean(argv[++index]);
    else if (arg === "--twilio-auth-token") options.twilioAuthToken = clean(argv[++index]);
    else if (arg === "--intro-message") options.introMessage = clean(argv[++index]);
    else if (arg === "--intro-message-en" || arg === "--intro-message-english") options.introMessageEnglish = clean(argv[++index]);
    else if (arg === "--english-language") options.englishLanguage = clean(argv[++index]);
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`unknown_arg:${arg}`);
  }
  return options;
}

function usage() {
  return [
    "Usage:",
    "  node scripts/twilio-voice-assistant.mjs status [--user admin] [--public-url URL] [--json]",
    "  node scripts/twilio-voice-assistant.mjs configure-secrets --summary-to EMAIL --public-url URL [--assistant-label TEXT] [--mode twilio-native|calle-callback|calle-live] [--intro-message TEXT] [--intro-message-en TEXT] [--calle-goal TEXT] [--calle-callback-message TEXT] [--calle-live-stream-url WSS_URL] [--webhook-token TOKEN] [--twilio-auth-token TOKEN] [--user admin] [--json]",
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
  const baseReady = Boolean(config.webhookToken && config.summaryTo && config.publicBaseUrl);
  const callbackAuthReady = config.mode !== "calle_callback" || Boolean(config.twilioAuthToken);
  const callbackGoalReady = config.mode !== "calle_callback" || Boolean(config.calleGoal && config.calleGoalConfigured !== false);
  const modeReady = config.mode !== "calle_live" || Boolean(config.calleLiveStreamUrl);
  const staticBlockers = [
    !baseReady ? "twilio_voice_base_config_incomplete" : "",
    config.mode === "calle_callback" && !config.twilioAuthToken ? "twilio_voice_signature_auth_token_required" : "",
    config.mode === "calle_callback" && !callbackGoalReady ? "twilio_voice_calle_goal_required" : "",
    config.mode === "calle_live" && !config.calleLiveStreamUrl ? "twilio_voice_calle_live_stream_url_missing" : "",
  ].filter(Boolean);
  const staticConfigured = staticBlockers.length === 0;
  const operationalBlockers = [
    ...staticBlockers,
    staticConfigured && config.mode === "calle_callback" ? "twilio_voice_webhook_not_verified" : "",
    staticConfigured && config.mode === "calle_callback" ? "twilio_voice_calle_auth_not_verified" : "",
    staticConfigured && config.mode === "calle_callback" ? "twilio_voice_calle_reachability_not_verified" : "",
  ].filter(Boolean);
  const urls = config.webhookToken && config.publicBaseUrl ? publicWebhookUrls(config) : null;
  return {
    ok: staticConfigured,
    mode: "status",
    userId: config.ownerUserId,
    voiceMode: config.mode,
    errors: staticBlockers,
    configured: {
      webhookToken: Boolean(config.webhookToken),
      summaryTo: Boolean(config.summaryTo),
      publicBaseUrl: Boolean(config.publicBaseUrl),
      assistantLabel: Boolean(config.assistantLabel),
      introMessage: Boolean(config.introMessage),
      introMessageEnglish: Boolean(config.introMessageEnglish),
      englishLanguage: Boolean(config.englishLanguage),
      calleGoal: Boolean(config.calleGoal && config.calleGoalConfigured !== false),
      calleLanguage: Boolean(config.calleLanguage),
      calleRegion: Boolean(config.calleRegion),
      calleLiveStreamUrl: Boolean(config.calleLiveStreamUrl),
      calleCallbackMessage: Boolean(config.calleCallbackMessage),
      twilioSignatureAuthToken: Boolean(config.twilioAuthToken),
    },
    callback: {
      enabled: config.mode === "calle_callback",
      configured: Boolean(config.mode === "calle_callback" && baseReady && callbackAuthReady && callbackGoalReady),
      copyConfigured: Boolean(config.calleCallbackMessage),
      auth: {
        twilioSignatureValidationRequired: true,
        twilioSignatureValidationConfigured: Boolean(config.twilioAuthToken),
        calleAuthChecked: false,
        calleAuthOk: null,
        reason: "not_checked_by_default",
      },
      reachability: {
        checked: false,
        ok: null,
        reason: "not_checked_by_default",
      },
      operationalReady: false,
    },
    readiness: {
      ready: operationalBlockers.length === 0,
      staticConfigured,
      operationalReady: operationalBlockers.length === 0,
      code: {
        twilioNative: true,
        calleCallback: true,
        calleLiveFailClosed: true,
      },
      operatorConfig: {
        baseConfigured: baseReady,
        selectedModeConfigured: Boolean(modeReady && callbackAuthReady && callbackGoalReady),
        calleGoalConfigured: Boolean(config.calleGoal && config.calleGoalConfigured !== false),
        callbackSignatureAuthTokenConfigured: Boolean(config.twilioAuthToken),
        liveGatewayConfigured: Boolean(config.calleLiveStreamUrl),
      },
      verification: {
        twilioWebhookChecked: false,
        twilioWebhookOk: null,
        calleAuthChecked: false,
        calleAuthOk: null,
        calleReachabilityChecked: false,
        calleReachabilityOk: null,
        reason: "not_checked_by_default",
      },
      staticBlockers,
      operationalBlockers,
      blockers: operationalBlockers,
    },
    liveGateway: {
      enabled: config.mode === "calle_live",
      configured: Boolean(config.calleLiveStreamUrl),
      failClosed: true,
      streamUrlConfigured: Boolean(config.calleLiveStreamUrl),
    },
    twilioWebhook: {
      expectedIncomingUrl: urls?.incoming || "",
      expectedGatherUrl: urls?.gather || "",
      checkedAgainstTwilio: false,
      matchesExpectedIncomingUrl: null,
      reason: "not_checked_by_default",
    },
    urls,
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
  if (clean(options.mode)) {
    writes.push(await setSecureSecret({ scope: "user", ownerUserId: userId, name: "twilio_voice_mode", value: options.mode }, principal, env));
  }
  if (clean(options.calleGoal)) {
    writes.push(await setSecureSecret({ scope: "user", ownerUserId: userId, name: "twilio_voice_calle_goal", value: options.calleGoal }, principal, env));
  }
  if (clean(options.calleLanguage)) {
    writes.push(await setSecureSecret({ scope: "user", ownerUserId: userId, name: "twilio_voice_calle_language", value: options.calleLanguage }, principal, env));
  }
  if (clean(options.calleRegion)) {
    writes.push(await setSecureSecret({ scope: "user", ownerUserId: userId, name: "twilio_voice_calle_region", value: options.calleRegion }, principal, env));
  }
  if (clean(options.calleLiveStreamUrl)) {
    writes.push(await setSecureSecret({ scope: "user", ownerUserId: userId, name: "twilio_voice_calle_live_stream_url", value: options.calleLiveStreamUrl }, principal, env));
  }
  if (clean(options.calleCallbackMessage)) {
    writes.push(await setSecureSecret({ scope: "user", ownerUserId: userId, name: "twilio_voice_calle_callback_message", value: options.calleCallbackMessage }, principal, env));
  }
  if (clean(options.twilioAuthToken)) {
    writes.push(await setSecureSecret({ scope: "user", ownerUserId: userId, name: "twilio_voice_auth_token", value: options.twilioAuthToken }, principal, env));
  }
  if (clean(options.introMessage)) {
    writes.push(await setSecureSecret({ scope: "user", ownerUserId: userId, name: "twilio_voice_intro_message", value: options.introMessage }, principal, env));
  }
  if (clean(options.introMessageEnglish)) {
    writes.push(await setSecureSecret({ scope: "user", ownerUserId: userId, name: "twilio_voice_intro_message_en", value: options.introMessageEnglish }, principal, env));
  }
  if (clean(options.englishLanguage)) {
    writes.push(await setSecureSecret({ scope: "user", ownerUserId: userId, name: "twilio_voice_english_language", value: options.englishLanguage }, principal, env));
  }
  const config = await twilioVoiceAssistantConfig({
    userId,
    publicBaseUrl: options.publicUrl,
    webhookToken: token,
    summaryTo: options.summaryTo,
    assistantLabel: options.assistantLabel,
    mode: options.mode,
    calleGoal: options.calleGoal,
    calleLanguage: options.calleLanguage,
    calleRegion: options.calleRegion,
    calleLiveStreamUrl: options.calleLiveStreamUrl,
    calleCallbackMessage: options.calleCallbackMessage,
    twilioAuthToken: options.twilioAuthToken,
    introMessage: options.introMessage,
    introMessageEnglish: options.introMessageEnglish,
    englishLanguage: options.englishLanguage,
  }, env);
  return {
    ok: true,
    mode: "configure_secrets",
    userId,
    secrets: writes.map((item) => item.secret?.handle).filter(Boolean),
    urls: publicWebhookUrls(config),
    voiceMode: config.mode,
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
  if (config.mode === "calle_callback" && !config.twilioAuthToken) {
    throw new Error("twilio_voice_signature_auth_token_required: configure --twilio-auth-token before pointing a Twilio number at calle-callback mode");
  }
  if (config.mode === "calle_callback" && (!config.calleGoal || config.calleGoalConfigured === false)) {
    throw new Error("twilio_voice_calle_goal_required: configure --calle-goal before pointing a Twilio number at calle-callback mode");
  }
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
  if (config.mode === "calle_callback" && !config.twilioAuthToken) {
    throw new Error("twilio_voice_signature_auth_token_required: configure --twilio-auth-token before buying/configuring a Twilio callback number");
  }
  if (config.mode === "calle_callback" && (!config.calleGoal || config.calleGoalConfigured === false)) {
    throw new Error("twilio_voice_calle_goal_required: configure --calle-goal before buying/configuring a Twilio callback number");
  }
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
