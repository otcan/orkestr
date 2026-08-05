import { Buffer } from "node:buffer";
import { pathToFileURL } from "node:url";
import { resolveSecureSecretValue } from "../packages/core/src/secure-secrets.js";

const DEFAULT_API_BASE = "https://api.twilio.com";
const USED_BY = "twilio-smoke";

const credentialSpecs = {
  accountSid: {
    label: "Account SID",
    env: ["TWILIO_ACCOUNT_SID", "ORKESTR_TWILIO_ACCOUNT_SID"],
    secrets: ["twilio/account-sid", "twilio_account_sid", "twilio-account-sid"],
  },
  apiKeySid: {
    label: "API Key SID",
    env: ["TWILIO_API_KEY_SID", "ORKESTR_TWILIO_API_KEY_SID"],
    secrets: ["twilio/api-key-sid", "twilio_api_key_sid", "twilio-api-key-sid"],
  },
  apiKeySecret: {
    label: "API Key Secret",
    env: ["TWILIO_API_KEY_SECRET", "ORKESTR_TWILIO_API_KEY_SECRET"],
    secrets: ["twilio/api-key-secret", "twilio_api_key_secret", "twilio-api-key-secret"],
  },
};

function clean(value = "") {
  return String(value || "").trim();
}

function parseArgs(argv = []) {
  const options = {
    userId: "admin",
    json: false,
    includeNumbers: false,
    apiBase: clean(process.env.TWILIO_API_BASE) || DEFAULT_API_BASE,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") options.json = true;
    else if (arg === "--numbers") options.includeNumbers = true;
    else if (arg === "--user" || arg === "--user-id" || arg === "--owner-user-id") options.userId = clean(argv[++index]) || "admin";
    else if (arg === "--api-base" || arg === "--twilio-api-base") options.apiBase = clean(argv[++index]) || DEFAULT_API_BASE;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`unknown_arg:${arg}`);
  }
  return options;
}

function usage() {
  return [
    "Usage: node scripts/twilio-smoke.mjs [--user USER_ID] [--numbers] [--json]",
    "",
    "Runs read-only Twilio checks using Orkestr secure secrets or environment variables.",
    "No SMS, call, or mutable Twilio API action is performed.",
  ].join("\n");
}

function redactSid(value = "") {
  const text = clean(value);
  if (!text) return "";
  if (text.length <= 8) return "[redacted]";
  return `${text.slice(0, 4)}...${text.slice(-4)}`;
}

function redactPhoneNumber(value = "") {
  const text = clean(value);
  if (!text) return "";
  if (text.length <= 4) return "[redacted]";
  return `${"*".repeat(Math.max(0, text.length - 4))}${text.slice(-4)}`;
}

function sanitizeText(value = "", sensitiveValues = []) {
  let text = String(value || "");
  for (const sensitive of sensitiveValues.map(clean).filter(Boolean)) {
    text = text.split(sensitive).join("[redacted]");
  }
  return text.replace(/\b(?:AC|SK)[A-Za-z0-9]{20,}\b/g, (sid) => redactSid(sid));
}

async function resolveCredential(name, options = {}, env = process.env) {
  const spec = credentialSpecs[name];
  for (const envName of spec.env) {
    const value = clean(env[envName]);
    if (value) return { value, source: `env:${envName}` };
  }
  for (const secretName of spec.secrets) {
    const resolved = await resolveSecureSecretValue(secretName, {
      ownerUserId: options.userId,
      usedBy: USED_BY,
    }, env);
    if (clean(resolved?.value)) {
      return {
        value: clean(resolved.value),
        source: resolved.secret?.handle || `secret:${secretName}`,
      };
    }
  }
  return { value: "", source: "" };
}

async function loadCredentials(options = {}, env = process.env) {
  const entries = await Promise.all(Object.keys(credentialSpecs).map(async (name) => [
    name,
    await resolveCredential(name, options, env),
  ]));
  const resolved = Object.fromEntries(entries);
  const missing = Object.entries(resolved)
    .filter(([, item]) => !clean(item.value))
    .map(([name]) => credentialSpecs[name].label);
  if (missing.length) {
    const error = new Error(`missing_twilio_credentials:${missing.join(", ")}`);
    error.missing = missing;
    throw error;
  }
  return {
    accountSid: resolved.accountSid.value,
    apiKeySid: resolved.apiKeySid.value,
    apiKeySecret: resolved.apiKeySecret.value,
    sources: {
      accountSid: resolved.accountSid.source,
      apiKeySid: resolved.apiKeySid.source,
      apiKeySecret: resolved.apiKeySecret.source,
    },
  };
}

