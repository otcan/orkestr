import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultApiBase } from "../apps/cli/src/api-client.js";
import { runCli } from "../apps/cli/src/commands.js";
import { createDesktopShare, desktopShareStatus, openDesktopShare } from "../packages/core/src/desktop-shares.js";
import { userPrincipal } from "../packages/core/src/principal.js";
import { writeRuntimeSettings } from "../packages/core/src/runtime-settings.js";
import { approvePairingChallenge, createPairingChallenge, getPairingChallenge, pairBrowser } from "../packages/core/src/security.js";

function capture() {
  let text = "";
  return {
    write(value) {
      text += String(value);
    },
    text() {
      return text;
    },
  };
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fakeFetch(routes, seen = []) {
  return async (url, options = {}) => {
    const parsed = new URL(url);
    const method = String(options.method || "GET").toUpperCase();
    const key = `${method} ${parsed.pathname}`;
    seen.push({ key, search: parsed.search, headers: options.headers || {}, body: options.body ? JSON.parse(options.body) : null });
    const route = routes[key];
    if (!route) return jsonResponse({ error: `missing route: ${key}` }, 404);
    const result = typeof route === "function" ? route(seen.at(-1)) : route;
    return result instanceof Response ? result : jsonResponse(result);
  };
}

test("CLI help exposes local service commands promised by the installer", async () => {
  const stdout = capture();
  const code = await runCli(["--help"], {
    stdout,
    stderr: capture(),
  });

  assert.equal(code, 0);
  assert.match(stdout.text(), /orkestr service \[status\|start\|stop\|restart\|logs\]/);
  assert.match(stdout.text(), /orkestr start\|stop\|restart/);
  assert.match(stdout.text(), /orkestr logs \[--service orkestr\]/);
  assert.match(stdout.text(), /orkestr sanitizer check --action action --text text/);
});

test("CLI serve shutdown has a bounded force-exit fallback", async () => {
  const source = await fs.readFile("apps/cli/src/commands.js", "utf8");

  assert.match(source, /ORKESTR_SERVE_SHUTDOWN_TIMEOUT_MS/);
  assert.match(source, /process\.exit\(0\)/);
});

test("CLI lists threads from the public API", async () => {
  const stdout = capture();
  const code = await runCli(["--api", "http://orkestr.test", "list"], {
    stdout,
    stderr: capture(),
    fetchImpl: fakeFetch({
      "GET /api/threads/summary": {
        threads: [{ id: "thread-1", name: "Demo", state: "ready", runtime: { sessionName: "orkestr-demo" } }],
      },
    }),
  });

  assert.equal(code, 0);
  assert.match(stdout.text(), /Demo/);
  assert.match(stdout.text(), /ready/);
  assert.match(stdout.text(), /thread-1/);
});

test("CLI lists release instances from the broker API", async () => {
  const stdout = capture();
  const seen = [];
  const code = await runCli(["--api", "http://orkestr.test", "instances", "--probe"], {
    stdout,
    stderr: capture(),
    fetchImpl: fakeFetch({
      "GET /api/release/instances": {
        instances: [
          {
            id: "central",
            kind: "local-service",
            status: "running",
            releaseTrainEnabled: true,
            hasDeployCommand: false,
            baseUrl: "https://central.example.test",
            currentVersion: { releaseId: "main-abc123", releaseLabel: "v0.1.0-alpha.27" },
          },
          {
            id: "vm-tenant",
            kind: "tenant-vm",
            status: "running",
            releaseTrainEnabled: true,
            hasDeployCommand: true,
            baseUrl: "https://tenant.example.test",
          },
        ],
      },
    }, seen),
  });

  assert.equal(code, 0);
  assert.equal(seen[0].search, "?probe=1");
  assert.match(stdout.text(), /central/);
  assert.match(stdout.text(), /local/);
  assert.match(stdout.text(), /vm-tenant/);
  assert.match(stdout.text(), /ready/);
});

test("CLI sends local cli-auth bearer token when ORKESTR_HOME has one", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-cli-auth-"));
  await fs.mkdir(path.join(home, "secrets"), { recursive: true });
  await fs.writeFile(path.join(home, "secrets", "cli-auth.json"), JSON.stringify({
    token: "local-cli-token",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }), "utf8");
  const stdout = capture();
  const seen = [];
  const code = await runCli(["--api", "http://orkestr.test", "list", "--json"], {
    env: { ORKESTR_HOME: home },
    stdout,
    stderr: capture(),
    fetchImpl: fakeFetch({
      "GET /api/threads/summary": { threads: [] },
    }, seen),
  });

  assert.equal(code, 0);
  assert.equal(seen[0].headers.authorization, "Bearer local-cli-token");
});

test("CLI falls back to the local Orkestr env file for cli-auth", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-cli-auth-env-file-"));
  await fs.mkdir(path.join(home, "secrets"), { recursive: true });
  await fs.writeFile(path.join(home, "secrets", "cli-auth.json"), JSON.stringify({
    token: "env-file-cli-token",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }), "utf8");
  const envFile = path.join(home, "orkestr.env");
  await fs.writeFile(envFile, `ORKESTR_HOME=${home}\nORKESTR_API_BASE=http://orkestr.test\n`, "utf8");
  const stdout = capture();
  const seen = [];
  const code = await runCli(["list", "--json"], {
    env: { ORKESTR_ENV_FILE: envFile },
    stdout,
    stderr: capture(),
    fetchImpl: fakeFetch({
      "GET /api/threads/summary": { threads: [] },
    }, seen),
  });

  assert.equal(code, 0);
  assert.equal(seen[0].headers.authorization, "Bearer env-file-cli-token");
});

test("CLI sanitizer check posts a server-owned sanitizer request", async () => {
  const stdout = capture();
  const seen = [];
  const code = await runCli([
    "--api",
    "http://orkestr.test",
    "sanitizer",
    "check",
    "--action",
    "external.submit",
    "--text",
    "Submit the current user's StepStone application.",
    "--url",
    "https://www.stepstone.de/job/123",
    "--cwd",
    "/workspace/firat-jobs",
    "--json",
  ], {
    stdout,
    stderr: capture(),
    fetchImpl: fakeFetch({
      "POST /api/sanitizer/check": {
        ok: true,
        allow: true,
        decision: { allow: true, reason: "server-owned-allowed", unavailable: false },
        thread: { id: "firat-jobs", ownerUserId: "firat" },
      },
    }, seen),
  });

  assert.equal(code, 0);
  assert.equal(seen[0].body.action, "external.submit");
  assert.equal(seen[0].body.text, "Submit the current user's StepStone application.");
  assert.equal(seen[0].body.url, "https://www.stepstone.de/job/123");
  assert.equal(seen[0].body.cwd, "/workspace/firat-jobs");
  assert.match(stdout.text(), /"allow": true/);
});

test("CLI sanitizer check forwards thread id from runtime env", async () => {
  const stdout = capture();
  const seen = [];
  const code = await runCli([
    "--api",
    "http://orkestr.test",
    "sanitizer",
    "check",
    "--action",
    "external.submit",
    "--text",
    "Submit the current user's StepStone application.",
    "--json",
  ], {
    env: { ORKESTR_THREAD_ID: "firat-jobs" },
    stdout,
    stderr: capture(),
    fetchImpl: fakeFetch({
      "POST /api/sanitizer/check": {
        ok: true,
        allow: true,
        decision: { allow: true, reason: "server-owned-allowed", unavailable: false },
        thread: { id: "firat-jobs", ownerUserId: "firat" },
      },
    }, seen),
  });

  assert.equal(code, 0);
  assert.equal(seen[0].body.threadId, "firat-jobs");
  assert.match(stdout.text(), /"allow": true/);
});

test("CLI sanitizer check returns 2 when the server sanitizer is unavailable", async () => {
  const stdout = capture();
  const code = await runCli([
    "--api",
    "http://orkestr.test",
    "sanitizer",
    "check",
    "--action",
    "external.submit",
    "--text",
    "Submit the current user's StepStone application.",
  ], {
    stdout,
    stderr: capture(),
    fetchImpl: fakeFetch({
      "POST /api/sanitizer/check": {
        ok: false,
        allow: false,
        decision: { allow: false, reason: "llm_sanitizer_http_401", unavailable: true },
        thread: { id: "firat-jobs", ownerUserId: "firat" },
      },
    }),
  });

  assert.equal(code, 2);
  assert.match(stdout.text(), /Sanitizer: blocked \(llm_sanitizer_http_401\)/);
});

test("CLI creates a missing local cli-auth token from the env-file data home", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-cli-auth-create-"));
  const envFile = path.join(home, "orkestr.env");
  await fs.writeFile(envFile, `ORKESTR_HOME=${home}\nORKESTR_API_BASE=http://orkestr.test\n`, "utf8");
  const stdout = capture();
  const seen = [];
  const code = await runCli(["whereiam", "--cwd", "/workspace/demo", "--json"], {
    env: { ORKESTR_ENV_FILE: envFile },
    stdout,
    stderr: capture(),
    fetchImpl: fakeFetch({
      "GET /api/whereiam": {
        ok: true,
        thread: { id: "thread-1", displayName: "Demo", state: "ready" },
        workspace: { cwd: "/workspace/demo", runtimeWorkspace: "/workspace/demo" },
      },
    }, seen),
  });
  const raw = await fs.readFile(path.join(home, "secrets", "cli-auth.json"), "utf8");
  const stored = JSON.parse(raw);

  assert.equal(code, 0);
  assert.match(seen[0].headers.authorization || "", /^Bearer [A-Za-z0-9_-]{32,}$/);
  assert.equal(seen[0].headers.authorization, `Bearer ${stored.token}`);
});

test("CLI maps bind-all Orkestr hosts to loopback for local API calls", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-cli-bind-host-"));
  const envFile = path.join(home, "orkestr.env");
  await fs.writeFile(envFile, "ORKESTR_HOST=0.0.0.0\nORKESTR_PORT=21000\n", "utf8");

  assert.equal(defaultApiBase({ ORKESTR_ENV_FILE: envFile }), "http://127.0.0.1:21000");
  assert.equal(defaultApiBase({ ORKESTR_HOST: "::", ORKESTR_PORT: "22000" }), "http://127.0.0.1:22000");
});

test("CLI updates WhatsApp binding owner aliases", async () => {
  const stdout = capture();
  const seen = [];
  const code = await runCli([
    "--api",
    "http://orkestr.test",
    "whatsapp",
    "bindings",
    "update",
    "thread:owner-alias-thread:whatsapp",
    "--owner-contact",
    "4917632400662@c.us",
    "--owner-contact-alias",
    "66378837028965@lid",
    "--authorized-contact",
    "4917632400662@c.us",
    "--json",
  ], {
    stdout,
    stderr: capture(),
    fetchImpl: fakeFetch({
      "PUT /api/connectors/whatsapp/bindings/thread%3Aowner-alias-thread%3Awhatsapp": {
        ok: true,
        binding: {
          id: "thread:owner-alias-thread:whatsapp",
          state: "ready",
          ownerContactAliases: ["66378837028965@lid"],
        },
      },
    }, seen),
  });

  assert.equal(code, 0);
  assert.deepEqual(seen[0].body.ownerContactIds, ["4917632400662@c.us"]);
  assert.deepEqual(seen[0].body.ownerContactAliases, ["66378837028965@lid"]);
  assert.deepEqual(seen[0].body.authorizedContactIds, ["4917632400662@c.us"]);
  assert.match(stdout.text(), /owner-alias-thread/);
});

test("CLI whereiam sends the current directory to the public API", async () => {
  const stdout = capture();
  const seen = [];
  const cwd = "/workspace/demo";
  const code = await runCli(["whereiam", "--cwd", cwd], {
    cwd,
    stdout,
    stderr: capture(),
    fetchImpl: fakeFetch({
      "GET /api/whereiam": {
        ok: true,
        thread: { id: "thread-1", displayName: "Demo", state: "ready" },
        workspace: { cwd, runtimeWorkspace: "/workspace/demo", repoPath: "/repo/demo" },
        runtime: { sessionName: "orkestr-demo", paneId: "%42" },
      },
    }, seen),
  });

  assert.equal(code, 0);
  assert.equal(seen[0].search, `?cwd=${encodeURIComponent(cwd)}`);
  assert.match(stdout.text(), /Thread: Demo \(thread-1\)/);
  assert.match(stdout.text(), /Repo: \/repo\/demo/);
});

