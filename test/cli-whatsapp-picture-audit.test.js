import assert from "node:assert/strict";
import test from "node:test";
import { runCli } from "../apps/cli/src/commands.js";
import { whatsappPictureAuditCommand } from "../apps/cli/src/whatsapp-picture-audit-command.js";

function capture() {
  let text = "";
  return {
    write(value) { text += String(value); },
    text() { return text; },
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
    seen.push({ key, headers: options.headers || {}, body: options.body ? JSON.parse(options.body) : null });
    const route = routes[key];
    if (!route) return jsonResponse({ error: `missing route: ${key}` }, 404);
    const result = typeof route === "function" ? route(seen.at(-1)) : route;
    return result instanceof Response ? result : jsonResponse(result);
  };
}

// ── Argument parsing ──────────────────────────────────────────────────────────

test("pictures audit: --account flag sets account id", async () => {
  const seen = [];
  const stdout = capture();
  await whatsappPictureAuditCommand(["--account", "sender", "--json"], {
    baseUrl: "http://orkestr.test",
    env: { ORKESTR_DISABLE_CLI_AUTH: "1" },
    stdout,
    fetchImpl: fakeFetch({
      "POST /api/connectors/whatsapp/bridge/accounts/sender/chats/picture-audit": { ok: true, accountId: "sender", results: [] },
    }, seen),
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].key, "POST /api/connectors/whatsapp/bridge/accounts/sender/chats/picture-audit");
});

test("pictures audit: top-level CLI dispatches the documented command", async () => {
  const seen = [];
  const stdout = capture();
  const code = await runCli(["whatsapp", "pictures", "audit", "--account", "sender", "--json"], {
    baseUrl: "http://orkestr.test",
    env: { ORKESTR_DISABLE_CLI_AUTH: "1" },
    stdout,
    stderr: capture(),
    fetchImpl: fakeFetch({
      "POST /api/connectors/whatsapp/bridge/accounts/sender/chats/picture-audit": {
        ok: true,
        accountId: "sender",
        results: [],
      },
    }, seen),
  });
  assert.equal(code, 0);
  assert.equal(seen[0].key, "POST /api/connectors/whatsapp/bridge/accounts/sender/chats/picture-audit");
  assert.deepEqual(JSON.parse(stdout.text()), { ok: true, accountId: "sender", results: [] });
});

test("pictures audit: positional account id is accepted as fallback", async () => {
  const seen = [];
  const stdout = capture();
  await whatsappPictureAuditCommand(["responder", "--json"], {
    baseUrl: "http://orkestr.test",
    env: { ORKESTR_DISABLE_CLI_AUTH: "1" },
    stdout,
    fetchImpl: fakeFetch({
      "POST /api/connectors/whatsapp/bridge/accounts/responder/chats/picture-audit": { ok: true, accountId: "responder", results: [] },
    }, seen),
  });
  assert.equal(seen[0].key, "POST /api/connectors/whatsapp/bridge/accounts/responder/chats/picture-audit");
});

test("pictures audit: --chat-ids parses comma-separated list", async () => {
  const seen = [];
  const stdout = capture();
  await whatsappPictureAuditCommand(
    ["--account", "sender", "--chat-ids", "a@g.us,b@g.us,c@g.us"],
    {
      baseUrl: "http://orkestr.test",
      env: { ORKESTR_DISABLE_CLI_AUTH: "1" },
      stdout,
      fetchImpl: fakeFetch({
        "POST /api/connectors/whatsapp/bridge/accounts/sender/chats/picture-audit": { ok: true, accountId: "sender", results: [] },
      }, seen),
    },
  );
  assert.deepEqual(seen[0].body.chatIds, ["a@g.us", "b@g.us", "c@g.us"]);
});

test("pictures audit: empty chatIds body when --chat-ids not provided", async () => {
  const seen = [];
  const stdout = capture();
  await whatsappPictureAuditCommand(["--account", "sender"], {
    baseUrl: "http://orkestr.test",
    env: { ORKESTR_DISABLE_CLI_AUTH: "1" },
    stdout,
    fetchImpl: fakeFetch({
      "POST /api/connectors/whatsapp/bridge/accounts/sender/chats/picture-audit": { ok: true, accountId: "sender", results: [] },
    }, seen),
  });
  assert.deepEqual(seen[0].body.chatIds, []);
});

test("pictures audit: url-encodes account id with spaces", async () => {
  const seen = [];
  const stdout = capture();
  await whatsappPictureAuditCommand(["--account", "my account"], {
    baseUrl: "http://orkestr.test",
    env: { ORKESTR_DISABLE_CLI_AUTH: "1" },
    stdout,
    fetchImpl: fakeFetch({
      "POST /api/connectors/whatsapp/bridge/accounts/my%20account/chats/picture-audit": { ok: true, accountId: "my account", results: [] },
    }, seen),
  });
  assert.equal(seen[0].key, "POST /api/connectors/whatsapp/bridge/accounts/my%20account/chats/picture-audit");
});

