import assert from "node:assert/strict";
import test from "node:test";
import { runCli } from "../apps/cli/src/commands.js";

const env = { ORKESTR_DISABLE_CLI_AUTH: "1", ORKESTR_ENV_FILE: "" };
const url = "https://orkestr.example.com/s/SyntheticTokenSyntheticTokenSyntheticToken12";

function capture() {
  let text = "";
  return { write(value) { text += String(value); }, text: () => text };
}

function fakeFetch(routes, seen = []) {
  return async (target, options = {}) => {
    const parsed = new URL(target);
    const key = `${String(options.method || "GET").toUpperCase()} ${parsed.pathname}`;
    seen.push({ key, body: options.body ? JSON.parse(options.body) : null });
    const route = routes[key];
    return new Response(JSON.stringify(route || { error: `missing route: ${key}` }), {
      status: route ? 200 : 404,
      headers: { "content-type": "application/json" },
    });
  };
}

function run(argv, routes, extra = {}) {
  const stdout = capture();
  const stderr = capture();
  const seen = [];
  return runCli(argv, { env, stdout, stderr, fetchImpl: fakeFetch(routes, seen), ...extra })
    .then((code) => ({ code, stdout: stdout.text(), stderr: stderr.text(), seen }));
}

test("secret share refuses the value as an argv flag", async () => {
  for (const argv of [["secret", "share", "--value", "synthetic"], ["secret", "share", "--value=synthetic"], ["secret", "request", "x", "--secret-value", "y"]]) {
    const result = await run(argv, {});
    assert.equal(result.code, 1);
    assert.match(result.stderr, /secret_value_flag_disabled/);
    assert.equal(result.seen.length, 0);
  }
});

test("secret share prints only the link and sends the value once to the API", async () => {
  const value = "synthetic-cli-share-value";
  const routes = { "POST /api/secret-links/share": { ok: true, url, link: { id: "sl_example", kind: "share", status: "active" } } };
  const result = await run(["secret", "share", "--ttl", "2h", "--label", "Example", "--thread", "thread-1"], routes, { readSecretValue: async () => value });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, `${url}\n`);
  assert.deepEqual(result.seen[0].body, { ttl: "2h", label: "Example", threadId: "thread-1", value });

  const fromRef = await run(["secret", "share", "--from", "secret://user/admin/vendor/key", "--json"], routes, {
    readSecretValue: async () => { throw new Error("must not prompt"); },
  });
  assert.equal(fromRef.code, 0, fromRef.stderr);
  assert.deepEqual(fromRef.seen[0].body, { from: "secret://user/admin/vendor/key" });
  assert.equal(JSON.parse(fromRef.stdout).url, url);
});

test("secret request, links list and links revoke call the secret-links API", async () => {
  const request = await run(["secret", "request", "service/api-token", "--thread", "thread-1"], {
    "POST /api/secret-links/request": { ok: true, url, link: { id: "sl_example", handle: "secret://user/admin/service/api-token" } },
  });
  assert.equal(request.code, 0, request.stderr);
  assert.deepEqual(request.seen[0].body, { threadId: "thread-1", name: "service/api-token" });
  assert.match(request.stdout, /secret:\/\/user\/admin\/service\/api-token/);

  const list = await run(["secret", "links", "list"], {
    "GET /api/secret-links": { ok: true, links: [{ id: "sl_example", kind: "request", status: "active", name: "service/api-token" }] },
  });
  assert.equal(list.code, 0, list.stderr);
  assert.match(list.stdout, /sl_example\trequest\tactive\tservice\/api-token/);

  const revoke = await run(["secret", "links", "revoke", "sl_example", "--json"], {
    "POST /api/secret-links/sl_example/revoke": { ok: true, link: { id: "sl_example", status: "revoked" } },
  });
  assert.equal(revoke.code, 0, revoke.stderr);
  assert.equal(JSON.parse(revoke.stdout).link.status, "revoked");
});