test("CLI whereiam can bind a stable API session id", async () => {
  const stdout = capture();
  const seen = [];
  const cwd = "/workspace/demo";
  const code = await runCli(["whereiam", "--cwd", cwd, "--api-session-id", "api-1", "--bind", "--json"], {
    cwd,
    stdout,
    stderr: capture(),
    fetchImpl: fakeFetch({
      "GET /api/whereiam": {
        ok: true,
        matchedBy: "thread.repoPath",
        thread: { id: "thread-1", displayName: "Demo", state: "ready" },
        apiSession: { id: "api-1", bound: true, threadId: "thread-1" },
      },
    }, seen),
  });

  assert.equal(code, 0);
  assert.equal(seen[0].search, `?cwd=${encodeURIComponent(cwd)}&apiSessionId=api-1&bind=1`);
  assert.equal(JSON.parse(stdout.text()).apiSession.bound, true);
});

test("CLI api-session bind posts a stable session binding", async () => {
  const stdout = capture();
  const seen = [];
  const cwd = "/workspace/demo";
  const code = await runCli(["api-session", "bind", "--api-session-id", "api-1", "--cwd", cwd, "--thread", "thread-1"], {
    cwd,
    stdout,
    stderr: capture(),
    fetchImpl: fakeFetch({
      "POST /api/session-bindings": {
        ok: true,
        binding: { apiSessionId: "api-1", threadId: "thread-1", cwd },
        thread: { id: "thread-1", name: "Demo" },
      },
    }, seen),
  });

  assert.equal(code, 0);
  assert.equal(seen[0].body.apiSessionId, "api-1");
  assert.equal(seen[0].body.cwd, cwd);
  assert.equal(seen[0].body.threadId, "thread-1");
  assert.equal(seen[0].body.source, "orkestr-cli");
  assert.match(stdout.text(), /Bound API session api-1 to Demo/);
});

test("CLI api-session message eagerly binds then posts visible assistant output", async () => {
  const stdout = capture();
  const seen = [];
  const cwd = "/workspace/demo";
  const code = await runCli(["api-session", "message", "Forward this", "--phase", "commentary"], {
    cwd,
    env: { ORKESTR_API_SESSION_ID: "api-env-1" },
    stdout,
    stderr: capture(),
    fetchImpl: fakeFetch({
      "GET /api/whereiam": {
        ok: true,
        thread: { id: "thread-1", displayName: "Demo", state: "ready" },
        apiSession: { id: "api-env-1", bound: true, threadId: "thread-1" },
      },
      "POST /api/session-bindings/api-env-1/messages": {
        ok: true,
        binding: { apiSessionId: "api-env-1", threadId: "thread-1" },
        thread: { id: "thread-1", name: "Demo" },
        message: { id: "message-1", role: "assistant" },
        deliveryExpected: true,
        deliveryState: { ok: true, state: "delivered" },
      },
    }, seen),
  });

  assert.equal(code, 0);
  assert.deepEqual(seen.map((entry) => entry.key), [
    "GET /api/whereiam",
    "POST /api/session-bindings/api-env-1/messages",
  ]);
  assert.equal(seen[0].search, `?cwd=${encodeURIComponent(cwd)}&apiSessionId=api-env-1&bind=1`);
  assert.equal(seen[1].body.text, "Forward this");
  assert.equal(seen[1].body.role, "assistant");
  assert.equal(seen[1].body.phase, "commentary");
  assert.match(stdout.text(), /Recorded assistant API session message: delivered/);
});

test("CLI api-session message JSON summarizes noisy WhatsApp delivery skips", async () => {
  const stdout = capture();
  const seen = [];
  const cwd = "/workspace/demo";
  const code = await runCli(["api-session", "message", "Forward this", "--json"], {
    cwd,
    env: { ORKESTR_API_SESSION_ID: "api-env-1" },
    stdout,
    stderr: capture(),
    fetchImpl: fakeFetch({
      "GET /api/whereiam": {
        ok: true,
        thread: { id: "thread-1", displayName: "Demo", state: "ready" },
        apiSession: { id: "api-env-1", bound: true, threadId: "thread-1" },
      },
      "POST /api/session-bindings/api-env-1/messages": {
        ok: true,
        binding: { apiSessionId: "api-env-1", threadId: "thread-1" },
        thread: { id: "thread-1", name: "Demo" },
        message: { id: "message-1", role: "assistant" },
        deliveryExpected: true,
        deliveryState: { ok: true, state: "delivered" },
        delivery: {
          delivered: [{ messageId: "message-1", status: "delivered" }],
          failed: [],
          skipped: [
            { messageId: "skip-1", reason: "stale_untracked_reply", threadId: "thread-1", chatId: "chat-1" },
            { messageId: "skip-2", reason: "stale_untracked_reply", threadId: "thread-1", chatId: "chat-1" },
            { messageId: "skip-3", reason: "duplicate_text", threadId: "thread-1", chatId: "chat-1" },
            { messageId: "skip-4", reason: "stale_untracked_reply", threadId: "thread-1", chatId: "chat-1" },
            { messageId: "skip-5", reason: "already_delivered", threadId: "thread-1", chatId: "chat-1" },
            { messageId: "skip-6", reason: "stale_untracked_reply", threadId: "thread-1", chatId: "chat-1" },
          ],
        },
      },
    }, seen),
  });

  assert.equal(code, 0);
  const payload = JSON.parse(stdout.text());
  assert.deepEqual(seen.map((entry) => entry.key), [
    "GET /api/whereiam",
    "POST /api/session-bindings/api-env-1/messages",
  ]);
  assert.equal(payload.delivery.delivered[0].messageId, "message-1");
  assert.equal(payload.delivery.skipped, undefined);
  assert.equal(payload.delivery.skippedSummary.count, 6);
  assert.deepEqual(payload.delivery.skippedSummary.reasons, {
    already_delivered: 1,
    duplicate_text: 1,
    stale_untracked_reply: 4,
  });
  assert.equal(payload.delivery.skippedSample.length, 5);
  assert.equal(payload.delivery.skippedSample[0].id, "skip-1");
  assert.equal(payload.delivery.skippedSample.at(-1).id, "skip-5");
});

test("CLI api-session message reports WhatsApp delivery failures with the reason", async () => {
  const stderr = capture();
  const seen = [];
  const cwd = "/workspace/demo";
  const code = await runCli(["api-session", "message", "Forward this"], {
    cwd,
    env: { ORKESTR_API_SESSION_ID: "api-env-1" },
    stdout: capture(),
    stderr,
    fetchImpl: fakeFetch({
      "GET /api/whereiam": {
        ok: true,
        thread: { id: "thread-1", displayName: "Demo", state: "ready" },
        apiSession: { id: "api-env-1", bound: true, threadId: "thread-1" },
      },
      "POST /api/session-bindings/api-env-1/messages": () => new Response(JSON.stringify({
        ok: false,
        error: "whatsapp_delivery_not_delivered",
        deliveryState: "skipped",
        reason: "missing_responder_account",
        message: { id: "message-1", threadId: "thread-1", chatId: "chat-1" },
      }), {
        status: 409,
        headers: { "content-type": "application/json" },
      }),
    }, seen),
  });

  assert.equal(code, 1);
  assert.match(stderr.text(), /whatsapp_delivery_not_delivered/);
  assert.match(stderr.text(), /delivery=skipped/);
  assert.match(stderr.text(), /reason=missing_responder_account/);
  assert.match(stderr.text(), /thread=thread-1/);
});

test("CLI api-session message reports WhatsApp delivery timeouts as pending", async () => {
  const stderr = capture();
  const seen = [];
  const cwd = "/workspace/demo";
  const code = await runCli(["api-session", "message", "Forward this"], {
    cwd,
    env: { ORKESTR_API_SESSION_ID: "api-env-1" },
    stdout: capture(),
    stderr,
    fetchImpl: fakeFetch({
      "GET /api/whereiam": {
        ok: true,
        thread: { id: "thread-1", displayName: "Demo", state: "ready" },
        apiSession: { id: "api-env-1", bound: true, threadId: "thread-1" },
      },
      "POST /api/session-bindings/api-env-1/messages": () => new Response(JSON.stringify({
        ok: false,
        error: "whatsapp_delivery_timeout",
        deliveryState: "timeout",
        reason: "WhatsApp delivery did not complete within 30000ms",
        timeoutMs: 30000,
        pending: true,
        message: { id: "message-1", threadId: "thread-1", chatId: "chat-1" },
      }), {
        status: 504,
        headers: { "content-type": "application/json" },
      }),
    }, seen),
  });

  assert.equal(code, 1);
  assert.match(stderr.text(), /whatsapp_delivery_timeout/);
  assert.match(stderr.text(), /delivery=timeout/);
  assert.match(stderr.text(), /pending=true/);
  assert.match(stderr.text(), /thread=thread-1/);
});

test("CLI api-session status reads the durable binding", async () => {
  const stdout = capture();
  const seen = [];
  const code = await runCli(["api-session", "status", "--api-session-id", "api-1"], {
    stdout,
    stderr: capture(),
    fetchImpl: fakeFetch({
      "GET /api/session-bindings/api-1": {
        ok: true,
        binding: {
          apiSessionId: "api-1",
          threadId: "thread-1",
          cwd: "/workspace/demo",
          lastMessageRole: "assistant",
          lastMessageAt: "2026-06-06T08:00:00.000Z",
        },
      },
    }, seen),
  });

  assert.equal(code, 0);
  assert.equal(seen[0].key, "GET /api/session-bindings/api-1");
  assert.match(stdout.text(), /API session api-1: thread-1/);
  assert.match(stdout.text(), /Last message: assistant/);
});

test("CLI codex migrate calls the migration API", async () => {
  const stdout = capture();
  const seen = [];
  const code = await runCli(["codex", "migrate", "--dry-run"], {
    stdout,
    stderr: capture(),
    fetchImpl: fakeFetch({
      "POST /api/codex/migrate": {
        ok: true,
        dryRun: true,
        candidates: 2,
        migrated: 0,
        counts: {
          mark_existing_codex_thread: 1,
          create_codex_app_server_thread: 1,
        },
      },
    }, seen),
  });

  assert.equal(code, 0);
  assert.deepEqual(seen.map((entry) => entry.key), ["POST /api/codex/migrate"]);
  assert.equal(seen[0].body.dryRun, true);
  assert.match(stdout.text(), /Codex migration: dry run/);
  assert.match(stdout.text(), /Candidates: 2/);
});

test("CLI desktop share chooses the configured desktop and calls the public API", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-cli-desktop-share-"));
  const env = { ORKESTR_HOME: home };
  await writeRuntimeSettings({ desktops: { manualIntervention: "linkedin", default: "desktop" } }, env);
  const stdout = capture();
  const seen = [];

  const code = await runCli(["--api", "http://orkestr.test", "desktop", "share"], {
    env,
    stdout,
    stderr: capture(),
    fetchImpl: fakeFetch({
      "GET /api/browser-sessions": {
        ok: true,
        sessions: [{ slug: "linkedin", label: "LinkedIn" }],
      },
      "POST /api/desktops/linkedin/share": {
        url: "https://desktop.example.test/desktop-share/share-1?key=secret",
        share: { desktopSlug: "linkedin", label: "LinkedIn" },
      },
    }, seen),
  });

  assert.equal(code, 0);
  assert.deepEqual(seen.map((entry) => entry.key), ["GET /api/browser-sessions", "POST /api/desktops/linkedin/share"]);
  assert.equal(seen[1].body.start, true);
  assert.match(stdout.text(), /Desktop link for LinkedIn/);
  assert.match(stdout.text(), /desktop-share\/share-1/);
});

test("CLI desktop share warns when desktop start fails after link creation", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-cli-desktop-share-start-warning-"));
  const env = { ORKESTR_HOME: home };
  const stdout = capture();

  const code = await runCli(["--api", "http://orkestr.test", "desktop", "share", "linkedin"], {
    env,
    stdout,
    stderr: capture(),
    fetchImpl: fakeFetch({
      "POST /api/desktops/linkedin/share": {
        url: "https://desktop.example.test/desktop-share/share-1?key=secret",
        share: { desktopSlug: "linkedin", label: "LinkedIn" },
        desktopStart: {
          requested: true,
          ok: false,
          error: "browserctl_root_requires_run_user_or_explicit_no_sandbox",
        },
      },
    }),
  });

  assert.equal(code, 0);
  assert.match(stdout.text(), /Desktop link for LinkedIn/);
  assert.match(stdout.text(), /Warning: desktop start failed: browserctl_root_requires_run_user_or_explicit_no_sandbox/);
});

test("CLI desktop approve approves a pasted mobile desktop challenge", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-cli-desktop-approve-"));
  const env = { ORKESTR_HOME: home };
  const principal = userPrincipal({ id: "alice", role: "user" });
  const created = await createDesktopShare({ desktopSlug: "linkedin", principal, env });
  const parsed = new URL(created.url);
  const shareId = parsed.pathname.split("/").filter(Boolean).at(-1);
  const key = parsed.searchParams.get("key");
  const opened = await openDesktopShare({ shareId, key, subdomain: created.subdomain, env });
  const stdout = capture();

  const code = await runCli(["desktop", "approve", opened.attempt.challenge], {
    env,
    stdout,
    stderr: capture(),
  });
  const ready = await desktopShareStatus({
    shareId,
    key,
    subdomain: created.subdomain,
    browserToken: opened.cookie.value.split(":")[1],
    env,
  });

  assert.equal(code, 0);
  assert.equal(ready.approved, true);
  assert.match(stdout.text(), /Approved desktop access for linkedin/);
});