function twilioAuthHeader(credentials = {}) {
  const token = Buffer.from(`${credentials.apiKeySid}:${credentials.apiKeySecret}`, "utf8").toString("base64");
  return `Basic ${token}`;
}

async function twilioGet(route, credentials = {}, options = {}, deps = {}) {
  const apiBase = clean(options.apiBase) || DEFAULT_API_BASE;
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("fetch_unavailable");
  const url = new URL(route, apiBase);
  const response = await fetchImpl(url, {
    method: "GET",
    headers: {
      authorization: twilioAuthHeader(credentials),
      accept: "application/json",
    },
  });
  const bodyText = await response.text();
  let body = {};
  try {
    body = bodyText ? JSON.parse(bodyText) : {};
  } catch {
    body = {};
  }
  if (!response.ok) {
    const message = sanitizeText(
      body?.message || bodyText || `twilio_http_${response.status}`,
      [credentials.accountSid, credentials.apiKeySid, credentials.apiKeySecret],
    );
    const error = new Error(`twilio_request_failed:${response.status}:${message}`);
    error.status = response.status;
    error.code = body?.code || "";
    throw error;
  }
  return body;
}

function publicSource(source = "") {
  if (!source) return "";
  if (source.startsWith("env:")) return source;
  return source.replace(/^secret:\/\/user\/([^/]+)\//, "secret://user/$1/");
}

export async function runTwilioSmoke(options = {}, deps = {}) {
  const env = options.env || process.env;
  const userId = clean(options.userId) || "admin";
  const credentials = await loadCredentials({ userId }, env);
  const account = await twilioGet(`/2010-04-01/Accounts/${encodeURIComponent(credentials.accountSid)}.json`, credentials, options, deps);
  if (clean(account.sid) && clean(account.sid) !== credentials.accountSid) {
    throw new Error("twilio_account_sid_mismatch");
  }

  const result = {
    ok: true,
    mode: "read_only",
    userId,
    account: {
      sid: redactSid(account.sid || credentials.accountSid),
      sidMatches: true,
      status: clean(account.status) || "unknown",
      friendlyNamePresent: Boolean(clean(account.friendly_name)),
    },
    credentials: {
      accountSid: { configured: true, source: publicSource(credentials.sources.accountSid) },
      apiKeySid: { configured: true, sid: redactSid(credentials.apiKeySid), source: publicSource(credentials.sources.apiKeySid) },
      apiKeySecret: { configured: true, source: publicSource(credentials.sources.apiKeySecret) },
    },
    numbers: {
      checked: false,
      count: null,
      sample: [],
    },
  };

  if (options.includeNumbers) {
    const numbers = await twilioGet(`/2010-04-01/Accounts/${encodeURIComponent(credentials.accountSid)}/IncomingPhoneNumbers.json?PageSize=20`, credentials, options, deps);
    const incoming = Array.isArray(numbers.incoming_phone_numbers) ? numbers.incoming_phone_numbers : [];
    result.numbers = {
      checked: true,
      count: incoming.length,
      sample: incoming.slice(0, 3).map((item) => ({
        sid: redactSid(item.sid),
        phoneNumber: redactPhoneNumber(item.phone_number),
        friendlyNamePresent: Boolean(clean(item.friendly_name)),
        capabilities: item.capabilities && typeof item.capabilities === "object"
          ? Object.fromEntries(Object.entries(item.capabilities).map(([key, value]) => [key, Boolean(value)]))
          : {},
      })),
    };
  }

  return result;
}

export function formatTwilioSmokeResult(result = {}) {
  const lines = [
    "Twilio smoke ok",
    `Mode: ${result.mode || "read_only"}`,
    `Account: ${result.account?.sid || "-"} (${result.account?.status || "unknown"})`,
    `API key: ${result.credentials?.apiKeySid?.sid || "configured"}`,
  ];
  if (result.numbers?.checked) {
    lines.push(`Incoming numbers checked: ${result.numbers.count}`);
  } else {
    lines.push("Incoming numbers: skipped (pass --numbers for a read-only count)");
  }
  lines.push("No SMS, call, or mutable Twilio action was performed.");
  return `${lines.join("\n")}\n`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const result = await runTwilioSmoke(options);
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else process.stdout.write(formatTwilioSmokeResult(result));
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error?.message || String(error));
    process.exit(1);
  });
}
