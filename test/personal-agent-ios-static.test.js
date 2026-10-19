import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const root = new URL("../apps/ios/", import.meta.url);
const read = path => fs.readFile(new URL(path, root), "utf8");

test("native shell names each ADR 0003 mobile destination without product fixtures", async () => {
  const [assistant, projects, attention, library, detail] = await Promise.all([
    read("OrkestrApp/AssistantView.swift"),
    read("OrkestrApp/ProjectsListView.swift"),
    read("OrkestrApp/ApprovalsAttentionView.swift"),
    read("OrkestrApp/HistoryMemorySettingsView.swift"),
    read("OrkestrApp/AppRootView.swift"),
  ]);
  const readiness = await read("OrkestrApp/ServerReadinessView.swift");
  const rootView = await read("OrkestrApp/AppRootView.swift");
  for (const term of ["Global conversation", "Grounded briefing", "Active work", "Needs attention", "Recent results"])
    assert.ok(assistant.includes(term), `missing ${term}`);
  assert.match(assistant, /client\.acceptMessage/);
  assert.match(assistant, /pendingIdempotencyKey/);
  assert.match(assistant, /Replies are not yet available/);
  for (const term of ["Tasks", "Repository", "Data", "Runs", "Activity"])
    assert.ok(projects.includes(term) || detail.includes(term), `missing project panel ${term}`);
  for (const term of ["Approvals", "History", "Memory", "Settings"])
    assert.ok(attention.includes(term) || library.includes(term), `missing section ${term}`);
  for (const state of ["loading", "offline", "stale", "disabled", "storageUnavailable", "ready"])
    assert.ok(readiness.includes(`case .${state}`), `missing server state ${state}`);
  for (const source of [assistant, projects, attention, library]) {
    assert.match(source, /UnavailableNote/);
  }
  assert.match(rootView, /ServerReadinessView/);
  assert.match(rootView, /\.stale\(lastEnabledCapabilityAt\)/);
  assert.doesNotMatch(rootView, /result\.assistant\.available/);
  assert.match(assistant, /Session status unavailable; fast\/deep selection is not connected yet/);
});

test("typed client stays on ADR 0002 routes and has no private origin or embedded credential", async () => {
  const [client, models, memo] = await Promise.all([
    read("OrkestrMobileCore/Sources/OrkestrMobileCore/PersonalAgentAPIClient.swift"),
    read("OrkestrMobileCore/Sources/OrkestrMobileCore/PersonalAgentModels.swift"),
    fs.readFile(new URL("../docs/product/personal-agent-ios.md", import.meta.url), "utf8"),
  ]);
  for (const route of ["/api/personal-agent/capability", "/api/personal-agent/messages", "/api/personal-agent/projects", "/api/personal-agent/tasks/"])
    assert.ok(client.includes(route), `missing contract route ${route}`);
  for (const field of ["enabled", "capability", "assistant", "idempotencyKey", "conversationId", "messageId", "inboxItemId", "acceptanceCriteria", "evidenceRefs"])
    assert.ok((client + models).includes(field), `missing contract field ${field}`);
  assert.match(client, /authenticated transport/);
  assert.doesNotMatch(client, /https:\/\/|Bearer\s+[A-Za-z0-9._-]{12}/i);
  assert.match(memo, /Draft mobile threat model/);
  assert.match(await read("OrkestrApp/AppRootView.swift"), /apiClient\.capability\(\)/);
  const readiness = await read("OrkestrApp/ServerReadinessView.swift");
  assert.match(readiness, /var featureVisible/);
  assert.match(readiness, /case \.loading, \.offline, \.disabled:[\s\S]*?return false/);
  assert.match(readiness, /case \.storageUnavailable, \.ready, \.stale:[\s\S]*?return true/);
  assert.match(client, /scheme == "https" \|\| \(scheme == "http" && loopback\)/);
});

test("unsigned macOS build workflow follows read-only CI policy", async () => {
  const workflow = await fs.readFile(new URL("../.github/workflows/ios.yml", import.meta.url), "utf8");
  assert.match(workflow, /runs-on: macos-14/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /CODE_SIGNING_ALLOWED=NO/);
  assert.doesNotMatch(workflow, /secrets\.|self-hosted|appstore|testflight/i);
});

test("native palette mirrors the existing web design tokens", async () => {
  const [nativeTheme, webTheme] = await Promise.all([
    read("OrkestrApp/OrkestrTheme.swift"),
    fs.readFile(new URL("../apps/web/src/app-interface.css", import.meta.url), "utf8"),
  ]);
  for (const token of ["ui-canvas", "ui-surface", "ui-raised", "ui-border", "ui-text", "ui-muted", "ui-accent", "ui-focus"])
    assert.ok(webTheme.includes(`--${token}:`), `missing web token ${token}`);
  assert.match(nativeTheme, /mirror apps\/web\/src\/app-interface\.css design tokens/);
});

test("project resources and Integration Hub follow frozen read-only contract discovery", async () => {
  const [projects, library] = await Promise.all([
    read("OrkestrApp/ProjectsListView.swift"),
    read("OrkestrApp/HistoryMemorySettingsView.swift"),
  ]);
  const models = await read("OrkestrMobileCore/Sources/OrkestrMobileCore/PersonalAgentModels.swift");
  const capability = await read("OrkestrMobileCore/Sources/OrkestrMobileCore/PersonalAgentModels.swift");
  assert.match(capability, /projectResources: Bool\?/);
  assert.match(capability, /integrationHub: Bool\?/);
  assert.match(projects, /featureFlags\?\.projectResources == true/);
  assert.match(projects, /Project resource status not available yet/);
  assert.match(projects, /not connected to the read endpoint yet/);
  for (const value of ["local_git", "oxrm_workspace", "github_repo", "jira_project", "whatsapp_conversation", "desktop_pool", "plugin_resource"])
    assert.ok(models.includes(`= "${value}"`) || models.includes(`case ${value}`), `missing resource kind ${value}`);
  for (const value of ["pending", "provisioning", "needs_connection", "needs_approval", "ready", "failed"])
    assert.ok(new RegExp(`\\b${value}\\b`).test(models), `missing provisioning state ${value}`);
  for (const value of ["connection_missing", "approval_required", "local_service_unavailable", "reconcile_conflict", "unknown"])
    assert.ok(models.includes(`= "${value}"`) || models.includes(`case ${value}`), `missing blocker code ${value}`);
  for (const value of ["unknown", "healthy", "degraded", "unhealthy"])
    assert.ok(models.includes(value), `missing health state ${value}`);
  for (const dto of ["ResourceBinding", "PluginPackage", "Connection", "Capability", "InstanceBinding", "ProjectPluginBinding"])
    assert.ok(models.includes(`struct ${dto}`), `missing DTO ${dto}`);
  for (const layer of ["Plugin packages", "Connections", "Capabilities", "Global and project bindings", "Resource instances"])
    assert.ok(library.includes(layer), `missing Integration Hub layer ${layer}`);
  assert.match(library, /featureFlags\?\.integrationHub == true/);
  assert.match(library, /Integration Hub not available yet/);
  assert.match(library, /not connected to its read endpoints yet/);
  assert.match(library, /does not connect, enable, provision, or infer integrations/);
  assert.doesNotMatch(projects + library, /\/api\/personal-agent\/(?:resources|integrations|plugins)/);
});