test("CLI jira draft emits task candidates from thread history without creating issues", async () => {
  const stdout = capture();
  const seen = [];
  const code = await runCli(["--api", "http://orkestr.test", "jira", "draft", "thread-1", "--json"], {
    stdout,
    stderr: capture(),
    fetchImpl: fakeFetch({
      "GET /api/threads/thread-1/history": {
        thread: {
          id: "thread-1",
          name: "otcanClaw-orkestr",
          binding: { chatId: "chat-one@g.us" },
        },
        messages: [
          {
            id: "msg-1",
            role: "user",
            text: "Fix WhatsApp bridge ready-state drift and add regression tests",
            createdAt: "2026-06-13T12:00:00.000Z",
            cursor: 1,
            chatId: "chat-one@g.us",
          },
          {
            id: "msg-2",
            role: "assistant",
            text: "I reproduced stale ready state and will patch the bridge.",
            cursor: 2,
          },
        ],
      },
    }, seen),
  });

  const payload = JSON.parse(stdout.text());
  assert.equal(code, 0);
  assert.equal(payload.mode, "draft_only");
  assert.match(payload.warning, /No Jira issues were created/);
  assert.equal(payload.candidates.length, 1);
  assert.equal(payload.candidates[0].summary, "Fix WhatsApp bridge ready-state drift and add regression tests");
  assert.deepEqual(payload.candidates[0].labels.sort(), ["orkestr", "testing", "whatsapp"].sort());
  assert.equal(payload.candidates[0].source.threadId, "thread-1");
  assert.deepEqual(seen.map((entry) => entry.key), ["GET /api/threads/thread-1/history"]);
});

test("CLI jira draft text output is review-only", async () => {
  const stdout = capture();
  const code = await runCli(["--api", "http://orkestr.test", "jira", "draft", "thread-2"], {
    stdout,
    stderr: capture(),
    fetchImpl: fakeFetch({
      "GET /api/threads/thread-2/history": {
        thread: { id: "thread-2", name: "Desktop Thread" },
        messages: [
          { id: "msg-3", role: "user", text: "Improve desktop share renewal flow for expired links", cursor: 1 },
        ],
      },
    }),
  });

  assert.equal(code, 0);
  assert.match(stdout.text(), /No Jira issues were created/);
  assert.match(stdout.text(), /Improve desktop share renewal flow for expired links/);
  assert.match(stdout.text(), /Acceptance criteria:/);
});

test("CLI version prints the active build identity", async () => {
  const stdout = capture();
  const code = await runCli(["version"], {
    stdout,
    stderr: capture(),
    fetchImpl: fakeFetch({
      "GET /api/version": {
        name: "orkestr-oss",
        version: "0.1.0-alpha.12",
        commit: "6fc115b123456789",
        branch: "main",
        describe: "main-6fc115b",
        channel: "main",
        releaseId: "main-6fc115b",
        releaseLabel: "v0.1.0-alpha.12",
        releaseVersion: "0.1.0-alpha.12",
        buildId: "main-6fc115b",
        distributionKind: "oss",
        deploymentTrack: "oss",
        dirty: false,
      },
    }),
  });

  assert.equal(code, 0);
  assert.match(stdout.text(), /orkestr-oss 0\.1\.0-alpha\.12/);
  assert.match(stdout.text(), /Release: v0\.1\.0-alpha\.12/);
  assert.match(stdout.text(), /Distribution: oss \(oss\)/);
  assert.match(stdout.text(), /Commit: 6fc115b12345/);
});

test("CLI API failures are reported without an uncaught stack", async () => {
  const stderr = capture();
  const code = await runCli(["version"], {
    stdout: capture(),
    stderr,
    fetchImpl: async () => {
      throw new Error("api down");
    },
  });

  assert.equal(code, 1);
  assert.equal(stderr.text(), "api down\n");
});

test("CLI status summarizes version, setup, security, connectors, and doctor", async () => {
  const stdout = capture();
  const code = await runCli(["--api", "http://orkestr.test", "status"], {
    stdout,
    stderr: capture(),
    fetchImpl: fakeFetch({
      "GET /api/version": {
        name: "orkestr-oss",
        version: "0.1.0-alpha.12",
        commit: "6fc115b123456789",
        channel: "main",
        releaseId: "main-6fc115b",
        dirty: false,
      },
      "GET /api/setup/status": {
        setupState: "partial",
        security: { paired: true, remoteReady: true, pendingChallengeCount: 0 },
        connectors: [
          { id: "codex", state: "connected" },
          { id: "whatsapp", state: "partial" },
        ],
      },
      "GET /api/system/doctor": {
        ok: true,
        status: "ok",
        summary: "All system checks passed.",
        counts: { ok: 3, warnings: 0, errors: 0 },
      },
    }),
  });

  assert.equal(code, 0);
  assert.match(stdout.text(), /Orkestr: ok/);
  assert.match(stdout.text(), /URL: http:\/\/orkestr\.test/);
  assert.match(stdout.text(), /Setup: partial/);
  assert.match(stdout.text(), /Security: paired=yes remote=ready pending=0/);
  assert.match(stdout.text(), /codex:connected whatsapp:partial/);
});

test("CLI prints non-secret runtime settings from local state", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-cli-settings-"));
  const stdout = capture();
  const env = { ORKESTR_HOME: home };
  await writeRuntimeSettings({ desktops: { gmailAuth: "gmail" } }, env);

  const code = await runCli(["settings", "--json"], {
    env,
    stdout,
    stderr: capture(),
  });
  const payload = JSON.parse(stdout.text());

  assert.equal(code, 0);
  assert.equal(payload.settings.profile, undefined);
  assert.equal(payload.settings.desktops.gmailAuth, "gmail");
  assert.equal(payload.settings.codex.permissionPrompts.alwaysApprove.requiresExplicitScope, true);
});

test("CLI creates a Google Workspace connect link for agents", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-cli-connect-google-"));
  const stdout = capture();
  const code = await runCli(["connect", "google", "--json"], {
    env: {
      ORKESTR_HOME: home,
      ORKESTR_PUBLIC_URL: "https://app.example.test",
    },
    stdout,
    stderr: capture(),
  });
  const payload = JSON.parse(stdout.text());

  assert.equal(code, 0);
  assert.equal(payload.ok, true);
  assert.match(payload.link, /^https:\/\/app\.example\.test\/connect\/google\?connect=/);
  assert.match(payload.message, /Requested provider: google_workspace/);
});

test("CLI manages secure input secrets without echoing values", async () => {
  const stdout = capture();
  const seen = [];
  const code = await runCli(["secret", "set", "openai/api-key", "--json"], {
    stdout,
    stderr: capture(),
    readSecretValue: async () => "super-secret-value",
    fetchImpl: fakeFetch({
      "POST /api/secure-input/secrets": {
        ok: true,
        secret: {
          handle: "secret://user/admin/openai/api-key",
          scope: "user",
          ownerUserId: "admin",
          status: "configured",
          updatedAt: "2026-06-07T12:00:00.000Z",
        },
      },
    }, seen),
  });

  assert.equal(code, 0);
  assert.equal(seen[0].key, "POST /api/secure-input/secrets");
  assert.deepEqual(seen[0].body, {
    scope: "user",
    name: "openai/api-key",
    value: "super-secret-value",
  });
  assert.equal(stdout.text().includes("super-secret-value"), false);
  assert.equal(JSON.parse(stdout.text()).secret.handle, "secret://user/admin/openai/api-key");

  const listStdout = capture();
  const listSeen = [];
  const listCode = await runCli(["secret", "list", "--global"], {
    stdout: listStdout,
    stderr: capture(),
    fetchImpl: fakeFetch({
      "GET /api/secure-input/secrets": {
        ok: true,
        secrets: [{ handle: "secret://global/openai/api-key", scope: "global", status: "configured" }],
      },
    }, listSeen),
  });
  assert.equal(listCode, 0);
  assert.equal(listSeen[0].search, "?scope=global");
  assert.match(listStdout.text(), /secret:\/\/global\/openai\/api-key/);

  const deleteStdout = capture();
  const deleteSeen = [];
  const deleteCode = await runCli(["secret", "delete", "openai/api-key", "--user", "alice"], {
    stdout: deleteStdout,
    stderr: capture(),
    fetchImpl: fakeFetch({
      "DELETE /api/secure-input/secrets/openai%2Fapi-key": {
        ok: true,
        secret: { handle: "secret://user/alice/openai/api-key" },
      },
    }, deleteSeen),
  });
  assert.equal(deleteCode, 0);
  assert.equal(deleteSeen[0].search, "?scope=user&userId=alice");
  assert.match(deleteStdout.text(), /secret:\/\/user\/alice\/openai\/api-key/);

  const ttyStdout = capture();
  const ttySeen = [];
  const ttyCode = await runCli(["secret", "set", "gmail/client-secret", "--user", "alice", "--json"], {
    stdout: ttyStdout,
    stderr: capture(),
    readSecretValue: async () => "tty-secret-value",
    fetchImpl: fakeFetch({
      "POST /api/secure-input/secrets": {
        ok: true,
        secret: {
          handle: "secret://user/alice/gmail/client-secret",
          scope: "user",
          ownerUserId: "alice",
          status: "configured",
        },
      },
    }, ttySeen),
  });
  assert.equal(ttyCode, 0);
  assert.deepEqual(ttySeen[0].body, {
    scope: "user",
    userId: "alice",
    name: "gmail/client-secret",
    value: "tty-secret-value",
  });
  assert.equal(ttyStdout.text().includes("tty-secret-value"), false);
});

test("CLI rejects inline secure input values so they do not enter shell history", async () => {
  const stderr = capture();
  const code = await runCli(["secret", "set", "openai/api-key", "--value", "super-secret-value"], {
    stdout: capture(),
    stderr,
    fetchImpl: fakeFetch({}),
  });

  assert.equal(code, 1);
  assert.match(stderr.text(), /secret_value_flag_disabled/);
});

test("CLI lists timers from the public API", async () => {
  const stdout = capture();
  const code = await runCli(["timers"], {
    stdout,
    stderr: capture(),
    fetchImpl: fakeFetch({
      "GET /api/timers": {
        timers: [{ id: "timer-1", label: "Daily", target: "thread-1", cadence: "daily", nextRunAt: "2026-05-15T09:00:00.000Z" }],
      },
    }),
  });

  assert.equal(code, 0);
  assert.match(stdout.text(), /Daily/);
  assert.match(stdout.text(), /thread-1/);
});

test("CLI runs Gmail jobs poll through the server API", async () => {
  const stdout = capture();
  const seen = [];
  const code = await runCli([
    "jobs",
    "run",
    "--owner-user-id",
    "firat",
    "--target-thread",
    "firat-jobs",
    "--max-results",
    "5",
    "--gmail-source",
    "oauth",
    "--no-gog-fallback",
  ], {
    stdout,
    stderr: capture(),
    fetchImpl: fakeFetch({
      "POST /api/jobs/run": {
        ok: true,
        collected: 2,
        upserted: { created: [{ id: "job-1" }] },
        classified: { classified: [{ id: "job-1" }] },
        presentation: { presented: [] },
      },
    }, seen),
  });

  assert.equal(code, 0);
  assert.deepEqual(seen[0].body, {
    ownerUserId: "firat",
    targetThreadId: "firat-jobs",
    gmailSource: "oauth",
    maxResults: 5,
    present: true,
    gogFallback: false,
  });
  assert.match(stdout.text(), /Collected: 2/);
  assert.match(stdout.text(), /Created: 1/);
  assert.match(stdout.text(), /Classified: 1/);
  assert.match(stdout.text(), /Presented: 0/);
});

test("CLI doctors timers through the public API", async () => {
  const stdout = capture();
  const code = await runCli(["doctor", "timers"], {
    stdout,
    stderr: capture(),
    fetchImpl: fakeFetch({
      "GET /api/timers/doctor": {
        ok: true,
        status: "ok",
        summary: "1 timer checked.",
        storeExists: true,
        counts: { total: 1, enabled: 1, disabled: 0, due: 0, errors: 0, warnings: 0 },
        issues: [],
      },
    }),
  });

  assert.equal(code, 0);
  assert.match(stdout.text(), /Timers: ok/);
  assert.match(stdout.text(), /1 timer checked/);
});

