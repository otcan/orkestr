import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCli } from "../apps/cli/src/commands.js";
import { writeRuntimeSettings } from "../packages/core/src/runtime-settings.js";
import { resolveSkillDesktopTarget } from "../packages/core/src/skill-desktop-resolver.js";
import { createAppShare, sharedAppData } from "../packages/core/src/shared-apps.js";
import { adminPrincipal, userPrincipal } from "../packages/core/src/principal.js";

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

test("skill desktop resolver fails closed for ambiguous omitted targets", async () => {
  const env = await fixture("orkestr-skill-desktop-ambiguous-");
  const result = await resolveSkillDesktopTarget({
    desktops: [
      { slug: "desk-a", status: "active", availableActions: ["open"] },
      { slug: "desk-b", status: "active", availableActions: ["open"] },
    ],
    principal: userPrincipal({ id: "alice" }),
    env,
    action: "desktop.operate",
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "instance_selection_required");
  assert.equal(result.targetSelection.ambiguityResult, "multiple_match");
  assert.equal(result.candidates.length, 2);
});

test("skill desktop resolver infers exactly one target with provenance", async () => {
  const env = await fixture("orkestr-skill-desktop-single-");
  const result = await resolveSkillDesktopTarget({
    desktops: [{ slug: "solo-desk", status: "active", availableActions: ["open"] }],
    principal: userPrincipal({ id: "alice" }),
    env,
    action: "desktop.operate",
  });

  assert.equal(result.ok, true);
  assert.equal(result.slug, "solo-desk");
  assert.equal(result.targetSelection.selectionSource, "single_authorized_target");
  assert.equal(result.targetSelection.ambiguityResult, "single_match");
});

test("skill desktop resolver rejects stale explicit targets without fallback", async () => {
  const env = await fixture("orkestr-skill-desktop-stale-");
  const result = await resolveSkillDesktopTarget({
    args: { target: "desk-a" },
    desktops: [
      { slug: "desk-a", status: "inactive", availableActions: ["status"] },
      { slug: "desk-b", status: "active", availableActions: ["open"] },
    ],
    principal: userPrincipal({ id: "alice" }),
    env,
    action: "desktop.operate",
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "target_stale");
  assert.equal(result.targetSelection.selectionSource, "explicit_request");
  assert.equal(result.targetSelection.selectedInstanceId, "");
});

test("skill desktop resolver rejects generic defaults for desktop-specific skills", async () => {
  const env = await fixture("orkestr-skill-desktop-configured-");
  env.ORKESTR_DEFAULT_DESKTOP_SLUG = "desktop";
  const result = await resolveSkillDesktopTarget({
    skill: { id: "linkedin", requiresDesktop: "linkedin" },
    desktops: [{ slug: "desktop", status: "active", availableActions: ["open"] }],
    principal: userPrincipal({ id: "alice" }),
    env,
    action: "skill.linkedin.open",
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "instance_selection_required");
  assert.equal(result.targetSelection.selectedInstanceId, "");
});

test("skill desktop resolver uses skill-specific configured mapping with provenance", async () => {
  const env = await fixture("orkestr-skill-desktop-specific-");
  env.ORKESTR_DEFAULT_DESKTOP_SLUG = "desktop";
  env.ORKESTR_LINKEDIN_DESKTOP_SLUG = "linkedin-browser";
  const result = await resolveSkillDesktopTarget({
    skill: { id: "linkedin", requiresDesktop: "linkedin" },
    desktops: [
      { slug: "desktop", status: "active", availableActions: ["open"], connector: "desktop" },
      { slug: "linkedin-browser", status: "active", availableActions: ["open"], connector: "linkedin" },
    ],
    principal: userPrincipal({ id: "alice" }),
    env,
    action: "skill.linkedin.open",
  });

  assert.equal(result.ok, true);
  assert.equal(result.slug, "linkedin-browser");
  assert.equal(result.targetSelection.selectionSource, "skill_configured_desktop");
  assert.equal(result.targetSelection.selectedInstanceId, "linkedin-browser");
});

test("skill desktop resolver allows one semantic desktop candidate for required skills", async () => {
  const env = await fixture("orkestr-skill-desktop-semantic-");
  const result = await resolveSkillDesktopTarget({
    skill: { id: "linkedin", requiresDesktop: "linkedin" },
    desktops: [
      { slug: "desktop", status: "active", availableActions: ["open"], connector: "desktop" },
      { slug: "linkedin-dana", status: "active", availableActions: ["open"], connector: "linkedin" },
    ],
    principal: userPrincipal({ id: "alice" }),
    env,
    action: "skill.linkedin.open",
  });

  assert.equal(result.ok, true);
  assert.equal(result.slug, "linkedin-dana");
  assert.equal(result.targetSelection.selectionSource, "single_semantic_target");
  assert.equal(result.targetSelection.selectedInstanceId, "linkedin-dana");
});
