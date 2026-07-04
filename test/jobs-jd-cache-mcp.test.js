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

test("jobs JD cache MCP exposes read/search only to granted slices", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-jobs-jd-cache-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_AUTH_REQUIRED: "1",
    ORKESTR_HOST: "0.0.0.0",
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