test("CLI doctors the host system by default", async () => {
  const stdout = capture();
  const code = await runCli(["doctor"], {
    stdout,
    stderr: capture(),
    fetchImpl: fakeFetch({
      "GET /api/system/doctor": {
        ok: true,
        status: "ok",
        summary: "All system checks passed.",
        counts: { total: 2, ok: 2, warnings: 0, errors: 0 },
        issues: [],
      },
    }),
  });

  assert.equal(code, 0);
  assert.match(stdout.text(), /System: ok/);
  assert.match(stdout.text(), /All system checks passed/);
});

test("CLI repairs runtime resources through the public API", async () => {
  const stdout = capture();
  const seen = [];
  const code = await runCli(["doctor", "resources", "--repair"], {
    stdout,
    stderr: capture(),
    fetchImpl: fakeFetch({
      "POST /api/system/resources/repair": {
        ok: true,
        status: "ok",
        summary: "Repaired 1 runtime resource issue(s).",
        counts: { activeLeases: 0, tmuxSessions: 1, orphanSessions: 1, tempCodexProcesses: 0, issues: 0, repaired: 1 },
        issues: [],
        actions: [{ action: "killed_tmux_session", sessionName: "orkestr-mode-test" }],
      },
    }, seen),
  });

  assert.equal(code, 0);
  assert.equal(seen[0].key, "POST /api/system/resources/repair");
  assert.match(stdout.text(), /Runtime resources: ok/);
  assert.match(stdout.text(), /killed_tmux_session/);
});

test("CLI timer doctor exits nonzero for broken timers", async () => {
  const stdout = capture();
  const code = await runCli(["timers", "doctor"], {
    stdout,
    stderr: capture(),
    fetchImpl: fakeFetch({
      "GET /api/timers/doctor": {
        ok: false,
        status: "broken",
        summary: "1 timer problem needs attention.",
        storeExists: true,
        counts: { total: 1, enabled: 1, disabled: 0, due: 1, errors: 1, warnings: 0 },
        issues: [{ severity: "error", code: "missing_thread_target", timerLabel: "Broken", message: "Timer targets a thread that does not exist." }],
      },
    }),
  });

  assert.equal(code, 1);
  assert.match(stdout.text(), /Timers: broken/);
  assert.match(stdout.text(), /missing_thread_target/);
});

test("CLI lists and approves browser pairing challenges from local state", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-cli-security-"));
  const env = { ...process.env, ORKESTR_HOME: home };
  const challenge = await createPairingChallenge({ env });
  const listOut = capture();
  const approveOut = capture();

  const listCode = await runCli(["security", "challenges", "--json"], {
    env,
    stdout: listOut,
    stderr: capture(),
  });
  assert.equal(listCode, 0);
  assert.match(listOut.text(), new RegExp(challenge.challengeId));
  assert.match(listOut.text(), /pending/);

  const approveCode = await runCli(["security", "approve", challenge.challengeId], {
    env,
    stdout: approveOut,
    stderr: capture(),
  });
  assert.equal(approveCode, 0);
  assert.match(approveOut.text(), /Approved pairing challenge/);
  assert.equal((await getPairingChallenge(challenge.challengeId, { env })).status, "approved");
});

test("CLI connect approve accepts short browser pairing codes", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-cli-connect-approve-"));
  const env = { ...process.env, ORKESTR_HOME: home };
  const challenge = await createPairingChallenge({ env });
  const approveOut = capture();

  const approveCode = await runCli(["connect", "approve", challenge.challenge.approveCode], {
    env,
    stdout: approveOut,
    stderr: capture(),
  });

  assert.equal(approveCode, 0);
  assert.match(approveOut.text(), new RegExp(challenge.challenge.approveCode));
  assert.equal((await getPairingChallenge(challenge.challengeId, { env })).status, "approved");
});

test("CLI lists and revokes browser pairing sessions from local state", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-cli-security-sessions-"));
  const env = { ...process.env, ORKESTR_HOME: home };
  const challenge = await createPairingChallenge({ env });
  await approvePairingChallenge(challenge.challengeId, { env });
  const paired = await pairBrowser({ challengeId: challenge.challengeId, userAgent: "node:test", env });

  const listOut = capture();
  const listCode = await runCli(["security", "sessions", "--json"], {
    env,
    stdout: listOut,
    stderr: capture(),
  });
  const sessionsPayload = JSON.parse(listOut.text());
  assert.equal(listCode, 0);
  assert.equal(sessionsPayload.sessions[0].id, paired.session.id);
  assert.equal(sessionsPayload.sessions[0].tokenHash, undefined);

  const revokeOut = capture();
  const revokeCode = await runCli(["security", "revoke", paired.session.id], {
    env,
    stdout: revokeOut,
    stderr: capture(),
  });
  assert.equal(revokeCode, 0);
  assert.match(revokeOut.text(), /Revoked 1 browser session/);

  const emptyOut = capture();
  await runCli(["security", "sessions", "--json"], {
    env,
    stdout: emptyOut,
    stderr: capture(),
  });
  assert.deepEqual(JSON.parse(emptyOut.text()).sessions, []);
});

test("CLI sends input with Orkestr command parsing enabled", async () => {
  const stdout = capture();
  const seen = [];
  const code = await runCli(["send", "Demo", "/now", "ship", "it"], {
    stdout,
    stderr: capture(),
    fetchImpl: fakeFetch({
      "POST /api/threads/Demo/input": { ok: true, queued: true, orkestrThreadId: "thread-1" },
    }, seen),
  });

  assert.equal(code, 0);
  assert.equal(seen[0].body.text, "/now ship it");
  assert.equal(seen[0].body.parseCommands, true);
  assert.equal(seen[0].body.controlAllowed, true);
  assert.match(stdout.text(), /Queued thread-1/);
});

test("CLI creates threads through the public API", async () => {
  const stdout = capture();
  const seen = [];
  const code = await runCli(["thread", "create", "Demo Thread", "--id", "demo-thread", "--cwd", "/repo", "--command", "codex", "--executor", "codex"], {
    stdout,
    stderr: capture(),
    fetchImpl: fakeFetch({
      "POST /api/threads": { thread: { id: "demo-thread", name: "Demo Thread" } },
    }, seen),
  });

  assert.equal(code, 0);
  assert.deepEqual(seen[0].body, {
    name: "Demo Thread",
    id: "demo-thread",
    cwd: "/repo",
    command: "codex",
    executorId: "codex",
  });
  assert.match(stdout.text(), /Created Demo Thread/);
});

test("CLI creates Orkestr threads with integrated WhatsApp binding", async () => {
  const stdout = capture();
  const seen = [];
  const code = await runCli([
    "create",
    "Project Fitness",
    "--wa-title",
    "Project Fitness",
    "--wa-participant",
    "wa-contact-alice@c.us",
    "--outbound-account",
    "responder",
    "--json",
  ], {
    stdout,
    stderr: capture(),
    fetchImpl: fakeFetch({
      "POST /api/connectors/whatsapp/bridge/chats": {
        ok: true,
        chat: { id: "wa-group-zero@g.us", name: "Project Fitness", generated: true },
        senderContactId: "wa-contact-alice@c.us",
        responderContactId: "wa-contact-bob@c.us",
        responderAccountId: "responder",
      },
      "POST /api/threads": { thread: { id: "thread-fitness", name: "Project Fitness", state: "sleeping" } },
      "PUT /api/threads/thread-fitness/binding": { ok: true, binding: { chatId: "wa-group-zero@g.us" } },
    }, seen),
  });

  assert.equal(code, 0);
  assert.equal(seen[0].key, "POST /api/connectors/whatsapp/bridge/chats");
  assert.deepEqual(seen[0].body, {
    name: "Project Fitness",
    participantIds: ["wa-contact-alice@c.us"],
    promoteParticipantsAsAdmins: true,
    replyAccountId: "responder",
    bridgeAccountId: "responder",
    responderAccountId: "responder",
    outboundAccountId: "responder",
  });
  assert.equal(seen[1].key, "POST /api/threads");
  assert.deepEqual(seen[1].body, { name: "Project Fitness" });
  assert.equal(seen[2].key, "PUT /api/threads/thread-fitness/binding");
  assert.equal(seen[2].body.chatId, "wa-group-zero@g.us");
  assert.equal(seen[2].body.generated, true);
  assert.equal(seen[2].body.senderContactId, "wa-contact-alice@c.us");
  assert.equal(seen[2].body.responderContactId, "wa-contact-bob@c.us");
  assert.match(stdout.text(), /"ok": true/);
});

test("CLI binds an existing thread to a generated WhatsApp group", async () => {
  const stdout = capture();
  const seen = [];
  const code = await runCli([
    "whatsapp",
    "bind-thread",
    "sample-linkedin",
    "--name",
    "Sample-Linkedin",
    "--wa-participant",
    "wa-contact-primary@c.us",
    "--outbound-account",
    "account-1",
    "--json",
  ], {
    stdout,
    stderr: capture(),
    fetchImpl: fakeFetch({
      "POST /api/connectors/whatsapp/thread-groups": {
        ok: true,
        created: true,
        chat: { id: "wa-group-two@g.us", name: "Sample-Linkedin" },
        thread: { id: "sample-linkedin" },
        binding: { displayName: "Sample-Linkedin", chatId: "wa-group-two@g.us" },
      },
    }, seen),
  });

  assert.equal(code, 0);
  assert.deepEqual(seen.map((entry) => entry.key), ["POST /api/connectors/whatsapp/thread-groups"]);
  assert.deepEqual(seen[0].body, {
    threadId: "sample-linkedin",
    name: "Sample-Linkedin",
    participantIds: ["wa-contact-primary@c.us"],
    adminParticipantIds: [],
    promoteParticipantsAsAdmins: true,
    generatePicture: true,
    mirrorToWhatsApp: true,
    forceNew: false,
    replyAccountId: "account-1",
    bridgeAccountId: "account-1",
    responderAccountId: "account-1",
    outboundAccountId: "account-1",
  });
  assert.match(stdout.text(), /Sample-Linkedin/);
});

test("CLI lists neutral WhatsApp accounts", async () => {
  const stdout = capture();
  const seen = [];
  const code = await runCli(["whatsapp", "accounts", "list"], {
    stdout,
    stderr: capture(),
    fetchImpl: fakeFetch({
      "GET /api/connectors/whatsapp/accounts": {
        accounts: [
          { accountId: "neutral-1", state: "ready", ready: true, legacyRoleAliases: [], nextAction: "none" },
          { accountId: "responder", state: "idle", ready: false, legacyRoleAliases: ["responder"], nextAction: "pair_account" },
        ],
      },
    }, seen),
  });

  assert.equal(code, 0);
  assert.deepEqual(seen.map((entry) => entry.key), ["GET /api/connectors/whatsapp/accounts"]);
  assert.match(stdout.text(), /neutral-1/);
  assert.match(stdout.text(), /responder/);
  assert.match(stdout.text(), /pair_account/);
});

test("CLI starts a WhatsApp account pairing session", async () => {
  const stdout = capture();
  const seen = [];
  const code = await runCli(["whatsapp", "accounts", "pair", "neutral-1", "--phone", "+491234", "--json"], {
    stdout,
    stderr: capture(),
    fetchImpl: fakeFetch({
      "POST /api/connectors/whatsapp/accounts/neutral-1/pairing-session": {
        ok: true,
        account: { accountId: "neutral-1", state: "qr_required", qrRequired: true, qrAvailable: true },
        pairing: { state: "qr_required", qrRequired: true, qrAvailable: true, qrUrl: "/api/connectors/whatsapp/bridge/qr.svg?accountId=neutral-1" },
      },
    }, seen),
  });

  assert.equal(code, 0);
  assert.equal(seen[0].key, "POST /api/connectors/whatsapp/accounts/neutral-1/pairing-session");
  assert.deepEqual(seen[0].body, { phoneNumber: "+491234" });
  assert.equal(JSON.parse(stdout.text()).pairing.qrRequired, true);
});

test("CLI prints WhatsApp phone pairing codes in text mode", async () => {
  const stdout = capture();
  const seen = [];
  const code = await runCli(["whatsapp", "accounts", "pair", "neutral-1", "--phone", "+491234"], {
    stdout,
    stderr: capture(),
    fetchImpl: fakeFetch({
      "POST /api/connectors/whatsapp/accounts/neutral-1/pairing-session": {
        ok: true,
        account: { accountId: "neutral-1", state: "pairing_code", pairingCode: "123-45678", pairingPhoneNumber: "***1234", nextAction: "enter_pairing_code" },
        pairing: { state: "pairing_code", pairingCode: "123-45678", pairingPhoneNumber: "***1234", qrRequired: false, qrAvailable: false, nextAction: "enter_pairing_code" },
      },
    }, seen),
  });

  assert.equal(code, 0);
  assert.equal(seen[0].key, "POST /api/connectors/whatsapp/accounts/neutral-1/pairing-session");
  assert.match(stdout.text(), /Code: 123-45678/);
  assert.match(stdout.text(), /Phone: \*\*\*1234/);
  assert.match(stdout.text(), /Next: enter_pairing_code/);
});

