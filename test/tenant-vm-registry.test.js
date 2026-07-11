import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { startServer } from "../apps/server/src/server.js";
import { approvePairingChallenge, createPairingChallenge, pairBrowser, sessionCookieHeader } from "../packages/core/src/security.js";
import { userPrincipal } from "../packages/core/src/principal.js";
import { createUser } from "../packages/core/src/users.js";
import {
  createTenantVm,
  deleteTenantVm,
  getTenantVmForOwner,
  getTenantVmForPrincipal,
  listTenantVmsForPrincipal,
  publicTenantVm,
} from "../packages/core/src/tenant-vm-registry.js";

async function read(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

async function desktopShareApiCallsFromHtml(html, pathname) {
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] || "";
  assert.ok(script);
  const calls = [];
  const nodes = new Map();
  const element = (id) => {
    if (!nodes.has(id)) {
      nodes.set(id, {
        textContent: "",
        className: "",
        href: "#",
        hidden: false,
        addEventListener() {},
      });
    }
    return nodes.get(id);
  };
  vm.runInNewContext(script, {
    location: { pathname, search: "?key=secret", origin: "http://127.0.0.1" },
    document: { getElementById: element },
    navigator: { clipboard: { writeText: async () => null } },
    fetch: async (url) => {
      calls.push(String(url));
      return {
        ok: true,
        json: async () => ({ ok: true, approved: false, attempt: { challenge: "desk-test" } }),
      };
    },
    setTimeout() {},
    URL,
    URLSearchParams,
    encodeURIComponent,
    decodeURIComponent,
    Error,
  }, { timeout: 1000 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  return calls;
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address())));
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("tenant VM registry keeps one active tenant instance per owner", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-tenant-vms-core-"));
  const env = { ORKESTR_HOME: home };

  const vm = await createTenantVm({
    id: "Otcan Test",
    ownerUserId: "otcan",
    displayName: "Otcan tenant",
    resources: { vcpus: 2, memoryMiB: 8192, diskGiB: 100 },
    endpoint: { domain: "tenant.example.test", baseUrl: "https://tenant.example.test", publicIp: "192.0.2.10" },
    kubevirt: { namespace: "orkestr-tenants", vmName: "otcan-vm" },
    bootstrap: {
      firstThreadName: "otcantest",
      firstThreadId: "otcantest",
      workspacePath: "/opt/orkestr/workspace/otcantest",
      skills: ["learning", "linkedin"],
      desks: ["linkedin"],
    },
    connectors: { whatsappChatName: "otcantest" },
  }, env);

  assert.equal(vm.id, "otcan-test");
  assert.equal(vm.ownerUserId, "otcan");
  assert.equal(vm.status, "planned");
  assert.equal(vm.resources.memoryMiB, 8192);
  assert.equal(vm.endpoint.domain, "tenant.example.test");
  assert.equal(vm.kubevirt.vmName, "otcan-vm");
  assert.equal(vm.bootstrap.firstThreadName, "otcantest");
  assert.equal(vm.bootstrap.firstThreadId, "otcantest");
  assert.equal(vm.bootstrap.workspacePath, "/opt/orkestr/workspace/otcantest");
  assert.deepEqual(vm.bootstrap.skills, ["learning", "linkedin"]);
  assert.deepEqual(vm.bootstrap.desks, ["linkedin"]);
  assert.equal(vm.connectors.whatsappChatName, "otcantest");

  await assert.rejects(
    () => createTenantVm({ id: "otcan-second", ownerUserId: "otcan" }, env),
    /tenant_vm_owner_already_has_instance/,
  );
  assert.equal((await getTenantVmForOwner("otcan", env)).id, "otcan-test");
  assert.deepEqual((await listTenantVmsForPrincipal(userPrincipal({ id: "otcan" }), env)).map((item) => item.id), ["otcan-test"]);
  assert.deepEqual(await listTenantVmsForPrincipal(userPrincipal({ id: "bob" }), env), []);
  assert.deepEqual(await listTenantVmsForPrincipal({}, env), []);
  await assert.rejects(
    () => getTenantVmForPrincipal("otcan-test", userPrincipal({ id: "bob" }), env),
    /tenant_vm_access_forbidden/,
  );

  const publicVm = publicTenantVm({ ...vm, token: "secret", password: "secret" });
  assert.equal(Object.hasOwn(publicVm, "token"), false);
  assert.equal(Object.hasOwn(publicVm, "password"), false);

  const deleted = await deleteTenantVm("otcan-test", env);
  assert.equal(deleted.status, "deleted");
  assert.ok(deleted.deletedAt);
  const replacement = await createTenantVm({ id: "otcan-next", ownerUserId: "otcan" }, env);
  assert.equal(replacement.id, "otcan-next");
});

