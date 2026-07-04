import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { authorizeHttpRequest } from "../packages/core/src/security.js";
import {
  createJobsJdCacheAccessGrant,
  handleJobsJdCacheMcpRequest,
  listJobSources,
  searchJobDescriptions,
} from "../packages/core/src/jobs-jd-cache-mcp.js";
import { dataPaths } from "../packages/storage/src/paths.js";
import { writeJson } from "../packages/storage/src/store.js";

let sqliteModulePromise = null;

function parseMcpText(result) {
  const text = result?.result?.content?.[0]?.text || result?.content?.[0]?.text || "";
  return JSON.parse(text);
}

function authRequest(token = "") {
  return {
    method: "POST",
    originalUrl: "/api/jobs/jd-cache/mcp",
    url: "/api/jobs/jd-cache/mcp",
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ip: "10.0.0.2",
    socket: { remoteAddress: "10.0.0.2" },
  };
}

async function createFreelanceDeFixture(dbPath) {
  try {
    sqliteModulePromise ||= import("node:sqlite");
    const sqlite = await sqliteModulePromise;
    const db = new sqlite.DatabaseSync(dbPath);
    db.exec(`
      create table freelance_jobs (
        project_id text primary key,
        url text not null,
        title text,
        description text,
        emails_json text,
        phones_json text,
        contact_lines_json text,
        kontaktdaten_clicked integer not null default 0,
        auth_source text,
        login_url text,
        ajax_status integer,
        session_file text,
        raw_json_path text,
        raw_html_path text,
        fetched_at text not null
      );
    `);
    db.prepare(`
      insert into freelance_jobs (
        project_id, url, title, description, emails_json, phones_json, contact_lines_json, fetched_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "1278840",
      "https://www.freelance.de/projekte/projekt-1278840-Java-Full-Stack-Entwickler",
      "Java Full Stack Entwickler mit Spring Boot und React Erfahrung (m/w/d)",
      "Backend Java, Spring Boot and React project. Contact person must stay private.",
      JSON.stringify(["private@example.com"]),
      JSON.stringify(["+49 111"]),
      JSON.stringify(["Private Contact Name"]),
      "2026-07-02T18:06:43Z",
    );
    db.close();
    return true;
  } catch {
    return false;
  }
}

test("jobs JD cache MCP exposes read/search only to granted slices", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-jobs-jd-cache-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_AUTH_REQUIRED: "1",
    ORKESTR_HOST: "0.0.0.0",
    ORKESTR_FREELANCE_DE_JOBS_DB: path.join(home, "missing-freelance.db"),
    ORKESTR_GMAIL_SIGNAL_RECORD_ROOT: path.join(home, "missing-gmail-signals"),
  };
  await writeJson(dataPaths(env).jobsQueue, {
    schemaVersion: 1,
    candidates: [
      {
        id: "job_freelance_1",
        ownerUserId: "admin",
        state: "presented",
        subject: "Angular Java contract via freelance.de",
        sender: "alerts@freelance.de",
        receivedAt: "2026-07-04T09:00:00Z",
        snippet: "Angular Java NRW contract",
        bodySnapshot: "Client needs Angular, Java, Spring Boot, NRW hybrid. Contact details are in source portal.",
        canonicalJobUrls: ["https://www.freelance.de/Projekt/angular-java-nrw?utm_source=mail"],
        fit: {
          fitScore: 9,
          whyFit: "Personalized fit note must not leak",
          risks: "Personalized risk must not leak",
        },
        createdAt: "2026-07-04T09:00:00Z",
        updatedAt: "2026-07-04T09:30:00Z",
      },
      {
        id: "job_gmail_1",
        ownerUserId: "admin",
        subject: "Warehouse shift",
        sender: "jobs@example.com",
        bodySnapshot: "Warehouse onsite role",
        gmailMessageId: "gmail-1",
      },
    ],
  });
  const grant = await createJobsJdCacheAccessGrant({
    id: "firat-jobs-vm",
    tenantVmId: "firat-jobs-vm",
    ownerUserId: "firat",
    displayName: "Firat Jobs slice",
    scopes: ["jd:read", "jd:search"],
    sources: ["freelance_de"],
    maxResults: 5,
  }, env, { token: "firat-test-token" });
  const accessFile = await fs.readFile(dataPaths(env).jobsJdCacheAccess, "utf8");

  assert.equal(accessFile.includes("firat-test-token"), false);
  assert.equal(grant.grant.tokenConfigured, true);

  const unauth = await authorizeHttpRequest(authRequest(), env);
  assert.equal(unauth.ok, false);
  assert.equal(unauth.error, "jobs_jd_cache_token_required");

  const auth = await authorizeHttpRequest(authRequest("firat-test-token"), env);
  assert.equal(auth.ok, true);
  assert.equal(auth.machineAuth, "jobs_jd_cache");
  assert.equal(auth.machineAuthContext.grant.tenantVmId, "firat-jobs-vm");

  const tools = await handleJobsJdCacheMcpRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
  }, auth.machineAuthContext, env);
  assert.deepEqual(
    tools.result.tools.map((tool) => tool.name),
    ["search_job_descriptions", "get_job_description", "list_job_sources"],
  );

  const search = await handleJobsJdCacheMcpRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "search_job_descriptions",
      arguments: { query: "Angular", limit: 20 },
    },
  }, auth.machineAuthContext, env);
  const searchPayload = parseMcpText(search);
  assert.equal(searchPayload.count, 1);
  assert.equal(searchPayload.results[0].jdId, "jobs-queue:job_freelance_1");
  assert.equal(searchPayload.results[0].source, "freelance_de");
  assert.equal(searchPayload.results[0].fit, undefined);

  const detail = await handleJobsJdCacheMcpRequest({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "get_job_description",
      arguments: { jdId: searchPayload.results[0].jdId },
    },
  }, auth.machineAuthContext, env);
  const detailPayload = parseMcpText(detail);
  assert.match(detailPayload.jobDescription.description, /Angular, Java/);
  assert.equal(JSON.stringify(detailPayload).includes("Personalized fit note"), false);
  assert.equal(JSON.stringify(detailPayload).includes("fitScore"), false);

  const sources = await listJobSources({}, auth.machineAuthContext.grant, env);
  assert.deepEqual(sources.sources, [{ source: "freelance_de", count: 1 }]);

  const directSearch = await searchJobDescriptions({ query: "Warehouse" }, auth.machineAuthContext.grant, env);
  assert.equal(directSearch.count, 0);
});

test("jobs JD cache MCP includes sanitized freelance.de SQLite cache rows", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-jobs-jd-cache-freelance-"));
  const freelanceDb = path.join(home, "freelance_jobs.db");
  if (!await createFreelanceDeFixture(freelanceDb)) {
    t.skip("node:sqlite unavailable");
    return;
  }
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_AUTH_REQUIRED: "1",
    ORKESTR_HOST: "0.0.0.0",
    ORKESTR_FREELANCE_DE_JOBS_DB: freelanceDb,
    ORKESTR_GMAIL_SIGNAL_RECORD_ROOT: path.join(home, "missing-gmail-signals"),
  };
  await writeJson(dataPaths(env).jobsQueue, { schemaVersion: 1, candidates: [] });
  const grant = await createJobsJdCacheAccessGrant({
    id: "firat-jobs-vm",
    tenantVmId: "firat-jobs-vm",
    ownerUserId: "firat",
    scopes: ["jd:read", "jd:search"],
    sources: ["freelance_de"],
  }, env, { token: "firat-test-token" });

  const sources = await listJobSources({}, grant.grant, env);
  assert.deepEqual(sources.sources, [{ source: "freelance_de", count: 1 }]);

  const search = await searchJobDescriptions({ query: "Spring Boot", limit: 5 }, grant.grant, env);
  assert.equal(search.count, 1);
  assert.equal(search.results[0].jdId, "freelance-de:1278840");
  assert.equal(search.results[0].source, "freelance_de");
  assert.equal(search.results[0].sender, "freelance.de");

  const detail = await handleJobsJdCacheMcpRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "get_job_description",
      arguments: { jdId: "freelance-de:1278840" },
    },
  }, { grant: grant.grant }, env);
  const payload = parseMcpText(detail);
  assert.match(payload.jobDescription.description, /Spring Boot/);
  assert.equal(JSON.stringify(payload).includes("private@example.com"), false);
  assert.equal(JSON.stringify(payload).includes("+49 111"), false);
  assert.equal(JSON.stringify(payload).includes("Private Contact Name"), false);
});

test("jobs JD cache MCP includes neutral 9am Gmail signal records without fit evidence", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-jobs-jd-cache-9am-"));
  const recordRoot = path.join(home, "gmail-signals");
  await fs.mkdir(path.join(recordRoot, "2026-07-04"), { recursive: true });
  await fs.writeFile(path.join(recordRoot, "2026-07-04", "java-9am.md"), [
    "# Java Developer",
    "",
    "Stage: candidate",
    "Source: Gmail job signal",
    "Source kind: single_job_alert",
    "Imported: 2026-07-04T09:00:00Z",
    "Company: 9am Match",
    "Location: Remote",
    "URL: https://app.9am.works/job/java-123",
    "Initial fit: 92/100",
    "Selected CV: private-cv.md",
    "",
    "## Fit Evidence",
    "",
    "- Rationale: private personalized scoring should not leak",
    "- CV evidence: private evidence",
    "",
    "## Description Excerpt",
    "",
    "Java backend project with Spring Boot and remote delivery. Contact jane@example.com or +49 111 222333.",
    "",
  ].join("\n"), "utf8");
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_AUTH_REQUIRED: "1",
    ORKESTR_HOST: "0.0.0.0",
    ORKESTR_FREELANCE_DE_JOBS_DB: path.join(home, "missing-freelance.db"),
    ORKESTR_GMAIL_SIGNAL_RECORD_ROOT: recordRoot,
  };
  await writeJson(dataPaths(env).jobsQueue, { schemaVersion: 1, candidates: [] });
  const grant = await createJobsJdCacheAccessGrant({
    id: "firat-jobs-vm",
    tenantVmId: "firat-jobs-vm",
    ownerUserId: "firat",
    scopes: ["jd:read", "jd:search"],
    sources: ["9am"],
  }, env, { token: "firat-test-token" });

  const sources = await listJobSources({}, grant.grant, env);
  assert.deepEqual(sources.sources, [{ source: "9am", count: 1 }]);

  const search = await searchJobDescriptions({ query: "Spring Boot" }, grant.grant, env);
  assert.equal(search.count, 1);
  assert.equal(search.results[0].source, "9am");
  assert.match(search.results[0].jdId, /^gmail-signal:/);

  const detail = await handleJobsJdCacheMcpRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "get_job_description",
      arguments: { jdId: search.results[0].jdId },
    },
  }, { grant: grant.grant }, env);
  const payload = parseMcpText(detail);
  assert.match(payload.jobDescription.description, /Java backend project/);
  assert.equal(JSON.stringify(payload).includes("jane@example.com"), false);
  assert.equal(JSON.stringify(payload).includes("+49 111 222333"), false);
  assert.equal(JSON.stringify(payload).includes("Initial fit"), false);
  assert.equal(JSON.stringify(payload).includes("private personalized scoring"), false);
  assert.equal(JSON.stringify(payload).includes("private-cv.md"), false);
});