test("CLI disconnects WhatsApp accounts through the lifecycle API", async () => {
  const stdout = capture();
  const seen = [];
  const code = await runCli(["whatsapp", "accounts", "disconnect", "neutral-1", "--json"], {
    stdout,
    stderr: capture(),
    fetchImpl: fakeFetch({
      "POST /api/connectors/whatsapp/accounts/neutral-1/disconnect": {
        ok: true,
        account: { accountId: "neutral-1", state: "idle", ready: false },
      },
    }, seen),
  });

  assert.equal(code, 0);
  assert.equal(seen[0].key, "POST /api/connectors/whatsapp/accounts/neutral-1/disconnect");
  assert.equal(JSON.parse(stdout.text()).account.state, "idle");
});

test("CLI lists WhatsApp connector outbox jobs", async () => {
  const stdout = capture();
  const seen = [];
  const code = await runCli(["whatsapp", "outbox", "--state", "failed_retryable", "--tenant", "tenant-a"], {
    stdout,
    stderr: capture(),
    fetchImpl: fakeFetch({
      "GET /api/connectors/whatsapp/outbox": {
        ok: true,
        jobs: [
          { id: "co_1", state: "failed_retryable", tenantId: "tenant-a", accountId: "wa-1", chatId: "chat-1", threadId: "thread-1", deliveryType: "final", updatedAt: "2026-06-07T12:00:00.000Z", error: "bridge_down" },
        ],
      },
    }, seen),
  });

  assert.equal(code, 0);
  assert.equal(seen[0].key, "GET /api/connectors/whatsapp/outbox");
  assert.equal(seen[0].search, "?state=failed_retryable&tenantId=tenant-a");
  assert.match(stdout.text(), /co_1/);
  assert.match(stdout.text(), /failed_retryable/);
});

test("CLI applies WhatsApp connector outbox actions", async () => {
  const stdout = capture();
  const seen = [];
  const code = await runCli(["whatsapp", "outbox", "replay", "co_1", "--reason", "operator replay"], {
    stdout,
    stderr: capture(),
    fetchImpl: fakeFetch({
      "POST /api/connectors/whatsapp/outbox/co_1/replay": {
        ok: true,
        action: "replay",
        previousState: "delivered",
        job: { id: "co_1", state: "pending" },
        whatsapp: { ok: true, matchedIntents: 1, removedDeliveries: 1 },
      },
    }, seen),
  });

  assert.equal(code, 0);
  assert.equal(seen[0].key, "POST /api/connectors/whatsapp/outbox/co_1/replay");
  assert.deepEqual(seen[0].body, { reason: "operator replay" });
  assert.match(stdout.text(), /delivered -> pending/);
  assert.match(stdout.text(), /intents=1/);
});

test("CLI applies bulk WhatsApp connector outbox actions", async () => {
  const stdout = capture();
  const seen = [];
  const code = await runCli(["whatsapp", "outbox", "suppress", "co_1", "co_2", "--reason", "stale"], {
    stdout,
    stderr: capture(),
    fetchImpl: fakeFetch({
      "POST /api/connectors/whatsapp/outbox/actions": {
        ok: true,
        action: "suppress",
        count: 2,
        results: [
          { ok: true, action: "suppress", previousState: "pending", job: { id: "co_1", state: "suppressed" }, whatsapp: { matchedIntents: 1, removedDeliveries: 0 } },
          { ok: true, action: "suppress", previousState: "failed_retryable", job: { id: "co_2", state: "suppressed" }, whatsapp: { matchedIntents: 0, removedDeliveries: 0 } },
        ],
      },
    }, seen),
  });

  assert.equal(code, 0);
  assert.equal(seen[0].key, "POST /api/connectors/whatsapp/outbox/actions");
  assert.deepEqual(seen[0].body, { reason: "stale", action: "suppress", jobIds: ["co_1", "co_2"] });
  assert.match(stdout.text(), /co_1/);
  assert.match(stdout.text(), /co_2/);
});

test("CLI doctors WhatsApp accounts through the lifecycle API", async () => {
  const stdout = capture();
  const seen = [];
  const code = await runCli(["whatsapp", "doctor", "--account", "neutral-1", "--json"], {
    stdout,
    stderr: capture(),
    fetchImpl: fakeFetch({
      "GET /api/connectors/whatsapp/doctor": {
        ok: true,
        status: "ok",
        counts: { ok: 2, warnings: 0, errors: 0 },
        accounts: [{ accountId: "neutral-1", ready: true }],
        bindings: [{ id: "thread:thread-1:whatsapp", state: "ready" }],
      },
    }, seen),
  });

  assert.equal(code, 0);
  assert.equal(seen[0].key, "GET /api/connectors/whatsapp/doctor");
  assert.equal(seen[0].search, "?account=neutral-1");
  assert.equal(JSON.parse(stdout.text()).status, "ok");
});

test("CLI runs invariant WhatsApp/router doctor with repair options", async () => {
  const stdout = capture();
  const seen = [];
  const code = await runCli(["doctor", "whatsapp", "--thread", "otcanClaw-features", "--repair", "--stale-ms", "45000", "--json"], {
    stdout,
    stderr: capture(),
    fetchImpl: fakeFetch({
      "GET /api/router-traces/doctor/whatsapp": {
        ok: false,
        status: "broken",
        summary: "1 router/WhatsApp invariant error detected.",
        checks: [{ code: "queue_notice_without_runtime_delivery", severity: "error", threadId: "otcanClaw-features" }],
        repairs: [],
      },
    }, seen),
  });

  assert.equal(code, 1);
  assert.equal(seen[0].key, "GET /api/router-traces/doctor/whatsapp");
  assert.equal(seen[0].search, "?thread=otcanClaw-features&repair=1&staleMs=45000");
  assert.equal(JSON.parse(stdout.text()).checks[0].code, "queue_notice_without_runtime_delivery");
});

test("CLI runs router trace doctor by trace id", async () => {
  const stdout = capture();
  const seen = [];
  const code = await runCli(["doctor", "router", "--trace", "rt_123"], {
    stdout,
    stderr: capture(),
    fetchImpl: fakeFetch({
      "GET /api/router-traces/doctor/whatsapp": {
        ok: true,
        status: "ok",
        summary: "WhatsApp/router invariants passed.",
        checks: [],
        repairs: [],
      },
    }, seen),
  });

  assert.equal(code, 0);
  assert.equal(seen[0].key, "GET /api/router-traces/doctor/whatsapp");
  assert.equal(seen[0].search, "?trace=rt_123");
  assert.match(stdout.text(), /invariants passed/i);
});

test("CLI adds and updates neutral WhatsApp accounts", async () => {
  const stdout = capture();
  const seen = [];
  const code = await runCli(["whatsapp", "accounts", "add", "--id", "user-wa", "--display-name", "User WA", "--owner", "alice", "--json"], {
    stdout,
    stderr: capture(),
    fetchImpl: fakeFetch({
      "POST /api/connectors/whatsapp/accounts": {
        ok: true,
        account: { accountId: "user-wa", displayName: "User WA", ownerUserId: "alice" },
      },
    }, seen),
  });

  assert.equal(code, 0);
  assert.equal(seen[0].key, "POST /api/connectors/whatsapp/accounts");
  assert.deepEqual(seen[0].body, { accountId: "user-wa", displayName: "User WA", ownerUserId: "alice" });
  assert.equal(JSON.parse(stdout.text()).account.ownerUserId, "alice");

  const stdout2 = capture();
  const seen2 = [];
  const updateCode = await runCli(["whatsapp", "accounts", "update", "user-wa", "--display-name", "Renamed WA"], {
    stdout: stdout2,
    stderr: capture(),
    fetchImpl: fakeFetch({
      "PUT /api/connectors/whatsapp/accounts/user-wa": {
        ok: true,
        account: { accountId: "user-wa", displayName: "Renamed WA" },
      },
    }, seen2),
  });
  assert.equal(updateCode, 0);
  assert.deepEqual(seen2[0].body, { displayName: "Renamed WA" });
  assert.match(stdout2.text(), /Renamed WA/);
});

test("CLI resolves active WhatsApp bindings", async () => {
  const stdout = capture();
  const seen = [];
  const code = await runCli(["whatsapp", "bindings", "resolve", "--thread", "thread-1"], {
    stdout,
    stderr: capture(),
    fetchImpl: fakeFetch({
      "GET /api/connectors/whatsapp/bindings/resolve": {
        ok: true,
        selected: {
          id: "thread:thread-1:whatsapp",
          state: "ready",
          reason: "ready",
          threadName: "Thread 1",
          chatId: "chat-1@g.us",
          responderAccountId: "neutral-1",
          acl: { send: { mode: "all-users" } },
          nextAction: "none",
        },
      },
    }, seen),
  });

  assert.equal(code, 0);
  assert.equal(seen[0].key, "GET /api/connectors/whatsapp/bindings/resolve");
  assert.equal(seen[0].search, "?thread=thread-1");
  assert.match(stdout.text(), /thread:thread-1:whatsapp/);
  assert.match(stdout.text(), /Reply identity: neutral-1/);
});

test("CLI resolves WhatsApp bindings by chat without a positional thread", async () => {
  const stdout = capture();
  const seen = [];
  const code = await runCli(["whatsapp", "bindings", "resolve", "--chat-id", "chat-1@g.us", "--account", "neutral-1", "--json"], {
    stdout,
    stderr: capture(),
    fetchImpl: fakeFetch({
      "GET /api/connectors/whatsapp/bindings/resolve": {
        ok: true,
        selected: {
          id: "thread:thread-1:whatsapp",
          state: "ready",
          threadName: "Thread 1",
          chatId: "chat-1@g.us",
          responderAccountId: "neutral-1",
        },
      },
    }, seen),
  });

  assert.equal(code, 0);
  assert.equal(seen[0].key, "GET /api/connectors/whatsapp/bindings/resolve");
  assert.equal(seen[0].search, "?chatId=chat-1%40g.us&accountId=neutral-1");
  assert.equal(JSON.parse(stdout.text()).selected.chatId, "chat-1@g.us");
});

test("CLI filters active WhatsApp binding lists", async () => {
  const stdout = capture();
  const seen = [];
  const code = await runCli(["whatsapp", "bindings", "list", "--thread", "thread-1", "--user", "alice", "--json"], {
    stdout,
    stderr: capture(),
    fetchImpl: fakeFetch({
      "GET /api/connectors/whatsapp/bindings": {
        bindings: [{ id: "thread:thread-1:whatsapp", level: "thread", state: "ready" }],
      },
    }, seen),
  });

  assert.equal(code, 0);
  assert.equal(seen[0].key, "GET /api/connectors/whatsapp/bindings");
  assert.equal(seen[0].search, "?thread=thread-1&user=alice");
  assert.equal(JSON.parse(stdout.text()).bindings[0].level, "thread");
});

test("CLI creates, updates, and deletes WhatsApp bindings", async () => {
  const stdout = capture();
  const seen = [];
  const code = await runCli([
    "whatsapp",
    "bindings",
    "create",
    "--thread",
    "thread-1",
    "--chat-id",
    "chat-1@g.us",
    "--responder-account",
    "neutral-1",
    "--send-acl",
    "all-users",
  ], {
    stdout,
    stderr: capture(),
    fetchImpl: fakeFetch({
      "POST /api/connectors/whatsapp/bindings": {
        ok: true,
        binding: {
          id: "thread:thread-1:whatsapp",
          state: "inactive",
          reason: "responder_account_inactive",
          threadName: "Thread 1",
          chatId: "chat-1@g.us",
          responderAccountId: "neutral-1",
          acl: { send: { mode: "all-users" } },
          nextAction: "pair_account",
        },
      },
    }, seen),
  });

  assert.equal(code, 0);
  assert.equal(seen[0].key, "POST /api/connectors/whatsapp/bindings");
  assert.deepEqual(seen[0].body, {
    threadId: "thread-1",
    chatId: "chat-1@g.us",
    replyAccountId: "neutral-1",
    bridgeAccountId: "neutral-1",
    responderConnectorAccountId: "neutral-1",
    responderAccountId: "neutral-1",
    acl: { send: { mode: "all-users" } },
  });
  assert.match(stdout.text(), /pair_account/);

  const stdout2 = capture();
  const seen2 = [];
  const updateCode = await runCli(["whatsapp", "bindings", "update", "thread-1", "--responder-account", "neutral-2", "--send-acl", "owner-only"], {
    stdout: stdout2,
    stderr: capture(),
    fetchImpl: fakeFetch({
      "PUT /api/connectors/whatsapp/bindings/thread-1": {
        ok: true,
        binding: {
          id: "thread:thread-1:whatsapp",
          state: "ready",
          threadName: "Thread 1",
          chatId: "chat-1@g.us",
          responderAccountId: "neutral-2",
          acl: { send: { mode: "owner-only" } },
        },
      },
    }, seen2),
  });
  assert.equal(updateCode, 0);
  assert.deepEqual(seen2[0].body, {
    replyAccountId: "neutral-2",
    bridgeAccountId: "neutral-2",
    responderConnectorAccountId: "neutral-2",
    responderAccountId: "neutral-2",
    acl: { send: { mode: "owner-only" } },
  });
  assert.match(stdout2.text(), /neutral-2/);

  const stdout3 = capture();
  const seen3 = [];
  const deleteCode = await runCli(["whatsapp", "bindings", "delete", "thread-1"], {
    stdout: stdout3,
    stderr: capture(),
    fetchImpl: fakeFetch({
      "DELETE /api/connectors/whatsapp/bindings/thread-1": {
        ok: true,
        binding: { id: "thread:thread-1:whatsapp", state: "disabled", reason: "binding_not_route_eligible" },
      },
    }, seen3),
  });
  assert.equal(deleteCode, 0);
  assert.equal(seen3[0].key, "DELETE /api/connectors/whatsapp/bindings/thread-1");
});

