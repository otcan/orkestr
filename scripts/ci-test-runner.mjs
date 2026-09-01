import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function clean(value = "") {
  return String(value || "").trim();
}

function hasFlag(argv, name) {
  return argv.includes(name);
}

function flagValue(argv, name, fallback = "") {
  const index = argv.indexOf(name);
  return index >= 0 ? clean(argv[index + 1]) : fallback;
}

function positiveInteger(value, fallback, minimum = 1) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.floor(parsed)) : fallback;
}

function truthy(value) {
  return ["1", "true", "yes", "on"].includes(clean(value).toLowerCase());
}

const scrubbedCiEnvKeys = [
  "ORKESTR_HOME",
  "ORKESTR_OVERLAY_DIR",
  "ORKESTR_INSTANCE_IDENTITY_FILE",
  "ORKESTR_CANONICAL_PUBLIC_REF_LOCK",
  "ORKESTR_INSTANCE_STATE_ROOT",
  "ORKESTR_RUNTIME_SETTINGS_FILE",
  "ORKESTR_WORKFLOW_LEADS_FILE",
  "ORKESTR_PROJECT_INQUIRIES_FILE",
  "ORKESTR_DESKTOP_LEASE_FILE",
  "ORKESTR_DESKTOP_ACCESS_FILE",
  "ORKESTR_THREAD_RESOURCE_POLICY_DB",
  "ORKESTR_JOBS_QUEUE_FILE",
  "ORKESTR_JOB_ALERT_ROUTES_FILE",
  "ORKESTR_MAIL_DRAFTS_FILE",
  "ORKESTR_TWILIO_VOICE_CALLBACKS_FILE",
  "ORKESTR_JOBS_JD_CACHE_ACCESS_FILE",
  "ORKESTR_FREELANCE_DE_JOBS_DB",
  "ORKESTR_GMAIL_SIGNAL_RECORD_ROOT",
  "ORKESTR_MAILBOXES_FILE",
  "ORKESTR_CONNECTOR_OUTBOX_DB",
  "ORKESTR_CONNECTOR_INBOX_DB",
  "ORKESTR_BROKER_INSTANCES_FILE",
  "ORKESTR_BROKER_INSTANCES_DB",
  "ORKESTR_BROKER_CHANNEL_FILE",
  "ORKESTR_BROKER_CLIENT_IDENTITY_FILE",
  "ORKESTR_BROKER_REGISTRATION_INTENT_FILE",
  "ORKESTR_BROKER_CLIENT_REGISTRATION_FILE",
  "ORKESTR_RELEASE_INSTANCES_FILE",
  "ORKESTR_PUBLIC_APPS_FILE",
  "ORKESTR_SHARED_APPS_FILE",
  "ORKESTR_KEYCLOAK_OIDC_STATE_FILE",
  "ORKESTR_LINKEDIN_OUTREACH_BINDINGS_FILE",
  "ORKESTR_DEPLOY_DRAIN_FILE",
  "ORKESTR_CONNECTOR_STAGE_DIR",
  "ORKESTR_MAILBOX_SPOOL_DIR",
  "ORKESTR_STORAGE",
  "ORKESTR_THREAD_STORE",
  "ORKESTR_THREAD_MESSAGE_STORE",
  "ORKESTR_CONNECTOR_OUTBOX_STORE",
  "ORKESTR_CONNECTOR_OUTBOX_BACKEND",
  "ORKESTR_CONNECTOR_OUTBOX_POSTGRES_URL",
  "ORKESTR_CONNECTOR_OUTBOX_PGHOST",
  "ORKESTR_CONNECTOR_OUTBOX_PGPORT",
  "ORKESTR_CONNECTOR_OUTBOX_PGDATABASE",
  "ORKESTR_CONNECTOR_OUTBOX_PGUSER",
  "ORKESTR_CONNECTOR_OUTBOX_PGPASSWORD",
  "ORKESTR_THREAD_RESOURCE_POLICY_STORE",
  "ORKESTR_THREAD_RESOURCE_STORE",
  "ORKESTR_THREAD_RESOURCE_POLICY_POSTGRES_URL",
  "ORKESTR_THREAD_RESOURCE_POLICY_PGHOST",
  "ORKESTR_THREAD_RESOURCE_POLICY_PGPORT",
  "ORKESTR_THREAD_RESOURCE_POLICY_PGDATABASE",
  "ORKESTR_THREAD_RESOURCE_POLICY_PGUSER",
  "ORKESTR_THREAD_RESOURCE_POLICY_PGPASSWORD",
  "ORKESTR_BROKER_INSTANCE_STORE",
  "ORKESTR_BROKER_STORE",
  "DATABASE_URL",
  "PGHOST",
  "PGPORT",
  "PGDATABASE",
  "PGUSER",
  "PGPASSWORD",
  "ORKESTR_PUBLIC_APP_URL",
  "ORKESTR_PUBLIC_AUTH_URL",
  "ORKESTR_PUBLIC_URL",
  "ORKESTR_APP_URL",
  "ORKESTR_APP_HOST",
  "ORKESTR_PUBLIC_HTTPS_URL",
  "ORKESTR_HTTPS_URL",
  "ORKESTR_TAILSCALE_HTTPS_NAME",
  "ORKESTR_CONNECT_PUBLIC_URL",
  "WHATSAPP_BRIDGE_URL",
  "ORKESTR_WHATSAPP_BRIDGE_TOKEN",
  "WHATSAPP_BRIDGE_TOKEN",
  "ORKESTR_WHATSAPP_INBOUND_TOKEN",
  "WHATSAPP_INBOUND_TOKEN",
  "ORKESTR_MAILBOX_RELAY_TOKEN",
  "ORKESTR_MAILBOX_RELAY_TOKENS",
  "ORKESTR_WHATSAPP_ACCOUNT_CLIENT_IDS",
  "WHATSAPP_LOCAL_ACCOUNT_CLIENT_IDS",
  "ORKESTR_WHATSAPP_ACCOUNT_SESSION_ROOTS",
  "WHATSAPP_LOCAL_ACCOUNT_SESSION_ROOTS",
  "ORKESTR_WHATSAPP_DEFAULT_RESPONDER_ACCOUNT_ID",
  "WHATSAPP_LOCAL_DEFAULT_RESPONDER_ACCOUNT_ID",
  "GMAIL_OAUTH_CLIENT_ID",
  "GMAIL_OAUTH_CLIENT_SECRET",
  "GMAIL_OAUTH_REDIRECT_URI",
  "GOOGLE_OAUTH_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "GOOGLE_OAUTH_REDIRECT_URI",
  "ORKESTR_GOOGLE_OAUTH_APPS_JSON",
  "ORKESTR_GOOGLE_OAUTH_DEFAULT_APP",
  "ORKESTR_GOOGLE_OAUTH_ALLOWED_CAPABILITIES",
  "OUTLOOK_OAUTH_CLIENT_ID",
  "MICROSOFT_OAUTH_CLIENT_ID",
  "JIRA_OAUTH_CLIENT_ID",
  "JIRA_OAUTH_CLIENT_SECRET",
  "ATLASSIAN_OAUTH_CLIENT_ID",
  "ATLASSIAN_OAUTH_CLIENT_SECRET",
  "SHOPIFY_OAUTH_CLIENT_ID",
  "SHOPIFY_OAUTH_CLIENT_SECRET",
  "SHOPIFY_CLIENT_ID",
  "SHOPIFY_CLIENT_SECRET",
  "SHOPIFY_API_KEY",
  "SHOPIFY_API_SECRET",
  "ORKESTR_GMAIL_AUTH_DESKTOP_SLUG",
  "ORKESTR_GOOGLE_AUTH_DESKTOP_SLUG",
  "ORKESTR_GOOGLE_MARKETING_AUTH_DESKTOP_SLUG",
];

