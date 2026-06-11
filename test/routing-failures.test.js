import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeRoutingFailure,
  publicRoutingFailurePayload,
} from "../packages/core/src/routing-failures.js";

test("routing failures expose structured WhatsApp scope context without secrets", () => {
  const failure = normalizeRoutingFailure({
    message: "token_scope_denied token=super-secret /var/lib/orkestr-fixture/secrets/bridge.env",
    routerTraceId: "rt_scope_1",
    accountId: "responder",
    bindingId: "thread:features:whatsapp",
    instanceId: "vm-orkestr-de",
    threadId: "aeef8faaa15877f7",
    chatId: "fixture-scope@g.us",
    principalKind: "instance",
    principalId: "orkestr-de",
    safeMessage: "Bridge token lacks send scope Bearer secret-token",
  });

  assert.equal(failure.code, "wa_token_scope_denied");
  assert.equal(failure.capability, "whatsapp");
  assert.equal(failure.userFacingCategory, "connector");
  assert.equal(failure.routerTraceId, "rt_scope_1");
  assert.equal(failure.accountId, "responder");
  assert.equal(failure.bindingId, "thread:features:whatsapp");
  assert.equal(failure.instanceId, "vm-orkestr-de");
  assert.equal(failure.threadId, "aeef8faaa15877f7");
  assert.equal(failure.chatId, "fixture-scope@g.us");
  assert.equal(failure.principalKind, "instance");
  assert.equal(failure.principalId, "orkestr-de");
  assert.match(failure.reason, /token=\[redacted\]/);
  assert.match(failure.reason, /\[redacted-path\]/);
  assert.match(failure.safeMessage, /Bearer \[redacted\]/);
  assert.doesNotMatch(JSON.stringify(failure), /super-secret|secret-token|orkestr-production/);
});

test("public routing failure payload maps WhatsApp binding and ACL errors", () => {
  const binding = publicRoutingFailurePayload(new Error("binding ambiguous"), {
    accountId: "responder",
    bindingId: "thread:features:whatsapp",
  });
  const acl = publicRoutingFailurePayload(new Error("ACL denied"), {
    principalKind: "user",
    principalId: "user-1",
  });

  assert.equal(binding.error, "wa_binding_ambiguous");
  assert.equal(binding.routingFailure.accountId, "responder");
  assert.equal(binding.routingFailure.bindingId, "thread:features:whatsapp");
  assert.equal(acl.error, "wa_acl_denied");
  assert.equal(acl.routingFailure.principalKind, "user");
  assert.equal(acl.routingFailure.principalId, "user-1");
});