test("CLI creates multi-level WhatsApp bindings with target selectors", async () => {
  const stdout = capture();
  const seen = [];
  const code = await runCli([
    "whatsapp",
    "bindings",
    "create",
    "--level",
    "account-default",
    "--target-account",
    "neutral-1",
    "--responder-account",
    "neutral-1",
    "--json",
  ], {
    stdout,
    stderr: capture(),
    fetchImpl: fakeFetch({
      "POST /api/connectors/whatsapp/bindings": {
        ok: true,
        binding: {
          id: "account-default:neutral-1:whatsapp",
          level: "account-default",
          state: "ready",
          responderAccountId: "neutral-1",
          targetAccountId: "neutral-1",
        },
      },
    }, seen),
  });

  assert.equal(code, 0);
  assert.equal(seen[0].key, "POST /api/connectors/whatsapp/bindings");
  assert.deepEqual(seen[0].body, {
    level: "account-default",
    targetAccountId: "neutral-1",
    replyAccountId: "neutral-1",
    bridgeAccountId: "neutral-1",
    responderConnectorAccountId: "neutral-1",
    responderAccountId: "neutral-1",
  });
  assert.equal(JSON.parse(stdout.text()).binding.level, "account-default");
});

test("CLI runs WhatsApp broker migration dry runs", async () => {
  const stdout = capture();
  const seen = [];
  const code = await runCli(["whatsapp", "migrate", "--dry-run"], {
    stdout,
    stderr: capture(),
    fetchImpl: fakeFetch({
      "POST /api/connectors/whatsapp/migrate": {
        ok: true,
        dryRun: true,
        migrated: 3,
        counts: {
          accountsCreated: 2,
          accountsUpdated: 0,
          accountsUnchanged: 0,
          threadBindingsUpdated: 1,
          threadBindingsSkipped: 0,
          threadBindingsUnchanged: 0,
          tokenPlansConfigured: 1,
          tokenPlansMissing: 2,
          tokenPlansTotal: 3,
        },
        accounts: [
          { action: "create", accountId: "responder", runtimeAccountId: "responder", autostart: true },
        ],
        threadBindings: [
          {
            action: "update",
            bindingId: "thread:thread-1:whatsapp",
            threadName: "Thread 1",
            responderAccountId: "responder",
            acl: { send: { mode: "owner-only" }, receive: { mode: "thread" } },
          },
        ],
        tokenPlans: [
          {
            tokenId: "wa-bridge-send-thread:thread-1:whatsapp",
            requiredScope: "whatsapp:bridge:send",
            accountId: "responder",
            chatId: "chat-1@g.us",
            tokenConfigured: false,
            token: "[redacted]",
          },
        ],
        rollback: {
          instructions: ["Do not restore old role-naming code paths."],
        },
      },
    }, seen),
  });

  assert.equal(code, 0);
  assert.equal(seen[0].key, "POST /api/connectors/whatsapp/migrate");
  assert.deepEqual(seen[0].body, { dryRun: true });
  assert.match(stdout.text(), /WhatsApp migration: dry run/);
  assert.match(stdout.text(), /Migrated: 3/);
  assert.match(stdout.text(), /Account plans:/);
  assert.match(stdout.text(), /Binding plans:/);
  assert.match(stdout.text(), /acl\(send=owner-only receive=thread\)/);
  assert.match(stdout.text(), /Scoped token plans:/);
  assert.match(stdout.text(), /token=\[redacted\]/);
  assert.match(stdout.text(), /Do not restore old role-naming code paths/);
});

test("CLI reports Codex WhatsApp binding status", async () => {
  const stdout = capture();
  const seen = [];
  const code = await runCli(["whatsapp", "codex", "status", "--thread", "thread-1", "--json"], {
    stdout,
    stderr: capture(),
    fetchImpl: fakeFetch({
      "GET /api/connectors/whatsapp/codex/status": {
        ok: false,
        thread: "thread-1",
        resolution: {
          ok: false,
          error: "responder_account_inactive",
          selected: { id: "thread:thread-1:whatsapp", state: "inactive", nextAction: "pair_account" },
        },
      },
    }, seen),
  });

  assert.equal(code, 1);
  assert.equal(seen[0].search, "?thread=thread-1");
  assert.equal(JSON.parse(stdout.text()).resolution.error, "responder_account_inactive");
});

test("CLI connects Codex WhatsApp binding to a responder account", async () => {
  const stdout = capture();
  const seen = [];
  const code = await runCli(["whatsapp", "codex", "connect", "--thread", "thread-1", "--account", "neutral-1", "--chat-id", "chat-1@g.us", "--json"], {
    stdout,
    stderr: capture(),
    fetchImpl: fakeFetch({
      "POST /api/connectors/whatsapp/codex/connect": {
        ok: true,
        binding: { id: "thread:thread-1:whatsapp", level: "thread", responderAccountId: "neutral-1" },
        resolution: {
          ok: true,
          selected: { id: "thread:thread-1:whatsapp", level: "thread", state: "ready", responderAccountId: "neutral-1" },
        },
      },
    }, seen),
  });

  assert.equal(code, 0);
  assert.equal(seen[0].key, "POST /api/connectors/whatsapp/codex/connect");
  assert.deepEqual(seen[0].body, {
    thread: "thread-1",
    accountId: "neutral-1",
    chatId: "chat-1@g.us",
  });
  assert.equal(JSON.parse(stdout.text()).resolution.selected.responderAccountId, "neutral-1");
});

test("CLI applies configured WhatsApp chat-name and reply prefixes", async () => {
  const previousNamePrefix = process.env.ORKESTR_WHATSAPP_CHAT_NAME_PREFIX;
  const previousReplyPrefix = process.env.ORKESTR_WHATSAPP_REPLY_PREFIX;
  process.env.ORKESTR_WHATSAPP_CHAT_NAME_PREFIX = "acme";
  process.env.ORKESTR_WHATSAPP_REPLY_PREFIX = "agent:";

  try {
    const stdout = capture();
    const seen = [];
    const code = await runCli([
      "create",
      "easylab",
      "--wa-participant",
      "wa-contact-alice@c.us",
      "--json",
    ], {
      stdout,
      stderr: capture(),
      fetchImpl: fakeFetch({
        "POST /api/connectors/whatsapp/bridge/chats": {
          ok: true,
          chat: { id: "wa-group-one@g.us", name: "acme-easylab", generated: true },
        },
        "POST /api/threads": { thread: { id: "thread-easylab", name: "acme-easylab", state: "sleeping" } },
        "PUT /api/threads/thread-easylab/binding": { ok: true, binding: { chatId: "wa-group-one@g.us" } },
      }, seen),
    });

    assert.equal(code, 0);
    assert.equal(seen[0].body.name, "acme-easylab");
    assert.deepEqual(seen[1].body, { name: "acme-easylab" });
    assert.equal(seen[2].body.displayName, "acme-easylab");
    assert.equal(seen[2].body.replyPrefix, "agent:");
  } finally {
    if (previousNamePrefix === undefined) delete process.env.ORKESTR_WHATSAPP_CHAT_NAME_PREFIX;
    else process.env.ORKESTR_WHATSAPP_CHAT_NAME_PREFIX = previousNamePrefix;
    if (previousReplyPrefix === undefined) delete process.env.ORKESTR_WHATSAPP_REPLY_PREFIX;
    else process.env.ORKESTR_WHATSAPP_REPLY_PREFIX = previousReplyPrefix;
  }
});

test("CLI can create Orkestr threads without WhatsApp", async () => {
  const stdout = capture();
  const seen = [];
  const code = await runCli(["create", "Local Only", "--no-wa"], {
    stdout,
    stderr: capture(),
    fetchImpl: fakeFetch({
      "POST /api/threads": { thread: { id: "local-only", name: "Local Only", state: "sleeping" } },
    }, seen),
  });

  assert.equal(code, 0);
  assert.deepEqual(seen.map((item) => item.key), ["POST /api/threads"]);
  assert.match(stdout.text(), /Created Orkestr thread: Local Only/);
});

test("CLI creates worker threads with task metadata", async () => {
  const stdout = capture();
  const seen = [];
  const code = await runCli(["worker", "create", "Parent", "--task", "Build this", "--label", "Worker A", "--repo", "/repo", "--branch", "orkestr/parent/worker-a"], {
    stdout,
    stderr: capture(),
    fetchImpl: fakeFetch({
      "POST /api/threads/Parent/workers": { worker: { id: "worker-1", bindingName: "Parent-Worker-A" } },
    }, seen),
  });

  assert.equal(code, 0);
  assert.deepEqual(seen[0].body, {
    task: "Build this",
    label: "Worker A",
    repoPath: "/repo",
    branchName: "orkestr/parent/worker-a",
  });
  assert.match(stdout.text(), /Created Parent-Worker-A/);
});

test("CLI creates blank workers and can disable wake", async () => {
  const stdout = capture();
  const seen = [];
  const code = await runCli(["worker", "create", "Parent", "--blank", "--no-wake", "--json"], {
    stdout,
    stderr: capture(),
    fetchImpl: fakeFetch({
      "POST /api/threads/Parent/workers": { worker: { id: "worker-blank", bindingName: "Parent-Worker-Blank" } },
    }, seen),
  });

  assert.equal(code, 0);
  assert.deepEqual(seen[0].body, { autoRun: false, wake: false });
  assert.match(stdout.text(), /"id": "worker-blank"/);
});

test("CLI reports inputs waiting for runtime acknowledgement", async () => {
  const stdout = capture();
  const code = await runCli(["send", "Demo", "ship", "it"], {
    stdout,
    stderr: capture(),
    fetchImpl: fakeFetch({
      "POST /api/threads/Demo/input": { ok: true, queued: true, deliveryState: "awaiting_ack", orkestrThreadId: "thread-1" },
    }),
  });

  assert.equal(code, 0);
  assert.match(stdout.text(), /Awaiting ack thread-1/);
});

test("CLI resets threads through the public API", async () => {
  const resetOut = capture();
  const hardResetOut = capture();
  const safeResetOut = capture();
  const seen = [];
  const routes = {
    "POST /api/threads/Demo/reset": { ok: true, reset: true },
    "POST /api/threads/Demo/hard-reset": { ok: true, reset: true, hardReset: true },
    "POST /api/threads/Demo/safe-reset": { ok: true, reset: true, safeReset: true },
  };

  const resetCode = await runCli(["--api", "http://orkestr.test", "reset", "Demo"], {
    stdout: resetOut,
    stderr: capture(),
    fetchImpl: fakeFetch(routes, seen),
  });
  const hardResetCode = await runCli(["--api", "http://orkestr.test", "hard-reset", "Demo"], {
    stdout: hardResetOut,
    stderr: capture(),
    fetchImpl: fakeFetch(routes, seen),
  });
  const safeResetCode = await runCli(["--api", "http://orkestr.test", "safe-reset", "Demo"], {
    stdout: safeResetOut,
    stderr: capture(),
    fetchImpl: fakeFetch(routes, seen),
  });

  assert.equal(resetCode, 0);
  assert.equal(hardResetCode, 0);
  assert.equal(safeResetCode, 0);
  assert.deepEqual(seen.map((entry) => entry.key), [
    "POST /api/threads/Demo/reset",
    "POST /api/threads/Demo/hard-reset",
    "POST /api/threads/Demo/safe-reset",
  ]);
  assert.match(resetOut.text(), /Reset Demo/);
  assert.match(hardResetOut.text(), /Hard reset Demo/);
  assert.match(safeResetOut.text(), /Safe reset Demo/);
});