export function buildCiTestEnv(env = process.env) {
  const next = { ...env };
  for (const key of scrubbedCiEnvKeys) delete next[key];
  return {
    ...next,
    ORKESTR_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "orkestr-ci-home-")),
    ORKESTR_THREAD_STORE: "sqlite",
    ORKESTR_THREAD_MESSAGE_STORE: "sqlite",
    ORKESTR_CONNECTOR_OUTBOX_STORE: "sqlite",
    ORKESTR_THREAD_RESOURCE_POLICY_STORE: "sqlite",
    ORKESTR_BROKER_INSTANCE_STORE: "sqlite",
    ORKESTR_AUTH_REQUIRED: "0",
    ORKESTR_UNSAFE_ALLOW_PUBLIC_UNAUTHENTICATED: "1",
    ORKESTR_RECOVER_RUNNING_ON_START: "0",
    ORKESTR_AUTO_RUN_THREAD_INPUT: "0",
    ORKESTR_WHATSAPP_AUTOSTART: "0",
    WHATSAPP_LOCAL_AUTOSTART: "0",
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "",
    WHATSAPP_LOCAL_ACCOUNT_IDS: "",
    WHATSAPP_BRIDGE_MODE: "local",
    ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_ENABLED: "0",
    WHATSAPP_EXTERNAL_BRIDGE_ENABLED: "0",
    ORKESTR_WHATSAPP_DEBUG_FOOTER: "0",
    WA_DEBUG_FOOTER: "0",
    WA_APPEND_DEBUG_FOOTER: "0",
  };
}

