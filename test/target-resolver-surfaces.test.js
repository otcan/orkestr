import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCli } from "../apps/cli/src/commands.js";
import { writeRuntimeSettings } from "../packages/core/src/runtime-settings.js";
import { createAppShare, sharedAppData } from "../packages/core/src/shared-apps.js";
import { adminPrincipal } from "../packages/core/src/principal.js";

async function fixture(prefix = "orkestr-target-surfaces-") {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return { ORKESTR_HOME: home };
}

test("desktop CLI share fails closed when omitted desktop is ambiguous", async () => {
  const env = await fixture("orkestr-desktop-strict-");
  await writeRuntimeSettings({ desktops: { manualIntervention: "linkedin", default: "pa" } }, env);
  const calls = [];
  let stderr = "";

  const code = await runCli(["--api", "http://orkestr.test", "desktop", "share"], {
    env,
    stdout: { write: () => {} },
    stderr: { write: (chunk) => { stderr += chunk; } },
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      const parsed = new URL(String(url));
      if (parsed.pathname === "/api/whereiam") {
        return new Response(JSON.stringify({ thread: { id: "thread-one", displayName: "Thread One" } }), { headers: { "content-type": "application/json" } });
      }
      if (parsed.pathname === "/api/browser-sessions") {
        return new Response(JSON.stringify({
          ok: true,
          sessions: [{ slug: "linkedin" }, { slug: "pa" }],
        }), { headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected ${parsed.pathname}`);
    },
  });

  assert.equal(code, 1);
  assert.match(stderr, /desktop_selection_required/);
  assert.equal(calls.some((call) => call.url.includes("/api/desktops/")), false);
});

test("XRM-backed shared apps reject ambiguous omitted backing instance", async () => {
  const env = await fixture("orkestr-xrm-ambiguous-");
  env.ORKESTR_SHARED_APPS_XRM_REVIEW_API_BASE_URLS_JSON = JSON.stringify({
    "xrm-a": "http://xrm-a.example.test",
    "xrm-b": "http://xrm-b.example.test",
  });
  const principal = adminPrincipal({ id: "admin" });
  const created = await createAppShare("main", "outreach-review", {
    shareToken: "share-one",
    filtersJson: { backingSystem: "xrm", queueKey: "leads" },
  }, { principal, env });

  await assert.rejects(
    () => sharedAppData("main", "outreach-review", "share-one", {
      env,
      session: { id: "session-one", instanceId: "main", appSlug: "outreach-review", shareId: created.share.id },
    }),
    /instance_selection_required/,
  );
});

test("XRM-backed shared apps use explicit backing instance and return target provenance", async () => {
  const env = await fixture("orkestr-xrm-explicit-");
  env.ORKESTR_SHARED_APPS_XRM_REVIEW_API_BASE_URLS_JSON = JSON.stringify({
    "xrm-a": "http://xrm-a.example.test",
    "xrm-b": "http://xrm-b.example.test",
  });
  const principal = adminPrincipal({ id: "admin" });
  const created = await createAppShare("main", "outreach-review", {
    shareToken: "share-one",
    filtersJson: { backingSystem: "xrm", xrmInstanceId: "xrm-b", queueKey: "leads" },
  }, { principal, env });
  const priorFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ items: [{ id: "lead-one", name: "Lead One" }], total: 1 }), {
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const payload = await sharedAppData("main", "outreach-review", "share-one", {
      env,
      session: { id: "session-one", instanceId: "main", appSlug: "outreach-review", shareId: created.share.id },
    });
    assert.equal(urls[0].startsWith("http://xrm-b.example.test/"), true);
    assert.equal(payload.data.liveSource.targetSelection.selectedInstanceId, "xrm-b");
    assert.equal(payload.data.liveSource.targetSelection.selectionSource, "explicit_request");
    assert.equal(payload.data.people[0].id, "lead-one");
  } finally {
    globalThis.fetch = priorFetch;
  }
});