test("CLI update can run the versioned release deployer", async () => {
  const stdout = capture();
  const spawned = [];
  const code = await runCli(["update", "--release", "--ref", "v0.1.0-alpha.10", "--channel", "stage", "--no-smoke"], {
    env: {},
    stdout,
    stderr: capture(),
    spawnImpl(command, args, options) {
      spawned.push({ command, args, env: options.env });
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 0));
      return child;
    },
  });

  assert.equal(code, 0);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].command, "bash");
  assert.match(spawned[0].args[0], /scripts\/deploy-git-release\.sh$/);
  assert.deepEqual(spawned[0].args.slice(1), ["install", "--ref", "v0.1.0-alpha.10", "--channel", "stage", "--no-smoke", "--all-instances"]);
  assert.equal(spawned[0].env.ORKESTR_RELEASE_DEPLOY, "1");
  assert.equal(spawned[0].env.ORKESTR_RELEASE_TRAIN_FANOUT, "1");
  assert.equal(spawned[0].env.ORKESTR_DEPLOY_REF, "v0.1.0-alpha.10");
  assert.equal(spawned[0].env.ORKESTR_DEPLOY_CHANNEL, "stage");
  assert.match(stdout.text(), /versioned release update for v0\.1\.0-alpha\.10/);
});

test("CLI update escapes the target systemd service cgroup for release deploys", async () => {
  const stdout = capture();
  const spawned = [];
  const code = await runCli(["update", "--release", "--ref", "main", "--allow-untagged", "--no-smoke"], {
    env: {
      ORKESTR_SERVICE_NAME: "orkestr-ui",
      ORKESTR_TEST_PROC_CGROUP: "0::/system.slice/orkestr-ui.service",
      ORKESTR_RELEASE_REQUIRED_WHATSAPP_ACCOUNTS: "sender",
      PATH: "/usr/bin",
    },
    stdout,
    stderr: capture(),
    spawnImpl(command, args, options) {
      spawned.push({ command, args, env: options.env });
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 0));
      return child;
    },
  });

  assert.equal(code, 0);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].command, "systemd-run");
  assert.ok(spawned[0].args.includes("--collect"));
  assert.ok(spawned[0].args.includes("--same-dir"));
  assert.ok(!spawned[0].args.includes("--wait"));
  assert.ok(!spawned[0].args.includes("--pipe"));
  assert.ok(spawned[0].args.some((arg) => arg.startsWith("--unit=orkestr-release-")));
  assert.ok(spawned[0].args.includes("--setenv=ORKESTR_SERVICE_NAME=orkestr-ui"));
  assert.ok(spawned[0].args.includes("--setenv=ORKESTR_RELEASE_REQUIRED_WHATSAPP_ACCOUNTS=sender"));
  assert.ok(spawned[0].args.includes("--setenv=ORKESTR_UPDATE_SYSTEMD_RUN=0"));
  assert.ok(!spawned[0].args.some((arg) => arg.includes("ORKESTR_TEST_PROC_CGROUP")));
  const bashIndex = spawned[0].args.indexOf("bash");
  assert.notEqual(bashIndex, -1);
  assert.match(spawned[0].args[bashIndex + 1], /scripts\/deploy-git-release\.sh$/);
  assert.deepEqual(spawned[0].args.slice(bashIndex + 2), ["install", "--ref", "main", "--allow-untagged", "--no-smoke", "--all-instances"]);
  assert.match(stdout.text(), /outside orkestr-ui\.service/);
  assert.match(stdout.text(), /journalctl -u orkestr-release-/);
});

test("CLI update forwards no-interrupt deploy guard flags", async () => {
  const spawned = [];
  const code = await runCli([
    "update",
    "--release",
    "--ref",
    "main",
    "--allow-untagged",
    "--wait-active",
    "--active-timeout",
    "30",
    "--no-smoke",
  ], {
    env: {},
    stdout: capture(),
    stderr: capture(),
    spawnImpl(command, args, options) {
      spawned.push({ command, args, env: options.env });
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 0));
      return child;
    },
  });

  assert.equal(code, 0);
  assert.equal(spawned.length, 1);
  assert.match(spawned[0].args[0], /scripts\/deploy-git-release\.sh$/);
  assert.deepEqual(spawned[0].args.slice(1), [
    "install",
    "--ref",
    "main",
    "--allow-untagged",
    "--no-smoke",
    "--all-instances",
    "--wait-active",
    "--active-timeout",
    "30",
  ]);
});

test("CLI update forwards release instance fan-out flag", async () => {
  const spawned = [];
  const code = await runCli(["update", "--release", "--ref", "main", "--allow-untagged", "--all-instances", "--no-smoke"], {
    env: {},
    stdout: capture(),
    stderr: capture(),
    spawnImpl(command, args, options) {
      spawned.push({ command, args, env: options.env });
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 0));
      return child;
    },
  });

  assert.equal(code, 0);
  assert.equal(spawned[0].env.ORKESTR_RELEASE_TRAIN_FANOUT, "1");
  assert.deepEqual(spawned[0].args.slice(1), [
    "install",
    "--ref",
    "main",
    "--allow-untagged",
    "--no-smoke",
    "--all-instances",
  ]);
});

test("CLI update can opt out of default release instance fan-out", async () => {
  const spawned = [];
  const code = await runCli(["update", "--release", "--ref", "main", "--allow-untagged", "--no-all-instances", "--no-smoke"], {
    env: {},
    stdout: capture(),
    stderr: capture(),
    spawnImpl(command, args, options) {
      spawned.push({ command, args, env: options.env });
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 0));
      return child;
    },
  });

  assert.equal(code, 0);
  assert.equal(spawned[0].env.ORKESTR_RELEASE_TRAIN_FANOUT, "0");
  assert.deepEqual(spawned[0].args.slice(1), [
    "install",
    "--ref",
    "main",
    "--allow-untagged",
    "--no-smoke",
    "--no-all-instances",
  ]);
});

test("CLI update can track main as versioned releases", async () => {
  const stdout = capture();
  const spawned = [];
  const code = await runCli(["update", "--track-main", "--no-smoke"], {
    env: {},
    stdout,
    stderr: capture(),
    spawnImpl(command, args, options) {
      spawned.push({ command, args, env: options.env });
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 0));
      return child;
    },
  });

  assert.equal(code, 0);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].command, "bash");
  assert.match(spawned[0].args[0], /scripts\/deploy-git-release\.sh$/);
  assert.deepEqual(spawned[0].args.slice(1), ["install", "--ref", "main", "--channel", "main", "--allow-untagged", "--no-smoke", "--all-instances"]);
  assert.equal(spawned[0].env.ORKESTR_RELEASE_DEPLOY, "1");
  assert.equal(spawned[0].env.ORKESTR_RELEASE_TRAIN_FANOUT, "1");
  assert.equal(spawned[0].env.ORKESTR_DEPLOY_REF, "main");
  assert.equal(spawned[0].env.ORKESTR_DEPLOY_CHANNEL, "main");
  assert.equal(spawned[0].env.ORKESTR_DEPLOY_TAGS_ONLY, "0");
  assert.match(stdout.text(), /versioned release update for main/);
});

test("CLI update can run the in-place watcher", async () => {
  const spawned = [];
  const code = await runCli(["update", "--in-place", "--ref", "main"], {
    env: { ORKESTR_RELEASE_DEPLOY: "1" },
    stdout: capture(),
    stderr: capture(),
    spawnImpl(command, args, options) {
      spawned.push({ command, args, env: options.env });
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 0));
      return child;
    },
  });

  assert.equal(code, 0);
  assert.equal(spawned[0].command, "bash");
  assert.match(spawned[0].args[0], /scripts\/update-watch\.sh$/);
  assert.deepEqual(spawned[0].args.slice(1), []);
  assert.equal(spawned[0].env.ORKESTR_RELEASE_DEPLOY, "0");
  assert.equal(spawned[0].env.ORKESTR_UPDATE_REF, "main");
});

test("CLI update status and rollback forward to the release deployer", async () => {
  const spawned = [];
  const spawnImpl = (command, args, options) => {
    spawned.push({ command, args, env: options.env });
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("exit", 0));
    return child;
  };
  const statusCode = await runCli(["update", "status", "--json"], {
    env: {},
    stdout: capture(),
    stderr: capture(),
    spawnImpl,
  });
  const rollbackCode = await runCli(["update", "rollback", "--to", "v0.1.0-alpha.9"], {
    env: {},
    stdout: capture(),
    stderr: capture(),
    spawnImpl,
  });

  assert.equal(statusCode, 0);
  assert.equal(rollbackCode, 0);
  assert.match(spawned[0].args[0], /scripts\/deploy-git-release\.sh$/);
  assert.deepEqual(spawned[0].args.slice(1), ["status", "--json"]);
  assert.match(spawned[1].args[0], /scripts\/deploy-git-release\.sh$/);
  assert.deepEqual(spawned[1].args.slice(1), ["rollback", "--to", "v0.1.0-alpha.9"]);
});

test("CLI update rollback can intentionally bypass the no-interrupt guard", async () => {
  const spawned = [];
  const code = await runCli(["update", "rollback", "--to", "v0.1.0-alpha.9", "--allow-interrupt"], {
    env: {},
    stdout: capture(),
    stderr: capture(),
    spawnImpl(command, args, options) {
      spawned.push({ command, args, env: options.env });
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 0));
      return child;
    },
  });

  assert.equal(code, 0);
  assert.equal(spawned[0].command, "bash");
  assert.match(spawned[0].args[0], /scripts\/deploy-git-release\.sh$/);
  assert.deepEqual(spawned[0].args.slice(1), ["rollback", "--to", "v0.1.0-alpha.9", "--allow-interrupt"]);
});

test("CLI rollback is a short alias for update rollback", async () => {
  const spawned = [];
  const code = await runCli(["rollback"], {
    env: {},
    stdout: capture(),
    stderr: capture(),
    spawnImpl(command, args, options) {
      spawned.push({ command, args, env: options.env });
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 0));
      return child;
    },
  });

  assert.equal(code, 0);
  assert.equal(spawned[0].command, "bash");
  assert.match(spawned[0].args[0], /scripts\/deploy-git-release\.sh$/);
  assert.deepEqual(spawned[0].args.slice(1), ["rollback"]);
});

test("CLI logs tails the configured systemd service", async () => {
  const spawned = [];
  const code = await runCli(["logs", "--service", "orkestr-stage", "--lines", "50", "--no-follow"], {
    env: {},
    stdout: capture(),
    stderr: capture(),
    spawnImpl(command, args) {
      spawned.push({ command, args });
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 0));
      return child;
    },
  });

  assert.equal(code, 0);
  assert.equal(spawned[0].command, "journalctl");
  assert.deepEqual(spawned[0].args, ["-u", "orkestr-stage.service", "-n", "50", "--no-pager"]);
});

test("CLI service controls default systemd services", async () => {
  const spawned = [];
  const code = await runCli(["service", "restart", "--service", "orkestr-stage"], {
    env: {},
    stdout: capture(),
    stderr: capture(),
    spawnImpl(command, args) {
      spawned.push({ command, args });
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 0));
      return child;
    },
  });

  assert.equal(code, 0);
  assert.deepEqual(spawned, [{ command: "systemctl", args: ["restart", "orkestr-stage.service"] }]);
});

test("CLI service controls local systemd user services", async () => {
  const spawned = [];
  const code = await runCli(["service", "status"], {
    env: { ORKESTR_LOCAL_SERVICE_MANAGER: "systemd-user", ORKESTR_LOCAL_SERVICE_NAME: "orkestr-local" },
    stdout: capture(),
    stderr: capture(),
    spawnImpl(command, args) {
      spawned.push({ command, args });
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 0));
      return child;
    },
  });

  assert.equal(code, 0);
  assert.deepEqual(spawned, [{ command: "systemctl", args: ["--user", "status", "orkestr-local.service"] }]);
});

test("CLI service controls macOS launchd services", async () => {
  const spawned = [];
  const code = await runCli(["service", "start"], {
    env: {
      HOME: "/Users/demo",
      ORKESTR_LOCAL_SERVICE_MANAGER: "launchd",
      ORKESTR_LOCAL_SERVICE_LABEL: "com.orkestr.oss",
      ORKESTR_LOCAL_SERVICE_FILE: "/Users/demo/Library/LaunchAgents/com.orkestr.oss.plist",
    },
    stdout: capture(),
    stderr: capture(),
    spawnImpl(command, args) {
      spawned.push({ command, args });
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 0));
      return child;
    },
  });

  assert.equal(code, 0);
  assert.equal(spawned[0].command, "sh");
  assert.match(spawned[0].args[1], /launchctl bootstrap/);
  assert.match(spawned[0].args[1], /launchctl kickstart -k/);
  assert.match(spawned[0].args[1], /com\.orkestr\.oss/);
});