test("tenant VM registry API is admin-only and returns public-safe records", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-tenant-vms-api-"));
  const priorHome = process.env.ORKESTR_HOME;
  const priorAuth = process.env.ORKESTR_AUTH_REQUIRED;
  const priorRecover = process.env.ORKESTR_RECOVER_RUNNING_ON_START;
  process.env.ORKESTR_HOME = home;
  process.env.ORKESTR_AUTH_REQUIRED = "1";
  process.env.ORKESTR_RECOVER_RUNNING_ON_START = "0";
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const firstChallenge = await read(await fetch(`${baseUrl}/api/setup/security/challenges`, { method: "POST" }));
    await approvePairingChallenge(firstChallenge.challengeId, { env: process.env });
    const adminPair = await fetch(`${baseUrl}/api/setup/security/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ challengeId: firstChallenge.challengeId }),
    });
    const adminCookie = adminPair.headers.get("set-cookie") || "";
    assert.equal(adminPair.status, 200);

    const created = await read(await fetch(`${baseUrl}/api/tenant-vms`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: adminCookie },
      body: JSON.stringify({
        id: "alice-tenant",
        ownerUserId: "alice",
        displayName: "Alice tenant",
        resources: { vcpus: 3, memoryMiB: 6144, diskGiB: 80 },
        endpoint: { domain: "alice.example.test", baseUrl: "https://alice.example.test" },
        kubevirt: { namespace: "tenant-a", vmName: "alice-vm", storageClass: "local-path" },
        connectors: { whatsappChatName: "alice-wa" },
        token: "must-not-be-persisted",
      }),
    }));
    assert.equal(created.tenantVm.id, "alice-tenant");
    assert.equal(created.tenantVm.ownerUserId, "alice");
    assert.equal(created.tenantVm.resources.vcpus, 3);
    assert.equal(created.tenantVm.endpoint.baseUrl, "https://alice.example.test");
    assert.equal(created.tenantVm.trust.trustLevel, "untrusted");
    assert.equal(Object.hasOwn(created.tenantVm, "token"), false);

    const duplicate = await fetch(`${baseUrl}/api/tenant-vms`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: adminCookie },
      body: JSON.stringify({ id: "alice-duplicate", ownerUserId: "alice" }),
    });
    const duplicatePayload = await read(duplicate);
    assert.equal(duplicate.status, 409);
    assert.equal(duplicatePayload.error, "tenant_vm_owner_already_has_instance");

    const updated = await read(await fetch(`${baseUrl}/api/tenant-vms/alice-tenant/status`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: adminCookie },
      body: JSON.stringify({ status: "running" }),
    }));
    assert.equal(updated.tenantVm.status, "running");

    const trusted = await read(await fetch(`${baseUrl}/api/tenant-vms/alice-tenant/trust`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: adminCookie },
      body: JSON.stringify({ action: "trust", fingerprint: "sha256:tenant-fingerprint", reason: "operator approved enrollment" }),
    }));
    assert.equal(trusted.tenantVm.trust.enrollmentStatus, "enrolled");
    assert.equal(trusted.tenantVm.trust.trustLevel, "trusted");
    assert.equal(trusted.tenantVm.trust.fingerprint, "sha256:tenant-fingerprint");
    assert.equal(trusted.tenantVm.trust.lastReason, "operator approved enrollment");

    const listed = await read(await fetch(`${baseUrl}/api/tenant-vms`, { headers: { cookie: adminCookie } }));
    assert.deepEqual(listed.tenantVms.map((tenantVm) => tenantVm.id), ["alice-tenant"]);
    assert.equal(listed.tenantVms[0].trust.trustLevel, "trusted");

    const whatsappRoute = await read(await fetch(`${baseUrl}/api/tenant-vms/alice-tenant/whatsapp-route`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: adminCookie },
      body: JSON.stringify({
        chatId: "wa-group-zero@g.us",
        accountId: "responder",
        brokerBaseUrl: "http://alice-broker.internal.test",
      }),
    }));
    assert.equal(whatsappRoute.route.target, "http://alice-broker.internal.test/api/connectors/whatsapp/inbound");
    assert.equal(whatsappRoute.route.routeMode, "broker");
    assert.equal(whatsappRoute.route.targetSource, "broker");
    assert.match(whatsappRoute.route.token, /^owt_/);
    const listedWithRoute = await read(await fetch(`${baseUrl}/api/tenant-vms`, { headers: { cookie: adminCookie } }));
    assert.equal(listedWithRoute.tenantVms[0].whatsappRoute.token, undefined);
    assert.equal(listedWithRoute.tenantVms[0].whatsappRoute.tokenConfigured, true);
    assert.equal(listedWithRoute.tenantVms[0].whatsappRoute.target, "http://alice-broker.internal.test/api/connectors/whatsapp/inbound");
    assert.equal(listedWithRoute.tenantVms[0].whatsappRoute.chatId, "wa-group-zero@g.us");

    const provisioned = await read(await fetch(`${baseUrl}/api/tenant-vms/alice-tenant/provision`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: adminCookie },
      body: JSON.stringify({
        dryRun: true,
        repoUrl: "https://github.com/example/orkestr.git",
        sshPublicKeys: [
          "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEPublicTenantProvisioningApiTestKeyOnly alice@example.test",
        ],
      }),
    }));
    assert.equal(provisioned.dryRun, true);
    assert.equal(provisioned.tenantVm.id, "alice-tenant");
    assert.equal(provisioned.namespace, "tenant-a");
    assert.equal(provisioned.bootstrapProfile.firstChat.name, "alice-wa");
    assert.equal(provisioned.bootstrapProfile.codex.model, "gpt-5.5");
    assert.equal(provisioned.bootstrapProfile.policy.sanitizerRequired, true);
    assert.match(provisioned.manifest, /"kind": "VirtualMachine"/);
    assert.deepEqual(provisioned.commands.apply, ["kubectl", "apply", "-f", "-"]);

    await createUser({
      email: "alice@example.test",
      phoneNumber: "+15551234567",
      role: "user",
      displayName: "Alice",
    }, process.env);
    const userChallenge = await read(await fetch(`${baseUrl}/api/setup/security/challenges`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: adminCookie },
      body: JSON.stringify({ userId: "alice-example.test" }),
    }));
    await approvePairingChallenge(userChallenge.challengeId, { env: process.env });
    const userPair = await fetch(`${baseUrl}/api/setup/security/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ challengeId: userChallenge.challengeId }),
    });
    const userCookie = userPair.headers.get("set-cookie") || "";
    assert.equal(userPair.status, 200);

    const denied = await fetch(`${baseUrl}/api/tenant-vms`, { headers: { cookie: userCookie } });
    const deniedPayload = await read(denied);
    assert.equal(denied.status, 403);
    assert.equal(deniedPayload.error, "control_plane_admin_required");

    const deniedProvision = await fetch(`${baseUrl}/api/tenant-vms/alice-tenant/provision`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: userCookie },
      body: JSON.stringify({ dryRun: true }),
    });
    const deniedProvisionPayload = await read(deniedProvision);
    assert.equal(deniedProvision.status, 403);
    assert.equal(deniedProvisionPayload.error, "control_plane_admin_required");

    const deniedRoute = await fetch(`${baseUrl}/api/tenant-vms/alice-tenant/whatsapp-route`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: userCookie },
      body: JSON.stringify({ chatId: "blocked@g.us" }),
    });
    const deniedRoutePayload = await read(deniedRoute);
    assert.equal(deniedRoute.status, 403);
    assert.equal(deniedRoutePayload.error, "control_plane_admin_required");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (priorHome === undefined) delete process.env.ORKESTR_HOME;
    else process.env.ORKESTR_HOME = priorHome;
    if (priorAuth === undefined) delete process.env.ORKESTR_AUTH_REQUIRED;
    else process.env.ORKESTR_AUTH_REQUIRED = priorAuth;
    if (priorRecover === undefined) delete process.env.ORKESTR_RECOVER_RUNNING_ON_START;
    else process.env.ORKESTR_RECOVER_RUNNING_ON_START = priorRecover;
  }
});

