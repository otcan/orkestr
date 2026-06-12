import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  __brokerInstanceRegistryTestInternals,
  encryptBrokerChannelPayload,
  heartbeatBrokerInstance,
  listBrokerInstances,
  registerBrokerInstance,
} from "../packages/core/src/broker-instance-registry.js";
import { authorizeHttpRequest } from "../packages/core/src/security.js";

function request(headers = {}) {
  return {
    method: "POST",
    url: "/api/broker/instances/register",
    ip: "198.51.100.10",
    headers: {
      "user-agent": "node:test",
      ...headers,
    },
  };
}

function uuidLike(value) {
  assert.match(value, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
}

test("broker registration issues broker UUID and encrypted channel bootstrap", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-broker-register-"));
  const client = __brokerInstanceRegistryTestInternals.createX25519Identity();
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_BROKER_REGISTRATION_TOKEN: "register-secret",
  };

  const registration = await registerBrokerInstance({
    env,
    request: request({ authorization: "Bearer register-secret" }),
    body: {
      instanceId: "orkestr-ui",
      displayName: "demo vm",
      version: "0.1.0-alpha.33",
      capabilities: ["demo-onboarding"],
      encryptionPublicKey: client.publicKey,
    },
  });

  assert.equal(registration.ok, true);
  uuidLike(registration.instanceId);
  assert.notEqual(registration.instanceId, "orkestr-ui");
  uuidLike(registration.channelId);
  assert.match(registration.broker.publicKey, /BEGIN PUBLIC KEY/);
  assert.equal(registration.encryptedWelcome.alg, "X25519-HKDF-SHA256+A256GCM");

  const sharedSecret = __brokerInstanceRegistryTestInternals.deriveSharedSecret(client.privateKey, registration.broker.publicKey);
  const channelKey = __brokerInstanceRegistryTestInternals.deriveChannelKey(sharedSecret, registration.channelId);
  const welcome = __brokerInstanceRegistryTestInternals.decryptJson(registration.encryptedWelcome, channelKey);
  assert.equal(welcome.instanceId, registration.instanceId);
  assert.equal(welcome.channelId, registration.channelId);

  const instances = await listBrokerInstances(env);
  assert.equal(instances.instances.length, 1);
  assert.equal(instances.instances[0].instanceId, registration.instanceId);
  assert.equal(instances.instances[0].displayName, "demo vm");
  assert.equal(instances.instances[0].version, "0.1.0-alpha.33");
});

test("broker registration rejects missing token and enforces use/rate limits", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-broker-limits-"));
  const client = __brokerInstanceRegistryTestInternals.createX25519Identity();
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_BROKER_REGISTRATION_TOKEN: "register-secret",
    ORKESTR_BROKER_REGISTRATION_TOKEN_MAX_USES: "1",
    ORKESTR_BROKER_REGISTRATION_RATE_LIMIT: "1",
  };

  await assert.rejects(
    () => registerBrokerInstance({
      env,
      request: request(),
      body: { encryptionPublicKey: client.publicKey },
    }),
    /broker_registration_token_denied/,
  );

  await registerBrokerInstance({
    env,
    request: request({ authorization: "Bearer register-secret" }),
    body: { encryptionPublicKey: client.publicKey },
  });

  await assert.rejects(
    () => registerBrokerInstance({
      env,
      request: request({ authorization: "Bearer register-secret" }),
      body: { encryptionPublicKey: client.publicKey },
    }),
    /broker_registration_token_use_limit|broker_registration_rate_limited/,
  );
});

test("broker registration allows authenticated admin callers without exposing registration token", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-broker-admin-register-"));
  const firstClient = __brokerInstanceRegistryTestInternals.createX25519Identity();
  const secondClient = __brokerInstanceRegistryTestInternals.createX25519Identity();
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_BROKER_REGISTRATION_TOKEN: "register-secret",
    ORKESTR_BROKER_REGISTRATION_TOKEN_MAX_USES: "1",
  };

  const first = await registerBrokerInstance({
    env,
    trustedAdmin: true,
    request: request(),
    body: { encryptionPublicKey: firstClient.publicKey, displayName: "admin-local-1" },
  });
  const second = await registerBrokerInstance({
    env,
    trustedAdmin: true,
    request: request({ "x-forwarded-for": "198.51.100.11" }),
    body: { encryptionPublicKey: secondClient.publicKey, displayName: "admin-local-2" },
  });
  const instances = await listBrokerInstances(env);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(instances.instances.length, 2);
  assert.deepEqual(instances.instances.map((instance) => instance.displayName), ["admin-local-1", "admin-local-2"]);
});

test("broker heartbeat requires encrypted channel payload", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-broker-heartbeat-"));
  const client = __brokerInstanceRegistryTestInternals.createX25519Identity();
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_BROKER_REGISTRATION_TOKEN: "register-secret",
  };
  const registration = await registerBrokerInstance({
    env,
    request: request({ authorization: "Bearer register-secret" }),
    body: { encryptionPublicKey: client.publicKey, version: "before" },
  });

  await assert.rejects(
    () => heartbeatBrokerInstance(registration.instanceId, {
      env,
      request: { ip: "198.51.100.11", headers: {} },
      body: { channelId: registration.channelId, envelope: { iv: "bad", ciphertext: "bad", tag: "bad" } },
    }),
    /invalid_encrypted_payload|Unsupported state|unable to authenticate/i,
  );

  const envelope = encryptBrokerChannelPayload({ version: "after" }, {
    clientPrivateKey: client.privateKey,
    brokerPublicKey: registration.broker.publicKey,
    channelId: registration.channelId,
  });
  const heartbeat = await heartbeatBrokerInstance(registration.instanceId, {
    env,
    request: { ip: "198.51.100.11", headers: {} },
    body: { channelId: registration.channelId, envelope },
  });

  assert.equal(heartbeat.ok, true);
  const instances = await listBrokerInstances(env);
  assert.equal(instances.instances[0].status, "online");
  assert.equal(instances.instances[0].version, "after");
  assert.ok(instances.instances[0].lastHeartbeatAt);
});

test("broker registration endpoints are allowed before browser pairing", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-broker-prepair-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_AUTH_REQUIRED: "1",
  };

  const register = await authorizeHttpRequest({ method: "POST", url: "/api/broker/instances/register", headers: {} }, env);
  const heartbeat = await authorizeHttpRequest({ method: "POST", url: "/api/broker/instances/demo/heartbeat", headers: {} }, env);
  const privateRoute = await authorizeHttpRequest({ method: "GET", url: "/api/broker/instances", headers: {} }, env);

  assert.equal(register.ok, true);
  assert.equal(heartbeat.ok, true);
  assert.equal(privateRoute.ok, false);
  assert.equal(privateRoute.statusCode, 401);
});
