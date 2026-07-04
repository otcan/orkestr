import crypto from "node:crypto";
import fs from "node:fs/promises";
import { dataPaths } from "../../storage/src/paths.js";
import { appendEvent, readJson, writeJson } from "../../storage/src/store.js";

const defaultMaxResults = 20;
const maxDescriptionChars = 40_000;
const defaultSources = ["gmail", "freelance_de", "9am"];
let sqliteModulePromise = null;
const freelanceDeDbCache = new Map();

function nowIso() {
  return new Date().toISOString();
}

function clean(value = "") {
  return String(value || "").trim();
}

function lower(value = "") {
  return clean(value).toLowerCase();
}

function redactContactText(value = "") {
  return clean(value)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .replace(/(?:\+|00)\d[\d\s()./-]{6,}\d/g, "[redacted-phone]");
}

function uniqueClean(values = []) {
  const seen = new Set();
  const output = [];
  for (const value of values) {
    const text = clean(value);
    const comparable = lower(text);
    if (!text || seen.has(comparable)) continue;
    seen.add(comparable);
    output.push(text);
  }
  return output;
}

function normalizeId(value = "") {
  return clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function normalizeSource(value = "") {
  const text = lower(value).replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (["freelance", "freelancede", "freelance_de"].includes(text)) return "freelance_de";
  if (["9am", "nineam", "9_am"].includes(text)) return "9am";
  return text || "unknown";
}

function splitStringList(value = []) {
  const values = Array.isArray(value) ? value : String(value || "").split(/[\s,]+/g);
  const seen = new Set();
  const result = [];
  for (const item of values) {
    const text = clean(item);
    const comparable = lower(text);
    if (!text || seen.has(comparable)) continue;
    seen.add(comparable);
    result.push(text);
  }
  return result;
}

function splitScopeList(value = []) {
  return splitStringList(value).map((item) => lower(item));
}

function sha256(value = "") {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function randomToken() {
  return `ojd_${crypto.randomBytes(32).toString("base64url")}`;
}

function accessPath(env = process.env) {
  return dataPaths(env).jobsJdCacheAccess;
}

function queuePath(env = process.env) {
  return dataPaths(env).jobsQueue;
}

function freelanceDeDbPath(env = process.env) {
  return dataPaths(env).freelanceDeJobsDb;
}

function gmailSignalRecordsRoot(env = process.env) {
  return dataPaths(env).gmailSignalJobRecordsRoot;
}

function normalizeGrant(input = {}) {
  const id = normalizeId(input.id || input.tenantVmId || input.instanceId || input.sliceId || input.principalId);
  return {
    id,
    tenantVmId: normalizeId(input.tenantVmId || input.instanceId || input.sliceId || id),
    displayName: clean(input.displayName || input.name || id),
    ownerUserId: normalizeId(input.ownerUserId || input.userId || ""),
    tokenId: clean(input.tokenId || `jobs-jd-cache:${id}`),
    tokenHash: lower(input.tokenHash || input.hash),
    scopes: splitScopeList(input.scopes || ["jd:read", "jd:search"]),
    sources: splitStringList(input.sources || input.allowedSources || defaultSources).map(normalizeSource),
    maxResults: Math.max(1, Math.min(500, Number(input.maxResults || defaultMaxResults) || defaultMaxResults)),
    enabled: input.enabled !== false && input.disabled !== true,
    createdAt: clean(input.createdAt) || nowIso(),
    updatedAt: clean(input.updatedAt) || nowIso(),
    lastUsedAt: clean(input.lastUsedAt),
  };
}

function publicGrant(grant = {}) {
  const normalized = normalizeGrant(grant);
  return {
    id: normalized.id,
    tenantVmId: normalized.tenantVmId,
    displayName: normalized.displayName,
    ownerUserId: normalized.ownerUserId,
    tokenId: normalized.tokenId,
    scopes: normalized.scopes,
    sources: normalized.sources,
    maxResults: normalized.maxResults,
    enabled: normalized.enabled,
    createdAt: normalized.createdAt,
    updatedAt: normalized.updatedAt,
    lastUsedAt: normalized.lastUsedAt,
    tokenConfigured: Boolean(normalized.tokenHash),
  };
}

async function readAccessStore(env = process.env) {
  const payload = await readJson(accessPath(env), { schemaVersion: 1, grants: [] });
  return {
    schemaVersion: 1,
    grants: Array.isArray(payload?.grants) ? payload.grants.map(normalizeGrant).filter((grant) => grant.id && grant.tokenHash) : [],
    updatedAt: clean(payload?.updatedAt),
  };
}

async function writeAccessStore(store = {}, env = process.env) {
  const grants = Array.isArray(store.grants) ? store.grants.map(normalizeGrant).filter((grant) => grant.id && grant.tokenHash) : [];
  return writeJson(accessPath(env), {
    schemaVersion: 1,
    grants,
    updatedAt: nowIso(),
  });
}

export function hashJobsJdCacheToken(token = "") {
  return sha256(token);
}

export async function readJobsJdCacheAccessRecords(env = process.env) {
  return (await readAccessStore(env)).grants;
}

export async function listJobsJdCacheAccessGrants(env = process.env) {
  return (await readAccessStore(env)).grants.map(publicGrant);
}

export async function createJobsJdCacheAccessGrant(input = {}, env = process.env, options = {}) {
  const store = await readAccessStore(env);
  const token = clean(options.token || input.token) || randomToken();
  const id = normalizeId(input.id || input.tenantVmId || input.instanceId || input.sliceId);
  if (!id) throw Object.assign(new Error("jobs_jd_cache_grant_id_required"), { statusCode: 400 });
  const grant = normalizeGrant({
    ...input,
    id,
    tenantVmId: input.tenantVmId || input.instanceId || input.sliceId || id,
    tokenHash: hashJobsJdCacheToken(token),
    updatedAt: nowIso(),
  });
  const remaining = store.grants.filter((entry) => entry.id !== grant.id);
  await writeAccessStore({ grants: [...remaining, grant] }, env);
  await appendEvent({
    type: "jobs_jd_cache_access_grant_created",
    tenantVmId: grant.tenantVmId,
    grantId: grant.id,
    tokenId: grant.tokenId,
    scopes: grant.scopes,
    sources: grant.sources,
  }, env).catch(() => {});
  return {
    ok: true,
    token,
    grant: publicGrant(grant),
  };
}

function normalizeQueueCandidate(candidate = {}) {
  return {
    id: clean(candidate.id),
    ownerUserId: clean(candidate.ownerUserId || candidate.userId),
    subject: clean(candidate.subject),
    sender: clean(candidate.sender || candidate.from),
    receivedAt: clean(candidate.receivedAt || candidate.date),
    snippet: clean(candidate.snippet).slice(0, 1000),
    bodySnapshot: clean(candidate.bodySnapshot || candidate.text || candidate.body).slice(0, maxDescriptionChars),
    canonicalJobUrls: Array.isArray(candidate.canonicalJobUrls) ? candidate.canonicalJobUrls.map(clean).filter(Boolean).slice(0, 12) : [],
    extractedLinks: Array.isArray(candidate.extractedLinks) ? candidate.extractedLinks.map(clean).filter(Boolean).slice(0, 12) : [],
    gmailMessageId: clean(candidate.gmailMessageId || candidate.messageId),
    gmailThreadId: clean(candidate.gmailThreadId || candidate.threadId),
    gmailUrl: clean(candidate.gmailUrl),
    createdAt: clean(candidate.createdAt),
    updatedAt: clean(candidate.updatedAt),
  };
}

async function readQueueCandidates(env = process.env) {
  const payload = await readJson(queuePath(env), { candidates: [] });
  return Array.isArray(payload?.candidates)
    ? payload.candidates.map((candidate) => ({
      ...normalizeQueueCandidate(candidate),
      jdKind: "jobs-queue",
    })).filter((item) => item.id)
    : [];
}

async function loadSqlite() {
  try {
    sqliteModulePromise ||= import("node:sqlite");
    return await sqliteModulePromise;
  } catch {
    return null;
  }
}

async function openFreelanceDeDb(env = process.env) {
  const dbPath = freelanceDeDbPath(env);
  const exists = await fs.stat(dbPath).then((stat) => stat.isFile() && stat.size > 0, () => false);
  if (!exists) return null;
  const sqlite = await loadSqlite();
  if (!sqlite) return null;
  if (freelanceDeDbCache.has(dbPath)) return freelanceDeDbCache.get(dbPath);
  const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
  db.exec("pragma busy_timeout = 5000");
  freelanceDeDbCache.set(dbPath, db);
  return db;
}

function normalizeFreelanceDeRow(row = {}) {
  const description = redactContactText(row.description).slice(0, maxDescriptionChars);
  const fetchedAt = clean(row.fetched_at || row.updated_at || row.created_at);
  return {
    id: clean(row.project_id),
    jdKind: "freelance-de",
    source: "freelance_de",
    title: clean(row.title),
    sender: "freelance.de",
    receivedAt: fetchedAt,
    snippet: description.slice(0, 1000),
    bodySnapshot: description,
    canonicalJobUrls: [clean(row.url)].filter(Boolean),
    extractedLinks: [],
    createdAt: fetchedAt,
    updatedAt: fetchedAt,
  };
}

async function walkMarkdownFiles(dir, limit = 5000) {
  const output = [];
  async function walk(current) {
    if (output.length >= limit) return;
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (output.length >= limit) break;
      const fullPath = `${current}/${entry.name}`;
      if (entry.isDirectory()) await walk(fullPath);
      else if (entry.isFile() && entry.name.endsWith(".md")) output.push(fullPath);
    }
  }
  await walk(dir);
  return output;
}

function firstMarkdownHeading(raw = "") {
  const match = String(raw || "").match(/^#\s+(.+)$/m);
  return clean(match?.[1]);
}

function markdownField(raw = "", name = "") {
  const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(raw || "").match(new RegExp(`^${escaped}:\\s*(.*)$`, "mi"));
  return clean(match?.[1]);
}

function markdownSection(raw = "", heading = "") {
  const escaped = String(heading).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(raw || "").match(new RegExp(`^##\\s+${escaped}\\s*\\n([\\s\\S]*?)(?:\\n##\\s+|$)`, "mi"));
  return clean(match?.[1]);
}

function signalRecordSource(record = {}) {
  const text = lower([record.title, record.company, record.url, record.sourceKind].join("\n"));
  if (text.includes("9am")) return "9am";
  return "";
}

function isApplicationStatusSignal(record = {}) {
  const text = lower([record.stage, record.sourceKind, record.title, record.description].join("\n"));
  return /\b(application|bewerbung)\s+(sent|submitted|viewed|received|confirmed|status|gesendet|eingegangen|erhalten|angesehen|bestätigt|bestaetigt)\b/.test(text)
    || /\b(application|bewerbung)\s+(for|to)\b/.test(text)
    || /\b(applicant|candidate)\s+(applied|applies|submitted)\b/.test(text)
    || /\b(applied|submitted)\s+(for|to)\b/.test(text)
    || /\b(follow[-\s]?up|feedback)\b[\s\S]{0,120}\b(application|bewerbung|applied|submitted|received feedback)\b/.test(text)
    || /\b(application|bewerbung|applied|submitted)\b[\s\S]{0,120}\b(follow[-\s]?up|feedback)\b/.test(text)
    || /\byour application was sent\b/.test(text)
    || /\byour application (has been|was|is)\b/.test(text)
    || /\bapplication_status_update\b/.test(text);
}

function hasUsefulDescription(description = "") {
  const text = clean(description);
  const comparable = lower(text);
  return text.length >= 40
    && comparable !== "not found"
    && comparable !== "no description excerpt available.";
}

function normalizeGmailSignalRecord(raw = "", filePath = "", root = "") {
  const title = firstMarkdownHeading(raw);
  const stage = markdownField(raw, "Stage");
  const company = markdownField(raw, "Company");
  const url = markdownField(raw, "URL");
  const imported = markdownField(raw, "Imported");
  const sourceKind = markdownField(raw, "Source kind");
  const description = redactContactText(markdownSection(raw, "Description Excerpt")).slice(0, maxDescriptionChars);
  const relativePath = filePath.startsWith(root) ? filePath.slice(root.length).replace(/^\/+/, "") : filePath;
  const record = {
    stage,
    title,
    company,
    url,
    sourceKind,
    description,
  };
  const source = signalRecordSource(record);
  if (isApplicationStatusSignal(record)) return null;
  if (!source || !title || !hasUsefulDescription(description)) return null;
  return {
    id: sha256(relativePath).slice(0, 24),
    jdKind: "gmail-signal",
    source,
    title,
    sender: company || "Gmail Signals",
    receivedAt: imported,
    snippet: description.slice(0, 1000),
    bodySnapshot: description,
    canonicalJobUrls: clean(url) && lower(url) !== "not found" ? [clean(url)] : [],
    extractedLinks: [],
    createdAt: imported,
    updatedAt: imported,
  };
}

async function readGmailSignalCandidates(env = process.env) {
  const root = gmailSignalRecordsRoot(env);
  const exists = await fs.stat(root).then((stat) => stat.isDirectory(), () => false);
  if (!exists) return [];
  const files = await walkMarkdownFiles(root);
  const candidates = [];
  for (const filePath of files) {
    const raw = await fs.readFile(filePath, "utf8").catch(() => "");
    const candidate = normalizeGmailSignalRecord(raw, filePath, root);
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}

async function readFreelanceDeCandidates(env = process.env) {
  const db = await openFreelanceDeDb(env);
  if (!db) return [];
  try {
    const rows = db.prepare(`
      select project_id, url, title, description, fetched_at
      from freelance_jobs
      where coalesce(project_id, '') <> ''
      order by fetched_at desc, project_id desc
    `).all();
    return rows.map(normalizeFreelanceDeRow).filter((item) => item.id && (item.title || item.bodySnapshot));
  } catch {
    return [];
  }
}

async function readJdCandidates(env = process.env) {
  const [queueCandidates, freelanceDeCandidates, gmailSignalCandidates] = await Promise.all([
    readQueueCandidates(env),
    readFreelanceDeCandidates(env),
    readGmailSignalCandidates(env),
  ]);
  return [...queueCandidates, ...freelanceDeCandidates, ...gmailSignalCandidates];
}

function hostSource(url = "") {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    if (host.includes("freelance")) return "freelance_de";
    if (host.includes("9am")) return "9am";
    if (host.includes("gmail.google.com") || host.includes("mail.google.com")) return "gmail";
    return normalizeSource(host.split(".").slice(-2).join("."));
  } catch {
    return "";
  }
}

function sourceJobIdsFromText(value = "") {
  const text = clean(value);
  const ids = [];
  for (const match of text.matchAll(/app\.9am\.works\/job\/([a-z0-9-]+)/gi)) {
    ids.push(match[1]);
  }
  for (const match of text.matchAll(/linkedin\.com\/(?:comm\/)?jobs\/view\/(\d+)/gi)) {
    ids.push(match[1]);
  }
  for (const match of text.matchAll(/\bjobid[_=-]?(\d{5,})\b/gi)) {
    ids.push(match[1]);
  }
  for (const match of text.matchAll(/freelance\.de\/(?:projekte\/)?projekt[-/](\d+)/gi)) {
    ids.push(match[1]);
  }
  return uniqueClean(ids).slice(0, 50);
}

function sourceJobIdsForCandidate(candidate = {}) {
  const values = [
    candidate.id,
    candidate.subject,
    candidate.snippet,
    candidate.bodySnapshot,
    candidate.gmailUrl,
    ...(candidate.canonicalJobUrls || []),
    ...(candidate.extractedLinks || []),
  ].filter(Boolean);
  const ids = values.flatMap(sourceJobIdsFromText);
  if (candidate.jdKind === "freelance-de" && candidate.id) ids.push(candidate.id);
  return uniqueClean(ids).slice(0, 50);
}

function sourceForCandidate(candidate = {}) {
  if (candidate.source) return normalizeSource(candidate.source);
  const links = [
    candidate.gmailUrl,
    ...(candidate.canonicalJobUrls || []),
    ...(candidate.extractedLinks || []),
  ].filter(Boolean);
  for (const link of links) {
    const source = hostSource(link);
    if (source) return source;
  }
  if (candidate.gmailMessageId) return "gmail";
  const sender = lower(candidate.sender);
  if (sender.includes("freelance")) return "freelance_de";
  if (sender.includes("9am")) return "9am";
  return "unknown";
}

function titleForCandidate(candidate = {}) {
  if (clean(candidate.title)) return clean(candidate.title).slice(0, 240);
  return clean(candidate.subject).replace(/^(new job|job alert|hiring|role|opportunity)[:\s-]+/i, "").slice(0, 240) || "Untitled job description";
}

function jdIdForCandidate(candidate = {}) {
  const kind = clean(candidate.jdKind) || "jobs-queue";
  return `${kind}:${candidate.id}`;
}

function candidateRefFromJdId(jdId = "") {
  const value = clean(jdId);
  if (value.startsWith("jobs-queue:")) return { kind: "jobs-queue", id: value.slice("jobs-queue:".length) };
  if (value.startsWith("freelance-de:")) return { kind: "freelance-de", id: value.slice("freelance-de:".length) };
  if (value.startsWith("gmail-signal:")) return { kind: "gmail-signal", id: value.slice("gmail-signal:".length) };
  return { kind: "", id: value };
}

function sourceAllowed(source = "", grant = {}) {
  const allowed = Array.isArray(grant.sources) ? grant.sources.map(normalizeSource).filter(Boolean) : [];
  if (!allowed.length || allowed.includes("*")) return true;
  return allowed.includes(normalizeSource(source));
}

function limitFor(input = {}, grant = {}) {
  const requested = Number(input.limit || input.maxResults || defaultMaxResults);
  const grantMax = Number(grant.maxResults || defaultMaxResults);
  return Math.max(1, Math.min(500, Number.isFinite(requested) ? requested : defaultMaxResults, Number.isFinite(grantMax) ? grantMax : defaultMaxResults));
}

function searchableText(candidate = {}) {
  return lower([
    candidate.title,
    candidate.subject,
    candidate.sender,
    candidate.snippet,
    candidate.bodySnapshot,
    ...(candidate.canonicalJobUrls || []),
    ...(candidate.extractedLinks || []),
    ...sourceJobIdsForCandidate(candidate),
  ].join("\n"));
}

function publicJdSummary(candidate = {}) {
  const source = sourceForCandidate(candidate);
  const description = redactContactText(candidate.bodySnapshot || candidate.snippet);
  return {
    jdId: jdIdForCandidate(candidate),
    source,
    title: titleForCandidate(candidate),
    sender: candidate.sender || "",
    receivedAt: candidate.receivedAt || "",
    cachedAt: candidate.updatedAt || candidate.createdAt || "",
    snippet: redactContactText(candidate.snippet || description).slice(0, 700),
    sourceUrls: [...new Set([...(candidate.canonicalJobUrls || []), ...(candidate.extractedLinks || [])])].slice(0, 8),
    sourceJobIds: sourceJobIdsForCandidate(candidate).slice(0, 12),
    hasDescription: Boolean(description),
  };
}

function publicJdDetail(candidate = {}) {
  return {
    ...publicJdSummary(candidate),
    description: redactContactText(candidate.bodySnapshot || candidate.snippet),
    gmail: candidate.gmailMessageId
      ? {
          messageId: candidate.gmailMessageId,
          threadId: candidate.gmailThreadId || "",
        }
      : null,
  };
}

function mcpText(value) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function toolSchema(properties = {}, required = []) {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

export function jobsJdCacheMcpTools() {
  return [
    {
      name: "search_job_descriptions",
      description: "Search cached job descriptions exposed by the parent Jobs XRM. Returns sanitized summaries and stable jdId values only.",
      inputSchema: toolSchema({
        query: { type: "string", description: "Keyword query over title, source URLs, and cached job-description text." },
        sourceJobId: { type: "string", description: "Optional exact source job id from portals such as 9am UUIDs, LinkedIn numeric job ids, or freelance.de project ids." },
        source: { type: "string", description: "Optional source filter such as gmail, freelance_de, or 9am." },
        limit: { type: "number", minimum: 1, maximum: 100, description: "Maximum results." },
      }),
    },
    {
      name: "get_job_description",
      description: "Read one cached job description by jdId. Does not return fit scoring, application state, or personalized notes.",
      inputSchema: toolSchema({
        jdId: { type: "string", description: "Stable jdId returned by search_job_descriptions." },
      }, ["jdId"]),
    },
    {
      name: "list_job_sources",
      description: "List JD cache sources available to this slice grant.",
      inputSchema: toolSchema({}),
    },
  ];
}

function assertScope(grant = {}, accepted = []) {
  const scopes = splitScopeList(grant.scopes || []);
  if (scopes.includes("*") || scopes.includes("jd:*")) return true;
  if (accepted.some((scope) => scopes.includes(scope))) return true;
  throw Object.assign(new Error("jobs_jd_cache_scope_denied"), { statusCode: 403 });
}

export async function searchJobDescriptions(input = {}, grant = {}, env = process.env) {
  assertScope(grant, ["jd:read", "jd:search"]);
  const query = lower(input.query || "");
  const sourceJobId = lower(input.sourceJobId || input.externalJobId || input.jobId || "");
  const sourceFilter = clean(input.source) ? normalizeSource(input.source) : "";
  const limit = limitFor(input, grant);
  const candidates = await readJdCandidates(env);
  const results = [];
  for (const candidate of candidates) {
    const source = sourceForCandidate(candidate);
    if (!sourceAllowed(source, grant)) continue;
    if (sourceFilter && sourceFilter !== source) continue;
    if (sourceJobId) {
      const candidateJobIds = sourceJobIdsForCandidate(candidate).map(lower);
      if (!candidateJobIds.includes(sourceJobId)) continue;
    }
    if (query && !searchableText(candidate).includes(query)) continue;
    results.push(publicJdSummary(candidate));
    if (results.length >= limit) break;
  }
  await appendEvent({
    type: "jobs_jd_cache_mcp_search",
    tenantVmId: grant.tenantVmId || "",
    grantId: grant.id || "",
    queryPresent: Boolean(query),
    sourceJobIdPresent: Boolean(sourceJobId),
    source: sourceFilter || "",
    count: results.length,
  }, env).catch(() => {});
  return { ok: true, count: results.length, results };
}

export async function getJobDescription(input = {}, grant = {}, env = process.env) {
  assertScope(grant, ["jd:read"]);
  const ref = candidateRefFromJdId(input.jdId || input.id);
  if (!ref.id) throw Object.assign(new Error("jd_id_required"), { statusCode: 400 });
  const candidates = await readJdCandidates(env);
  const candidate = candidates.find((item) => item.id === ref.id && (!ref.kind || item.jdKind === ref.kind));
  if (!candidate) throw Object.assign(new Error("job_description_not_found"), { statusCode: 404 });
  const source = sourceForCandidate(candidate);
  if (!sourceAllowed(source, grant)) throw Object.assign(new Error("job_description_source_forbidden"), { statusCode: 403 });
  const description = publicJdDetail(candidate);
  await appendEvent({
    type: "jobs_jd_cache_mcp_get",
    tenantVmId: grant.tenantVmId || "",
    grantId: grant.id || "",
    jdId: jdIdForCandidate(candidate),
    source,
  }, env).catch(() => {});
  return { ok: true, jobDescription: description };
}

export async function listJobSources(_input = {}, grant = {}, env = process.env) {
  assertScope(grant, ["jd:read", "jd:search"]);
  const candidates = await readJdCandidates(env);
  const counts = {};
  for (const candidate of candidates) {
    const source = sourceForCandidate(candidate);
    if (!sourceAllowed(source, grant)) continue;
    counts[source] = (counts[source] || 0) + 1;
  }
  const sources = Object.entries(counts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([source, count]) => ({ source, count }));
  return { ok: true, sources };
}

function mcpError(id, error, fallbackCode = -32000) {
  const message = clean(error?.message || error || "mcp_error") || "mcp_error";
  const statusCode = Number(error?.statusCode || error?.status || 0) || 500;
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: {
      code: statusCode === 404 ? -32004 : statusCode === 403 ? -32003 : statusCode === 400 ? -32602 : fallbackCode,
      message,
    },
  };
}

async function callTool(name = "", args = {}, grant = {}, env = process.env) {
  if (name === "search_job_descriptions") return mcpText(await searchJobDescriptions(args, grant, env));
  if (name === "get_job_description") return mcpText(await getJobDescription(args, grant, env));
  if (name === "list_job_sources") return mcpText(await listJobSources(args, grant, env));
  throw Object.assign(new Error("mcp_tool_not_found"), { statusCode: 404 });
}

async function handleMcpMessage(message = {}, grant = {}, env = process.env) {
  const id = Object.prototype.hasOwnProperty.call(message, "id") ? message.id : null;
  const method = clean(message.method);
  const params = message.params && typeof message.params === "object" ? message.params : {};
  try {
    if (method === "initialize") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: {
            tools: {},
            resources: {},
          },
          serverInfo: {
            name: "jobs-jd-cache",
            version: "0.1.0",
          },
          instructions: "Read-only cached job descriptions. Do not use this server for fit scoring, notes, applications, or personalized decisions.",
        },
      };
    }
    if (method === "notifications/initialized") return null;
    if (method === "tools/list") {
      return { jsonrpc: "2.0", id, result: { tools: jobsJdCacheMcpTools() } };
    }
    if (method === "tools/call") {
      const result = await callTool(params.name, params.arguments || {}, grant, env);
      return { jsonrpc: "2.0", id, result };
    }
    if (method === "resources/list") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          resources: [
            {
              uri: "jobs-jd-cache://sources",
              name: "Allowed JD cache sources",
              mimeType: "application/json",
            },
          ],
        },
      };
    }
    if (method === "resources/read") {
      const uri = clean(params.uri);
      if (uri === "jobs-jd-cache://sources") {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            contents: [{ uri, mimeType: "application/json", text: JSON.stringify(await listJobSources({}, grant, env), null, 2) }],
          },
        };
      }
      const match = uri.match(/^jobs-jd-cache:\/\/descriptions\/(.+)$/);
      if (match) {
        const payload = await getJobDescription({ jdId: decodeURIComponent(match[1]) }, grant, env);
        return {
          jsonrpc: "2.0",
          id,
          result: {
            contents: [{ uri, mimeType: "application/json", text: JSON.stringify(payload, null, 2) }],
          },
        };
      }
      throw Object.assign(new Error("mcp_resource_not_found"), { statusCode: 404 });
    }
    throw Object.assign(new Error("mcp_method_not_found"), { statusCode: 404 });
  } catch (error) {
    return mcpError(id, error);
  }
}

export async function handleJobsJdCacheMcpRequest(body = {}, machineAuthContext = {}, env = process.env) {
  const grant = normalizeGrant(machineAuthContext?.grant || machineAuthContext || {});
  if (!grant.enabled) throw Object.assign(new Error("jobs_jd_cache_grant_disabled"), { statusCode: 403 });
  if (Array.isArray(body)) {
    const replies = [];
    for (const message of body) {
      const reply = await handleMcpMessage(message, grant, env);
      if (reply) replies.push(reply);
    }
    return replies;
  }
  return handleMcpMessage(body, grant, env);
}
