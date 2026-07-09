import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getSetupStatus } from "../packages/core/src/setup.js";
import { classifyApprovalReply, readRuntimeSettings, writeRuntimeSettings } from "../packages/core/src/runtime-settings.js";
import { publicConfig, writeConnectorConfig } from "../packages/storage/src/config.js";

test("connector config is persisted and redacts OpenAI secrets", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-config-"));
  const env = { ORKESTR_HOME: home };
  await writeConnectorConfig("openai", { openaiApiKey: "sk-test-secret-value" }, env);

  const config = await publicConfig(env);
  assert.equal(config.openai.openaiApiKey, "sk-t...alue");

  const status = await getSetupStatus({ env, home });
  const openai = status.connectors.find((connector) => connector.id === "openai");
  assert.equal(openai.state, "connected");
});

test("gmail client secrets are stored outside public config", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-gmail-secret-"));
  const env = { ORKESTR_HOME: home };
  await writeConnectorConfig("gmail", { clientId: "client-id", clientSecret: "super-secret", redirectUri: "http://localhost/callback" }, env);

  const publicRaw = JSON.parse(await fs.readFile(path.join(home, "config.json"), "utf8"));
  const secretRaw = JSON.parse(await fs.readFile(path.join(home, "secrets", "gmail.json"), "utf8"));
  const config = await publicConfig(env);

  assert.equal(publicRaw.gmail.clientSecret, undefined);
  assert.equal(secretRaw.clientSecret, "super-secret");
  assert.equal(config.gmail.clientSecret, "supe...cret");
});

test("runtime settings persist non-secret Codex, desktop, and connector routing", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-runtime-settings-"));
  const env = { ORKESTR_HOME: home };

  await writeRuntimeSettings({
    codex: {
      sandbox: "workspace-write",
      approvalPolicy: "on-request",
    },
    desktops: {
      default: "desktop",
      gmailAuth: "gmail",
      manualIntervention: "desktop",
    },
    connectors: {
      gmail: {
        enabled: true,
        authDesktop: "gmail",
      },
      outlook: {
        enabled: true,
      },
    },
  }, env);

  const settings = await readRuntimeSettings(env);
  const raw = JSON.parse(await fs.readFile(path.join(home, "runtime-settings.json"), "utf8"));

  assert.equal(settings.profile, undefined);
  assert.equal(settings.codex.approvalPolicy, "on-request");
  assert.equal(settings.codex.permissionPrompts.mirrorToWhatsApp, true);
  assert.equal(settings.desktops.gmailAuth, "gmail");
  assert.equal(settings.connectors.gmail.authDesktop, "gmail");
  assert.equal(settings.connectors.whatsapp.accessMode, "relay");
  assert.equal(raw.codex.clientSecret, undefined);
  assert.equal(raw.connectors.gmail.clientSecret, undefined);
});

test("runtime settings include configured managed desktop catalog", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-runtime-desktop-catalog-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_BROWSER_VISIBLE_SLUGS: "desktop",
    ORKESTR_DESKTOP_CATALOG_JSON: JSON.stringify([
      {
        slug: "desktop",
        label: "Firat Jobs StepStone",
        purpose: "Logged-in browser for Firat job applications.",
        cdpUrl: "http://127.0.0.1:9222",
        workspacePath: "/opt/orkestr/workspace/firat-jobs",
      },
    ]),
  };

  const settings = await readRuntimeSettings(env);

  assert.equal(settings.desktops.items.length, 1);
  assert.equal(settings.desktops.items[0].slug, "desktop");
  assert.equal(settings.desktops.items[0].label, "Firat Jobs StepStone");
  assert.equal(settings.desktops.items[0].cdpUrl, "http://127.0.0.1:9222/");
  assert.equal(settings.desktops.items[0].workspacePath, "/opt/orkestr/workspace/firat-jobs");
});

test("legacy runtime profiles still map to Codex safety settings", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-runtime-legacy-profile-"));
  const env = { ORKESTR_HOME: home, ORKESTR_INSTALL_PROFILE: "local-trusted" };

  const settings = await readRuntimeSettings(env);

  assert.equal(settings.profile, undefined);
  assert.equal(settings.codex.sandbox, "danger-full-access");
  assert.equal(settings.codex.approvalPolicy, "never");
  assert.equal(settings.codex.bypassApprovalsAndSandbox, true);
  assert.equal(settings.codex.permissionPrompts.mirrorToWhatsApp, false);
});

test("runtime settings mark instance desktops unprovisioned when explicitly disabled", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-runtime-desktops-not-provisioned-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_BROWSER_DESKTOP_MODE: "browserctl",
    ORKESTR_INSTANCE_DESKTOPS_PROVISIONED: "0",
  };

  const settings = await readRuntimeSettings(env);

  assert.equal(settings.desktops.enabled, false);
  assert.equal(settings.desktops.provisioned, false);
  assert.equal(settings.desktops.mode, "browserctl");
});

test("approval replies accept slash and natural forms but reject unscoped always approval", () => {
  assert.deepEqual(classifyApprovalReply("/approve"), { action: "approve", scopedAlways: false });
  assert.deepEqual(classifyApprovalReply("approve"), { action: "approve", scopedAlways: false });
  assert.deepEqual(classifyApprovalReply("yes"), { action: "approve", scopedAlways: false });
  assert.deepEqual(classifyApprovalReply("/deny"), { action: "deny", scopedAlways: false });
  assert.deepEqual(classifyApprovalReply("no"), { action: "deny", scopedAlways: false });
  assert.deepEqual(classifyApprovalReply("/approve always this-thread"), { action: "approve", scopedAlways: true });
  assert.equal(classifyApprovalReply("always approve").error, "always_approval_requires_scope");
});