export function discoverTestFiles(root = process.cwd()) {
  const testRoot = path.join(root, "test");
  const files = [];
  function walk(dir) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      else if (/\.test\.js$/u.test(entry.name)) files.push(path.relative(root, fullPath));
    }
  }
  walk(testRoot);
  return files.sort();
}

export function normalizeShard({ index = "1", total = "1", zeroBased = false } = {}) {
  const shardTotal = positiveInteger(total, 1);
  const rawIndex = clean(index || (zeroBased ? "0" : "1"));
  const parsedIndex = Number(rawIndex);
  if (!Number.isFinite(parsedIndex)) {
    throw new Error(`Invalid test shard index: ${rawIndex}`);
  }
  const inferredZeroBased = zeroBased || rawIndex === "0";
  const shardIndex = inferredZeroBased ? Math.floor(parsedIndex) : Math.floor(parsedIndex) - 1;
  if (shardIndex < 0 || shardIndex >= shardTotal) {
    throw new Error(`Invalid test shard index ${rawIndex} for total ${shardTotal}`);
  }
  return { index: shardIndex, total: shardTotal, displayIndex: shardIndex + 1 };
}

export function selectShardFiles(files = [], shard = { index: 0, total: 1 }) {
  if (!shard || shard.total <= 1) return [...files];
  return files.filter((_, index) => index % shard.total === shard.index);
}

export function parseCiTestRunnerArgs(argv = process.argv.slice(2), env = process.env) {
  const ciNodeIndex = clean(env.CI_NODE_INDEX);
  const explicitShardIndex = clean(env.ORKESTR_TEST_SHARD_INDEX);
  const shard = normalizeShard({
    index: flagValue(argv, "--shard-index", clean(explicitShardIndex || ciNodeIndex || "1")),
    total: flagValue(argv, "--shard-total", clean(env.ORKESTR_TEST_SHARD_TOTAL || env.CI_NODE_TOTAL || "1")),
    zeroBased: hasFlag(argv, "--shard-zero-based") ||
      truthy(env.ORKESTR_TEST_SHARD_ZERO_BASED) ||
      (!explicitShardIndex && Boolean(ciNodeIndex)),
  });
  return {
    plan: hasFlag(argv, "--plan"),
    root: path.resolve(flagValue(argv, "--root", process.cwd())),
    concurrency: positiveInteger(flagValue(argv, "--concurrency", clean(env.ORKESTR_TEST_CONCURRENCY || "1")), 1),
    forceExit: env.ORKESTR_TEST_FORCE_EXIT !== "0",
    shard,
  };
}

