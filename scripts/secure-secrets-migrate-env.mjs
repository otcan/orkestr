import fs from "node:fs/promises";
import path from "node:path";
import { adminPrincipal } from "../packages/core/src/principal.js";
import { listSecureSecrets, setSecureSecret } from "../packages/core/src/secure-secrets.js";

const candidates = [
  { name: "openai/api-key", env: ["OPENAI_API_KEY", "ORKESTR_OPENAI_API_KEY"] },
  { name: "gmail/client-secret", env: ["GMAIL_OAUTH_CLIENT_SECRET", "GOOGLE_OAUTH_CLIENT_SECRET"] },
  { name: "jira/client-secret", env: ["JIRA_OAUTH_CLIENT_SECRET", "ATLASSIAN_OAUTH_CLIENT_SECRET", "ATLASSIAN_CLIENT_SECRET"] },
  { name: "shopify/client-secret", env: ["SHOPIFY_OAUTH_CLIENT_SECRET", "SHOPIFY_CLIENT_SECRET", "SHOPIFY_API_SECRET"] },
  { name: "whatsapp/bridge-token", env: ["WHATSAPP_BRIDGE_TOKEN", "WA_HTTP_TOKEN"] },
  { name: "whatsapp/inbound-token", env: ["ORKESTR_WHATSAPP_INBOUND_TOKEN", "WHATSAPP_INBOUND_TOKEN"] },
  { name: "orkestr/api-token", env: ["ORKESTR_API_TOKEN", "ORKESTR_CLI_AUTH_TOKEN"] },
  { name: "outlook/smtp-password", env: ["ORKESTR_OUTLOOK_SMTP_PASSWORD", "OUTLOOK_SMTP_PASSWORD"] },
  { name: "outlook/graph-access-token", env: ["ORKESTR_GRAPH_MAIL_ACCESS_TOKEN", "ORKESTR_OUTLOOK_GRAPH_ACCESS_TOKEN", "OUTLOOK_GRAPH_ACCESS_TOKEN"] },
];

function clean(value = "") {
  return String(value || "").trim();
}

function parseArgs(argv) {
  const options = {
    write: false,
    envFile: "",
    scope: "global",
    userId: "",
    json: true,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--write") options.write = true;
    else if (arg === "--dry-run") options.write = false;
    else if (arg === "--env-file") options.envFile = clean(argv[++index]);
    else if (arg === "--scope") options.scope = clean(argv[++index]) === "user" ? "user" : "global";
    else if (arg === "--user" || arg === "--user-id") {
      options.scope = "user";
      options.userId = clean(argv[++index]);
    } else if (arg === "--global") {
      options.scope = "global";
      options.userId = "";
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`unknown_arg:${arg}`);
    }
  }
  return options;
}

function parseEnvFileText(text = "") {
  const values = {};
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

async function loadEnv(options) {
  const fromFile = options.envFile
    ? parseEnvFileText(await fs.readFile(path.resolve(options.envFile), "utf8"))
    : {};
  return { ...process.env, ...fromFile };
}

function candidateValue(candidate, env) {
  for (const envName of candidate.env) {
    const value = clean(env[envName]);
    if (value) return { envName, value };
  }
  return null;
}

function targetFor(options) {
  if (options.scope === "user") return { scope: "user", ownerUserId: options.userId || "admin" };
  return { scope: "global" };
}

function publicPlanItem(candidate, found, action, secret = null) {
  return {
    name: candidate.name,
    sourceEnv: found.envName,
    action,
    handle: secret?.handle || "",
    status: secret?.status || (action === "dry_run" ? "candidate" : "unknown"),
  };
}

async function migrate(options) {
  const env = await loadEnv(options);
  const principal = adminPrincipal(env.ORKESTR_ADMIN_USER_ID || "admin");
  const target = targetFor(options);
  const items = [];
  for (const candidate of candidates) {
    const found = candidateValue(candidate, env);
    if (!found) continue;
    if (!options.write) {
      items.push(publicPlanItem(candidate, found, "dry_run"));
      continue;
    }
    const result = await setSecureSecret({
      ...target,
      name: candidate.name,
      value: found.value,
    }, principal, env);
    items.push(publicPlanItem(candidate, found, "written", result.secret));
  }
  const listed = options.write ? await listSecureSecrets(target, principal, env) : { secrets: [] };
  return {
    ok: true,
    mode: options.write ? "write" : "dry_run",
    scope: target.scope,
    ownerUserId: target.ownerUserId || null,
    migrated: items,
    configuredCount: listed.secrets.filter((secret) => secret.configured !== false).length,
  };
}

function usage() {
  return [
    "Usage: node scripts/secure-secrets-migrate-env.mjs [--env-file FILE] [--write] [--global|--user USER_ID]",
    "",
    "Dry-run is the default. Output reports only secret names, handles, source env names, and status.",
  ].join("\n");
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  console.log(usage());
  process.exit(0);
}

migrate(options).then((result) => {
  console.log(JSON.stringify(result, null, 2));
}).catch((error) => {
  console.error(error?.message || String(error));
  process.exit(1);
});