test("pictures audit: throws usage error when account is missing", async () => {
  await assert.rejects(
    () => whatsappPictureAuditCommand([], {
      baseUrl: "http://orkestr.test",
      env: { ORKESTR_DISABLE_CLI_AUTH: "1" },
      stdout: capture(),
      fetchImpl: async () => { throw new Error("should not call"); },
    }),
    (error) => {
      assert.match(error.message, /pictures audit/);
      return true;
    },
  );
});

// ── Output formatting ─────────────────────────────────────────────────────────

test("pictures audit: --json emits raw JSON payload", async () => {
  const stdout = capture();
  const payload = { ok: true, accountId: "sender", results: [{ chatId: "group@g.us", status: "present" }] };
  await whatsappPictureAuditCommand(["--account", "sender", "--json"], {
    baseUrl: "http://orkestr.test",
    env: { ORKESTR_DISABLE_CLI_AUTH: "1" },
    stdout,
    fetchImpl: fakeFetch({
      "POST /api/connectors/whatsapp/bridge/accounts/sender/chats/picture-audit": payload,
    }),
  });
  assert.deepEqual(JSON.parse(stdout.text()), payload);
});

test("pictures audit: text output shows chatId: status lines", async () => {
  const stdout = capture();
  await whatsappPictureAuditCommand(["--account", "sender"], {
    baseUrl: "http://orkestr.test",
    env: { ORKESTR_DISABLE_CLI_AUTH: "1" },
    stdout,
    fetchImpl: fakeFetch({
      "POST /api/connectors/whatsapp/bridge/accounts/sender/chats/picture-audit": {
        ok: true,
        accountId: "sender",
        results: [
          { chatId: "aa@g.us", status: "present" },
          { chatId: "bb@g.us", status: "missing" },
          { chatId: "cc@g.us", status: "unknown" },
        ],
      },
    }),
  });
  assert.match(stdout.text(), /aa@g\.us: present/);
  assert.match(stdout.text(), /bb@g\.us: missing/);
  assert.match(stdout.text(), /cc@g\.us: unknown/);
});

test("pictures audit: text output shows 'No groups audited' when results is empty", async () => {
  const stdout = capture();
  await whatsappPictureAuditCommand(["--account", "sender"], {
    baseUrl: "http://orkestr.test",
    env: { ORKESTR_DISABLE_CLI_AUTH: "1" },
    stdout,
    fetchImpl: fakeFetch({
      "POST /api/connectors/whatsapp/bridge/accounts/sender/chats/picture-audit": { ok: true, accountId: "sender", results: [] },
    }),
  });
  assert.match(stdout.text(), /No groups audited/);
});

test("pictures audit: text output does not include picture URLs or personal identifiers", async () => {
  const stdout = capture();
  await whatsappPictureAuditCommand(["--account", "sender"], {
    baseUrl: "http://orkestr.test",
    env: { ORKESTR_DISABLE_CLI_AUTH: "1" },
    stdout,
    fetchImpl: fakeFetch({
      "POST /api/connectors/whatsapp/bridge/accounts/sender/chats/picture-audit": {
        ok: true,
        accountId: "sender",
        results: [{ chatId: "group@g.us", status: "present" }],
      },
    }),
  });
  // Output must not contain URLs or any content beyond chatId + status
  assert.doesNotMatch(stdout.text(), /https?:\/\//);
  assert.match(stdout.text(), /group@g\.us: present/);
});

test("pictures audit: returns exit code 1 when payload ok is false", async () => {
  const stdout = capture();
  const code = await whatsappPictureAuditCommand(["--account", "sender"], {
    baseUrl: "http://orkestr.test",
    env: { ORKESTR_DISABLE_CLI_AUTH: "1" },
    stdout,
    fetchImpl: fakeFetch({
      "POST /api/connectors/whatsapp/bridge/accounts/sender/chats/picture-audit": { ok: false, error: "bridge_error" },
    }),
  });
  assert.equal(code, 1);
});

test("pictures audit: returns exit code 0 for successful audit", async () => {
  const stdout = capture();
  const code = await whatsappPictureAuditCommand(["--account", "sender"], {
    baseUrl: "http://orkestr.test",
    env: { ORKESTR_DISABLE_CLI_AUTH: "1" },
    stdout,
    fetchImpl: fakeFetch({
      "POST /api/connectors/whatsapp/bridge/accounts/sender/chats/picture-audit": { ok: true, accountId: "sender", results: [] },
    }),
  });
  assert.equal(code, 0);
});