test("CLI service controls local background services without launchctl", async () => {
  const spawned = [];
  const code = await runCli(["service", "start"], {
    env: {
      ORKESTR_LOCAL_SERVICE_MANAGER: "background",
      ORKESTR_APP_DIR: "/Users/demo/orkestr",
      ORKESTR_HOME: "/Users/demo/.orkestr",
      ORKESTR_LOCAL_SERVER_WRAPPER: "/Users/demo/.orkestr/bin/orkestr-server",
      ORKESTR_LOCAL_PID_FILE: "/Users/demo/.orkestr/orkestr.pid",
      ORKESTR_LOCAL_TMUX_SESSION: "orkestr-service",
      ORKESTR_LOCAL_LOG_DIR: "/Users/demo/.orkestr/logs",
    },
    stdout: capture(),
    stderr: capture(),
    spawnImpl(command, args) {
      spawned.push({ command, args });
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 0));
      return child;
    },
  });

  assert.equal(code, 0);
  assert.equal(spawned[0].command, "sh");
  assert.match(spawned[0].args[1], /nohup/);
  assert.match(spawned[0].args[1], /tmux new-session/);
  assert.match(spawned[0].args[1], /orkestr-server/);
  assert.match(spawned[0].args[1], /dist\/server\/apps\/server\/src\/server/);
  assert.doesNotMatch(spawned[0].args[1], /launchctl|sudo|osascript/);
});

test("CLI stop cleans stale local background server processes", async () => {
  const spawned = [];
  const code = await runCli(["service", "stop"], {
    env: {
      ORKESTR_LOCAL_SERVICE_MANAGER: "background",
      ORKESTR_APP_DIR: "/Users/demo/orkestr",
      ORKESTR_HOME: "/Users/demo/.orkestr",
      ORKESTR_LOCAL_SERVER_WRAPPER: "/Users/demo/.orkestr/bin/orkestr-server",
      ORKESTR_LOCAL_PID_FILE: "/Users/demo/.orkestr/orkestr.pid",
      ORKESTR_LOCAL_TMUX_SESSION: "orkestr-service",
      ORKESTR_LOCAL_LOG_DIR: "/Users/demo/.orkestr/logs",
    },
    stdout: capture(),
    stderr: capture(),
    spawnImpl(command, args) {
      spawned.push({ command, args });
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 0));
      return child;
    },
  });

  assert.equal(code, 0);
  assert.equal(spawned[0].command, "sh");
  assert.match(spawned[0].args[1], /kill "\$\(cat/);
  assert.match(spawned[0].args[1], /tmux kill-session/);
  assert.match(spawned[0].args[1], /pgrep -f/);
  assert.match(spawned[0].args[1], /dist\/server\/apps\/server\/src\/server/);
  assert.doesNotMatch(spawned[0].args[1], /launchctl|sudo|osascript/);
});

test("CLI service logs tails local service files", async () => {
  const spawned = [];
  const code = await runCli(["service", "logs", "--lines", "25", "--no-follow"], {
    env: {
      ORKESTR_LOCAL_SERVICE_MANAGER: "launchd",
      ORKESTR_LOCAL_LOG_DIR: "/Users/demo/.orkestr/logs",
    },
    stdout: capture(),
    stderr: capture(),
    spawnImpl(command, args) {
      spawned.push({ command, args });
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 0));
      return child;
    },
  });

  assert.equal(code, 0);
  assert.deepEqual(spawned, [{
    command: "tail",
    args: ["-n", "25", "/Users/demo/.orkestr/logs/orkestr.out.log", "/Users/demo/.orkestr/logs/orkestr.err.log"],
  }]);
});

test("CLI attach can select a thread and print the tmux command", async () => {
  const stdout = capture();
  const selected = { id: "thread-1", name: "Demo", state: "ready" };
  const code = await runCli(["attach", "--print"], {
    stdout,
    stderr: capture(),
    pickThread: async () => selected,
    fetchImpl: fakeFetch({
      "GET /api/threads/summary": { threads: [selected] },
      "POST /api/threads/Demo/attach": {
        ok: true,
        runtime: { sessionName: "orkestr-demo" },
      },
    }),
  });

  assert.equal(code, 0);
  assert.equal(stdout.text(), "tmux attach-session -t 'orkestr-demo'\n");
});

test("CLI attach with an explicit thread does not fetch the thread list", async () => {
  const stdout = capture();
  const seen = [];
  const code = await runCli(["attach", "Demo", "--print"], {
    stdout,
    stderr: capture(),
    fetchImpl: fakeFetch({
      "POST /api/threads/Demo/attach": {
        ok: true,
        runtime: { sessionName: "orkestr-demo" },
      },
    }, seen),
  });

  assert.equal(code, 0);
  assert.deepEqual(seen.map((entry) => entry.key), ["POST /api/threads/Demo/attach"]);
  assert.match(stdout.text(), /orkestr-demo/);
});

test("CLI attach prints native Codex attach commands for app-server threads", async () => {
  const stdout = capture();
  const attachCommand = "codex resume -C '/workspace/demo' 'codex-thread-1'";
  const code = await runCli(["attach", "Demo", "--print"], {
    stdout,
    stderr: capture(),
    fetchImpl: fakeFetch({
      "POST /api/threads/Demo/attach": {
        ok: true,
        attachKind: "codex-app-server",
        attachCommand,
        runtime: { transport: "app-server" },
      },
    }),
  });

  assert.equal(code, 0);
  assert.equal(stdout.text(), `${attachCommand}\n`);
});

test("CLI attach renders raw terminal watch-and-wait payloads", async () => {
  const stdout = capture();
  const spawned = [];
  const code = await runCli(["attach", "Demo"], {
    stdout,
    stderr: capture(),
    spawnImpl(command, args) {
      spawned.push({ command, args });
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 0));
      return child;
    },
    fetchImpl: fakeFetch({
      "POST /api/threads/Demo/attach": {
        ok: true,
        attachable: false,
        watchOnly: true,
        watch: {
          threadName: "Demo",
          runtimeMode: "codex-app-server",
          runtimeState: "working",
          activeTurnId: "turn-1",
          activeDuration: "10s",
          staleRisk: "low",
          recommendedAction: "wait",
          intervalMs: 5000,
          timeoutMs: 900000,
          nextCheckInMs: 5000,
        },
      },
    }),
  });

  assert.equal(code, 0);
  assert.deepEqual(spawned, []);
  assert.match(stdout.text(), /Raw attach watch-and-wait/);
  assert.match(stdout.text(), /Active turn: turn-1/);
  assert.match(stdout.text(), /Recommended action: wait/);
});

test("CLI attach read-only passes non-mutating watch options", async () => {
  const stdout = capture();
  const seen = [];
  const code = await runCli(["attach", "Demo", "--read-only", "--interval", "2", "--timeout", "1m"], {
    stdout,
    stderr: capture(),
    fetchImpl: fakeFetch({
      "POST /api/threads/Demo/attach": {
        ok: true,
        attachable: false,
        watchOnly: true,
        watchText: "watching\n",
      },
    }, seen),
  });

  assert.equal(code, 0);
  assert.equal(stdout.text(), "watching\n");
  assert.equal(seen[0].body.readOnly, true);
  assert.equal(seen[0].body.intervalMs, 2000);
  assert.equal(seen[0].body.timeoutMs, 60000);
  assert.equal(Number.isFinite(seen[0].body.watchStartedAtMs), true);
});

test("CLI attach takeover waits through watch-and-wait before attaching", async () => {
  const stdout = capture();
  const spawned = [];
  const seen = [];
  let attempts = 0;
  const code = await runCli(["attach", "Demo", "--takeover", "--interval", "0.001", "--timeout", "2s"], {
    stdout,
    stderr: capture(),
    spawnImpl(command, args) {
      spawned.push({ command, args });
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 0));
      return child;
    },
    fetchImpl: fakeFetch({
      "POST /api/threads/Demo/attach": () => {
        attempts += 1;
        if (attempts === 1) {
          return {
            ok: true,
            attachable: false,
            watchOnly: true,
            watchText: "watching\n",
          };
        }
        return {
          ok: true,
          attachKind: "raw-terminal",
          runtime: { sessionName: "orkestr-thread-demo" },
        };
      },
    }, seen),
  });

  assert.equal(code, 0);
  assert.equal(stdout.text(), "watching\n");
  assert.equal(attempts, 2);
  assert.equal(seen[0].body.takeover, true);
  assert.equal(seen[1].body.takeover, true);
  assert.deepEqual(spawned, [{ command: "tmux", args: ["attach-session", "-t", "orkestr-thread-demo"] }]);
});

test("CLI attach interactive watch hotkey interrupts and takes over", async () => {
  const stdout = capture();
  const spawned = [];
  const seen = [];
  const stdin = new EventEmitter();
  stdin.isTTY = true;
  stdin.setRawMode = (value) => {
    stdin.isRaw = value;
  };
  stdin.setEncoding = () => {};
  stdin.resume = () => {};
  stdin.pause = () => {};
  let attempts = 0;
  const code = await runCli(["attach", "Demo", "--interval", "0.001", "--timeout", "2s"], {
    stdin,
    stdout,
    stderr: capture(),
    sleepImpl: async () => {
      stdin.emit("data", "i");
    },
    spawnImpl(command, args) {
      spawned.push({ command, args });
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 0));
      return child;
    },
    fetchImpl: fakeFetch({
      "POST /api/threads/Demo/attach": (request) => {
        attempts += 1;
        if (attempts === 1) {
          return {
            ok: true,
            attachable: false,
            watchOnly: true,
            watchText: "watching\n",
          };
        }
        assert.equal(request.body.takeover, true);
        assert.equal(request.body.interrupt, true);
        assert.equal(request.body.yes, true);
        return {
          ok: true,
          attachKind: "raw-terminal",
          runtime: { sessionName: "orkestr-thread-demo" },
        };
      },
    }, seen),
  });

  assert.equal(code, 0);
  assert.match(stdout.text(), /Interrupt takeover requested/);
  assert.equal(seen.length, 2);
  assert.deepEqual(spawned, [{ command: "tmux", args: ["attach-session", "-t", "orkestr-thread-demo"] }]);
  assert.equal(stdin.isRaw, false);
});

test("CLI attach interactive watch approval hotkey uses thread input", async () => {
  const stdout = capture();
  const seen = [];
  const stdin = new EventEmitter();
  stdin.isTTY = true;
  stdin.setRawMode = (value) => {
    stdin.isRaw = value;
  };
  stdin.setEncoding = () => {};
  stdin.resume = () => {};
  stdin.pause = () => {};
  const keys = ["a", "r"];
  const code = await runCli(["attach", "Demo", "--interval", "0.001", "--timeout", "2s"], {
    stdin,
    stdout,
    stderr: capture(),
    sleepImpl: async () => {
      stdin.emit("data", keys.shift() || "r");
    },
    fetchImpl: fakeFetch({
      "POST /api/threads/Demo/attach": {
        ok: true,
        attachable: false,
        watchOnly: true,
        watchText: "watching\n",
      },
      "POST /api/threads/Demo/input": { ok: true },
    }, seen),
  });

  assert.equal(code, 0);
  assert.match(stdout.text(), /Approval sent/);
  assert.match(stdout.text(), /Read-only watch enabled/);
  assert.deepEqual(seen.map((entry) => entry.key), [
    "POST /api/threads/Demo/attach",
    "POST /api/threads/Demo/input",
    "POST /api/threads/Demo/attach",
    "POST /api/threads/Demo/attach",
  ]);
  assert.equal(seen[1].body.text, "Approved. Proceed.");
  assert.equal(seen[1].body.source, "raw-attach-watch");
  assert.equal(seen[3].body.readOnly, true);
  assert.equal(stdin.isRaw, false);
});

test("CLI attach can execute tmux for an attachable thread", async () => {
  const spawned = [];
  const code = await runCli(["attach", "Demo"], {
    stdout: capture(),
    stderr: capture(),
    spawnImpl(command, args) {
      spawned.push({ command, args });
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 0));
      return child;
    },
    fetchImpl: fakeFetch({
      "POST /api/threads/Demo/attach": {
        ok: true,
        runtime: { sessionName: "orkestr-demo" },
      },
    }),
  });

  assert.equal(code, 0);
  assert.deepEqual(spawned, [{ command: "tmux", args: ["attach-session", "-t", "orkestr-demo"] }]);
});

test("CLI attach executes native Codex attach commands for app-server threads", async () => {
  const spawned = [];
  const attachCommand = "codex resume -C '/workspace/demo' 'codex-thread-1'";
  const code = await runCli(["attach", "Demo"], {
    stdout: capture(),
    stderr: capture(),
    spawnImpl(command, args) {
      spawned.push({ command, args });
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 0));
      return child;
    },
    fetchImpl: fakeFetch({
      "POST /api/threads/Demo/attach": {
        ok: true,
        attachKind: "codex-app-server",
        attachCommand,
        runtime: { transport: "app-server" },
      },
    }),
  });

  assert.equal(code, 0);
  assert.deepEqual(spawned, [{ command: "sh", args: ["-lc", `exec ${attachCommand}`] }]);
});