export function buildNodeTestArgs(options = {}, files = []) {
  const testArgs = [
    "--import",
    "./test/test-bootstrap.mjs",
    "--test",
    `--test-concurrency=${positiveInteger(options.concurrency, 1)}`,
  ];
  if (options.forceExit !== false) {
    // The full suite starts short-lived HTTP and runtime monitors in several
    // tests. On some hosts Node keeps an already-finished test process alive for
    // leaked handles, so the CI wrapper exits after the test runner completes.
    testArgs.push("--test-force-exit");
  }
  testArgs.push(...files);
  return testArgs;
}

function summaryStartIndex(lines, tail) {
  const tapPlanIndex = lines.findIndex((line) => /^1\.\.\d+/u.test(line));
  return Math.max(tapPlanIndex, lines.length - tail);
}

export async function runCiTests(options = parseCiTestRunnerArgs()) {
  const allFiles = discoverTestFiles(options.root);
  const files = selectShardFiles(allFiles, options.shard);
  const testArgs = buildNodeTestArgs(options, options.shard.total > 1 ? files : []);

  if (options.plan) {
    return {
      ok: true,
      root: options.root,
      shard: options.shard,
      concurrency: options.concurrency,
      totalFiles: allFiles.length,
      selectedFiles: files,
      nodeArgs: testArgs,
    };
  }

  if (options.shard.total > 1) {
    console.log(`Running test shard ${options.shard.displayIndex}/${options.shard.total}: ${files.length}/${allFiles.length} files`);
  }
  if (options.shard.total > 1 && files.length === 0) {
    console.log("No tests selected for this shard.");
    return { ok: true, code: 0 };
  }

  const child = spawn(process.execPath, testArgs, {
    cwd: options.root,
    env: buildCiTestEnv(process.env),
    stdio: ["ignore", "pipe", "pipe"],
  });

  const chunks = [];
  function collect(chunk) {
    chunks.push(Buffer.from(chunk));
  }

  child.stdout.on("data", collect);
  child.stderr.on("data", collect);

  const exitCode = await new Promise((resolve) => {
    child.on("close", resolve);
  });

  const output = Buffer.concat(chunks).toString("utf8");
  const lines = output.split(/\r?\n/);
  const failedIndices = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /^not ok \d+ - /u.test(line))
    .map(({ index }) => index);

  if (exitCode === 0) {
    console.log(lines.slice(summaryStartIndex(lines, 20)).join("\n").trimEnd());
    return { ok: true, code: 0 };
  }

  console.error("CI test run failed. Showing failing TAP blocks and summary.");

  if (failedIndices.length > 0) {
    const printed = new Set();
    for (const index of failedIndices) {
      const start = Math.max(0, index - 12);
      const end = Math.min(lines.length, index + 45);
      for (let i = start; i < end; i += 1) printed.add(i);
    }
    for (const index of [...printed].sort((a, b) => a - b)) {
      console.error(lines[index]);
    }
  } else {
    console.error("No explicit TAP failure block was found.");
  }

  console.error("\nTAP summary tail:");
  console.error(lines.slice(summaryStartIndex(lines, 80)).join("\n").trimEnd());

  return { ok: false, code: exitCode ?? 1 };
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  runCiTests(parseCiTestRunnerArgs())
    .then((result) => {
      if (result.selectedFiles) {
        console.log(JSON.stringify(result, null, 2));
      }
      if (!result.ok) process.exitCode = result.code || 1;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.stack || error.message : String(error));
      process.exitCode = 2;
    });
}
