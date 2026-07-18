import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function appHome(env = process.env) {
  return path.resolve(env.ORKESTR_HOME || path.join(os.homedir(), ".orkestr"));
}

export function dataPaths(env = process.env) {
  const home = appHome(env);
  const codexOpsHome = env.OPENCLAW_CODEX_OPS_HOME || path.join(path.dirname(home), ".codex-ops");
  return {
    home,
    codexOpsHome,
    browsers: path.join(home, "browsers"),
    files: path.join(home, "files"),
    messages: path.join(home, "messages"),
    oauth: path.join(home, "oauth"),
    secrets: path.join(home, "secrets"),
    config: path.join(home, "config.json"),
    runtimeSettings: env.ORKESTR_RUNTIME_SETTINGS_FILE || path.join(home, "runtime-settings.json"),
    agents: path.join(home, "agents.json"),
    waitlist: path.join(home, "waitlist.json"),
    users: path.join(home, "users.json"),
    tenantVms: path.join(home, "tenant-vms.json"),
    tenantSlices: path.join(home, "tenant-slices.json"),
    userDataRoot: path.join(home, "users"),
    threads: path.join(home, "threads.json"),
    threadsDb: path.join(home, "threads.sqlite"),
    threadMessages: path.join(home, "thread-messages"),
    threadMessagesDb: path.join(home, "thread-messages.sqlite"),
    runtimeLeases: path.join(home, "runtime-leases.json"),
    desktopLeases: env.ORKESTR_DESKTOP_LEASE_FILE || path.join(home, "desktop-leases.json"),
    workspaces: path.join(home, "workspaces"),
    timers: path.join(home, "timers.json"),
    jobsQueue: env.ORKESTR_JOBS_QUEUE_FILE || path.join(home, "jobs-queue.json"),
    jobsJdCacheAccess: env.ORKESTR_JOBS_JD_CACHE_ACCESS_FILE || path.join(home, "jobs-jd-cache-access.json"),
    freelanceDeJobsDb: env.ORKESTR_FREELANCE_DE_JOBS_DB || path.join(codexOpsHome, "data", "freelance-de", "freelance_jobs.db"),
    gmailSignalJobRecordsRoot: env.ORKESTR_GMAIL_SIGNAL_RECORD_ROOT || path.join(path.dirname(home), ".openclaw", "workspace", "Orkestr", ".data", "workspaces", "157ea1bfc66836fd", "oxrm", "jobseeker-can", "files", "records", "job-search", "gmail"),
    connectorOutbox: path.join(home, "connector-outbox.json"),
    connectorOutboxDb: env.ORKESTR_CONNECTOR_OUTBOX_DB || path.join(home, "connector-outbox.sqlite"),
    connectorPromptPushes: path.join(home, "connector-prompt-pushes.json"),
    apiSessionBindings: path.join(home, "api-session-bindings.json"),
    routerTraces: path.join(home, "router-traces.json"),
    watcherAlerts: path.join(home, "watcher-alerts.json"),
    brokerInstances: env.ORKESTR_BROKER_INSTANCES_FILE || path.join(home, "broker-instances.json"),
    brokerInstancesDb: env.ORKESTR_BROKER_INSTANCES_DB || path.join(home, "broker-instances.sqlite"),
    brokerChannel: env.ORKESTR_BROKER_CHANNEL_FILE || path.join(home, "secrets", "broker-channel.json"),
    brokerClientIdentity: env.ORKESTR_BROKER_CLIENT_IDENTITY_FILE || path.join(home, "secrets", "broker-client-identity.json"),
    brokerClientRegistration: env.ORKESTR_BROKER_CLIENT_REGISTRATION_FILE || path.join(home, "secrets", "broker-client-registration.json"),
    releaseInstances: env.ORKESTR_RELEASE_INSTANCES_FILE || path.join(home, "release-instances.json"),
    releaseWhatsAppNotifications: path.join(home, "release-whatsapp-notifications.json"),
    events: path.join(home, "events.jsonl"),
    whatsapp: path.join(home, "whatsapp.json"),
  };
}

export function userDataPaths(userId, env = process.env) {
  const home = appHome(env);
  const safeUserId = String(userId || "admin").replace(/[^a-zA-Z0-9_.-]/g, "_") || "admin";
  const root = path.join(home, "users", safeUserId);
  return {
    root,
    files: path.join(root, "files"),
    workspaces: path.join(root, "workspaces"),
    browsers: path.join(root, "browsers"),
    oauth: path.join(root, "oauth"),
    secrets: path.join(root, "secrets"),
    identities: path.join(root, "identities.json"),
    skills: path.join(root, "skills.json"),
    onboarding: path.join(root, "onboarding.json"),
    timers: path.join(root, "timers.json"),
  };
}

export async function ensureDataDirs(env = process.env) {
  const paths = dataPaths(env);
  await fs.mkdir(paths.home, { recursive: true });
  await fs.mkdir(paths.userDataRoot, { recursive: true });
  await fs.mkdir(paths.browsers, { recursive: true });
  await fs.mkdir(paths.files, { recursive: true });
  await fs.mkdir(paths.messages, { recursive: true });
  await fs.mkdir(paths.threadMessages, { recursive: true });
  await fs.mkdir(paths.workspaces, { recursive: true });
  await fs.mkdir(paths.oauth, { recursive: true });
  await fs.mkdir(paths.secrets, { recursive: true, mode: 0o700 });
  return paths;
}