test("tenant VM desktop-share proxy rewrites share and desktop URLs through the parent app", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-tenant-vms-desktop-proxy-"));
  const priorHome = process.env.ORKESTR_HOME;
  const priorAuth = process.env.ORKESTR_AUTH_REQUIRED;
  const priorRecover = process.env.ORKESTR_RECOVER_RUNNING_ON_START;
  const upstreamRequests = [];
  const upstream = http.createServer((request, response) => {
    upstreamRequests.push({ url: request.url, cookie: request.headers.cookie || "" });
    if (request.url.startsWith("/api/desktop-shares/share-1/open")) {
      response.writeHead(200, {
        "content-type": "application/json",
        "set-cookie": "orkestr_desktop_share=share-1%3Abrowser-token; Path=/; HttpOnly; SameSite=Lax",
      });
      response.end(JSON.stringify({
        ok: true,
        approved: true,
        desktopUrl: "/desktop/gmail/vnc.html?autoconnect=1&resize=scale&path=desktop/gmail/websockify",
      }));
      return;
    }
    if (request.url.startsWith("/api/desktop-shares/share-1/status")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        ok: true,
        approved: true,
        desktopUrl: "/desktop/gmail/vnc.html?autoconnect=1&resize=scale&path=desktop/gmail/websockify",
      }));
      return;
    }
    if (request.url.startsWith("/desktop/gmail/vnc.html")) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><title>Tenant desktop</title>");
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: false, error: "not_found" }));
  });
  const upstreamAddress = await listen(upstream);
  process.env.ORKESTR_HOME = home;
  process.env.ORKESTR_AUTH_REQUIRED = "1";
  process.env.ORKESTR_RECOVER_RUNNING_ON_START = "0";
  await createTenantVm({
    id: "alice-tenant",
    ownerUserId: "alice",
    status: "running",
    endpoint: { baseUrl: `http://127.0.0.1:${upstreamAddress.port}` },
  }, process.env);
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const authIntentChallenge = await createPairingChallenge({
      env: process.env,
      instanceId: "instance-firat",
      userId: "alice",
      role: "user",
      allowedActions: ["orkestr_auth.google.connect:connect-1"],
      authIntent: {
        tool: "orkestr_auth",
        service: "gmail",
        provider: "google_workspace",
        action: "connect",
        instanceId: "instance-firat",
      },
    });
    await approvePairingChallenge(authIntentChallenge.challengeId, { env: process.env, approvedBy: "node:test" });
    const authIntentSession = await pairBrowser({ challengeId: authIntentChallenge.challengeId, env: process.env });
    const authIntentCookie = sessionCookieHeader(authIntentSession.token, process.env);

    const authIntentSharePage = await fetch(`${baseUrl}/desktop-share/tvm/alice-tenant/d-abc123/share-1?key=secret`, {
      headers: { cookie: authIntentCookie },
    });
    const authIntentShareHtml = await authIntentSharePage.text();
    assert.equal(authIntentSharePage.status, 200);
    assert.match(authIntentShareHtml, /Orkestr Desktop Access/);
    const authIntentBrokerSharePage = await fetch(`${baseUrl}/i/instance-firat/app/desktop-share/tvm/alice-tenant/d-abc123/share-1?key=secret`, {
      headers: { cookie: authIntentCookie },
    });
    const authIntentBrokerShareHtml = await authIntentBrokerSharePage.text();
    assert.equal(authIntentBrokerSharePage.status, 200, authIntentBrokerShareHtml);
    assert.match(authIntentBrokerShareHtml, /Orkestr Desktop Access/);
    const otherInstanceAuthIntentBrokerSharePage = await fetch(`${baseUrl}/i/instance-eren/app/desktop-share/tvm/alice-tenant/d-abc123/share-1?key=secret`, {
      headers: { cookie: authIntentCookie },
    });
    const otherInstanceAuthIntentBrokerShareHtml = await otherInstanceAuthIntentBrokerSharePage.text();
    assert.equal(otherInstanceAuthIntentBrokerSharePage.status, 200, otherInstanceAuthIntentBrokerShareHtml);
    assert.match(otherInstanceAuthIntentBrokerShareHtml, /Orkestr Desktop Access/);
    const directShareCalls = await desktopShareApiCallsFromHtml(
      authIntentShareHtml,
      "/desktop-share/tvm/alice-tenant/d-abc123/share-1",
    );
    assert.equal(
      directShareCalls[0],
      "/api/tenant-vms/alice-tenant/desktop-shares/share-1/open?key=secret&subdomain=d-abc123",
    );
    const prefixedShareCalls = await desktopShareApiCallsFromHtml(
      authIntentShareHtml,
      "/i/instance-firat/app/desktop-share/tvm/alice-tenant/d-abc123/share-1",
    );
    assert.equal(
      prefixedShareCalls[0],
      "/api/tenant-vms/alice-tenant/desktop-shares/share-1/open?key=secret&subdomain=d-abc123",
    );

    const open = await fetch(`${baseUrl}/api/tenant-vms/alice-tenant/desktop-shares/share-1/open?key=secret&subdomain=d-abc123`);
    const openPayload = await read(open);
    const cookie = open.headers.get("set-cookie") || "";
    assert.equal(open.status, 200);
    assert.match(cookie, /orkestr_desktop_share=/);
    assert.equal(
      openPayload.desktopUrl,
      "/tenant-vms/alice-tenant/desktop/gmail/vnc.html?autoconnect=1&resize=scale&path=tenant-vms%2Falice-tenant%2Fdesktop%2Fgmail%2Fwebsockify",
    );

    const status = await read(await fetch(`${baseUrl}/api/tenant-vms/alice-tenant/desktop-shares/share-1/status?key=secret&subdomain=d-abc123`, {
      headers: { cookie },
    }));
    assert.equal(status.approved, true);
    assert.match(status.desktopUrl, /^\/tenant-vms\/alice-tenant\/desktop\/gmail\/vnc\.html/);

    const authIntentOpen = await fetch(`${baseUrl}/api/tenant-vms/alice-tenant/desktop-shares/share-1/open?key=secret&subdomain=d-abc123`, {
      headers: { cookie: authIntentCookie },
    });
    const authIntentOpenPayload = await read(authIntentOpen);
    assert.equal(authIntentOpen.status, 200, JSON.stringify(authIntentOpenPayload));
    assert.match(authIntentOpenPayload.desktopUrl, /^\/tenant-vms\/alice-tenant\/desktop\/gmail\/vnc\.html/);

    const authIntentStatus = await fetch(`${baseUrl}/api/tenant-vms/alice-tenant/desktop-shares/share-1/status?key=secret&subdomain=d-abc123`, {
      headers: { cookie: authIntentCookie },
    });
    const authIntentStatusPayload = await read(authIntentStatus);
    assert.equal(authIntentStatus.status, 200, JSON.stringify(authIntentStatusPayload));
    assert.equal(authIntentStatusPayload.approved, true);

    const desktop = await fetch(`${baseUrl}${openPayload.desktopUrl}`, { headers: { cookie } });
    assert.equal(desktop.status, 200);
    assert.match(await desktop.text(), /Tenant desktop/);
    const desktopWithAuthIntentCookie = await fetch(`${baseUrl}${openPayload.desktopUrl}`, { headers: { cookie: `${authIntentCookie}; ${cookie}` } });
    assert.equal(desktopWithAuthIntentCookie.status, 200);
    assert.match(await desktopWithAuthIntentCookie.text(), /Tenant desktop/);
    assert.equal(upstreamRequests.some((item) => item.url.startsWith("/desktop/gmail/vnc.html") && /orkestr_desktop_share=/.test(item.cookie)), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await close(upstream);
    if (priorHome === undefined) delete process.env.ORKESTR_HOME;
    else process.env.ORKESTR_HOME = priorHome;
    if (priorAuth === undefined) delete process.env.ORKESTR_AUTH_REQUIRED;
    else process.env.ORKESTR_AUTH_REQUIRED = priorAuth;
    if (priorRecover === undefined) delete process.env.ORKESTR_RECOVER_RUNNING_ON_START;
    else process.env.ORKESTR_RECOVER_RUNNING_ON_START = priorRecover;
  }
});
