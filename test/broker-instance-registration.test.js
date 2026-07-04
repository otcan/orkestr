import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  __brokerInstanceRegistryTestInternals,
  brokerWhatsAppRelayAccountId,
  decryptBrokerClientPayload,
  encryptBrokerChannelPayload,
  encryptBrokerInstancePayload,
  decryptBrokerInstanceRequest,
  ensureBrokerClientRegistration,
  heartbeatBrokerInstance,
  listBrokerInstances,
  registerBrokerInstance,
  resolveBrokerConnectInstance,
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

test("broker registry persists instances in sqlite and redacts routing metadata", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-broker-sqlite-"));
  const client = __brokerInstanceRegistryTestInternals.createX25519Identity();
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_BROKER_INSTANCE_STORE: "sqlite",
    ORKESTR_BROKER_REGISTRATION_TOKEN: "register-secret",
  };

  const registration = await registerBrokerInstance({
    env,
    request: request({ authorization: "Bearer register-secret" }),
    body: {
      displayName: "isolated vm",
      version: "0.1.0-alpha.35",
      encryptionPublicKey: client.publicKey,
      endpointBaseUrl: "http://10.0.0.12:19822",
      connectBaseUrl: "https://connect.orkestr.de",
      relayAccountId: "responder",
      whatsappNumber: "+49 176 123456",
    },
  });

  const dbStat = await fs.stat(path.join(home, "broker-instances.sqlite"));
  const listed = await listBrokerInstances(env);
  const resolved = await resolveBrokerConnectInstance(registration.instanceId, env);

  assert.ok(dbStat.size > 0);
  assert.equal(listed.backend, "sqlite");
  assert.equal(listed.instances.length, 1);
  assert.equal(listed.instances[0].instanceId, registration.instanceId);
  assert.equal(listed.instances[0].endpointBaseUrl, "http://10.0.0.12:19822");
  assert.equal(listed.instances[0].connectBaseUrl, "https://connect.orkestr.de");
  assert.equal(listed.instances[0].relayAccountId, "responder");
  assert.equal(listed.instances[0].whatsappChatHashConfigured, true);
  assert.equal(listed.instances[0].whatsappChatHash, undefined);
  assert.equal(JSON.stringify(listed).includes("49176123456"), false);
  assert.equal(JSON.stringify(listed).includes("+49 176 123456"), false);
  assert.equal(resolved.ok, true);
  assert.equal(resolved.instance.instanceId, registration.instanceId);
});

test("broker WhatsApp onboarding prefers sender account over responder fallback", () => {
  assert.equal(brokerWhatsAppRelayAccountId({}, {}), "sender");
  assert.equal(brokerWhatsAppRelayAccountId({}, {
    ORKESTR_WHATSAPP_SENDER_ACCOUNT_ID: "tr-sender",
    ORKESTR_WHATSAPP_RESPONDER_ACCOUNT_ID: "de-responder",
  }), "tr-sender");
  assert.equal(brokerWhatsAppRelayAccountId({}, {
    ORKESTR_BROKER_WHATSAPP_ONBOARDING_ACCOUNT_ID: "onboarding-relay",
    ORKESTR_WHATSAPP_SENDER_ACCOUNT_ID: "tr-sender",
  }), "onboarding-relay");
  assert.equal(brokerWhatsAppRelayAccountId({ relayAccountId: "instance-relay" }, {
    ORKESTR_BROKER_WHATSAPP_ONBOARDING_ACCOUNT_ID: "onboarding-relay",
  }), "instance-relay");
});

test("broker client registration cache is scoped to the declared WhatsApp number", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-broker-client-cache-"));
  const calls = [];
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_DEMO_BROKER_BASE_URL: "https://broker.example.test",
    ORKESTR_DEMO_WHATSAPP_NUMBER: "+49 176 111111",
  };
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          ok: true,
          instanceId: `instance-${calls.length}`,
          channelId: `channel-${calls.length}`,
          registeredAt: "2026-06-11T00:00:00.000Z",
          broker: {
            keyId: "broker-key-1",
            publicKey: "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VuAyEA2IFd3Rdi7NTih5q0Glq82pzgjEycOnu/MpuxJdGzGn4=\n-----END PUBLIC KEY-----\n",
          },
        };
      },
    };
  };

  const first = await ensureBrokerClientRegistration(env, { fetchImpl });
  const second = await ensureBrokerClientRegistration(env, { fetchImpl });
  const third = await ensureBrokerClientRegistration({
    ...env,
    ORKESTR_DEMO_WHATSAPP_NUMBER: "+49 176 222222",
  }, { fetchImpl });
  const cached = JSON.parse(await fs.readFile(path.join(home, "secrets", "broker-client-registration.json"), "utf8"));

  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(third.reused, false);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.whatsappNumber, "+49 176 111111");
  assert.equal(calls[1].body.whatsappNumber, "+49 176 222222");
  assert.equal(cached.whatsappTargetHash.length, 64);
  assert.equal(JSON.stringify(cached).includes("49176"), false);
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

test("broker instance WhatsApp requests are encrypted and scoped to registered WhatsApp number", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-broker-wa-request-"));
  const client = __brokerInstanceRegistryTestInternals.createX25519Identity();
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_BROKER_REGISTRATION_TOKEN: "register-secret",
  };
  const registration = await registerBrokerInstance({
    env,
    request: request({ authorization: "Bearer register-secret" }),
    body: {
      encryptionPublicKey: client.publicKey,
      relayAccountId: "responder",
      whatsappNumber: "+49 176 0000000",
    },
  });

  const body = {
    channelId: registration.channelId,
    envelope: encryptBrokerChannelPayload({
      whatsappNumber: "+49 176 0000000",
      text: "hello",
    }, {
      clientPrivateKey: client.privateKey,
      brokerPublicKey: registration.broker.publicKey,
      channelId: registration.channelId,
    }),
  };
  const decrypted = await decryptBrokerInstanceRequest(registration.instanceId, body, env);

  assert.equal(decrypted.record.instanceId, registration.instanceId);
  assert.equal(decrypted.record.relayAccountId, "responder");
  assert.equal(decrypted.payload.whatsappNumber, "+49 176 0000000");
  assert.equal(decrypted.payload.text, "hello");

  await assert.rejects(
    () => decryptBrokerInstanceRequest(registration.instanceId, { ...body, channelId: "wrong" }, env),
    /broker_channel_denied/,
  );
});

test("broker instance channel can deliver encrypted payloads back to the client", async () => {
  const parentHome = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-broker-parent-send-"));
  const tenantHome = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-broker-tenant-receive-"));
  const client = __brokerInstanceRegistryTestInternals.createX25519Identity();
  const env = {
    ORKESTR_HOME: parentHome,
    ORKESTR_BROKER_REGISTRATION_TOKEN: "register-secret",
  };
  const registration = await registerBrokerInstance({
    env,
    request: request({ authorization: "Bearer register-secret" }),
    body: {
      encryptionPublicKey: client.publicKey,
      endpointBaseUrl: "https://tenant.example.test",
    },
  });
  await fs.mkdir(path.join(tenantHome, "secrets"), { recursive: true });
  await fs.writeFile(path.join(tenantHome, "secrets", "broker-client-identity.json"), JSON.stringify({
    privateKey: client.privateKey,
    publicKey: client.publicKey,
  }));
  await fs.writeFile(path.join(tenantHome, "secrets", "broker-client-registration.json"), JSON.stringify({
    instanceId: registration.instanceId,
    channelId: registration.channelId,
    brokerBaseUrl: "https://broker.example.test",
    brokerPublicKey: registration.broker.publicKey,
  }));

  const encrypted = await encryptBrokerInstancePayload(registration.instanceId, {
    provider: "google_workspace",
    token: { accessToken: "tenant-access" },
  }, env);
  const decrypted = await decryptBrokerClientPayload(encrypted.body, { ORKESTR_HOME: tenantHome });

  assert.equal(encrypted.record.endpointBaseUrl, "https://tenant.example.test");
  assert.equal(decrypted.registration.instanceId, registration.instanceId);
  assert.equal(decrypted.payload.provider, "google_workspace");
  assert.equal(decrypted.payload.token.accessToken, "tenant-access");
});

test("broker connect resolver fails closed for unknown and disabled instances", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-broker-connect-"));
  const client = __brokerInstanceRegistryTestInternals.createX25519Identity();
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_BROKER_INSTANCE_STORE: "json",
    ORKESTR_BROKER_REGISTRATION_TOKEN: "register-secret",
  };
  const registration = await registerBrokerInstance({
    env,
    request: request({ authorization: "Bearer register-secret" }),
    body: { encryptionPublicKey: client.publicKey },
  });
  const registryPath = path.join(home, "broker-instances.json");
  const registry = JSON.parse(await fs.readFile(registryPath, "utf8"));
  registry.instances[0].status = "disabled";
  registry.instances[0].disabledAt = new Date().toISOString();
  await fs.writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`);

  await assert.rejects(
    () => resolveBrokerConnectInstance("missing", env),
    /broker_instance_not_found/,
  );
  await assert.rejects(
    () => resolveBrokerConnectInstance(registration.instanceId, env),
    /broker_instance_disabled/,
  );
});

test("broker registration endpoints are allowed before browser pairing", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-broker-prepair-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_AUTH_REQUIRED: "1",
  };

  const register = await authorizeHttpRequest({ method: "POST", url: "/api/broker/instances/register", headers: {} }, env);
  const heartbeat = await authorizeHttpRequest({ method: "POST", url: "/api/broker/instances/demo/heartbeat", headers: {} }, env);
  const onboarding = await authorizeHttpRequest({ method: "POST", url: "/api/broker/instances/demo/whatsapp/onboarding", headers: {} }, env);
  const history = await authorizeHttpRequest({ method: "POST", url: "/api/broker/instances/demo/whatsapp/history", headers: {} }, env);
  const googleConnect = await authorizeHttpRequest({ method: "POST", url: "/api/broker/instances/demo/google-workspace/connect-link", headers: {} }, env);
  const googleRefresh = await authorizeHttpRequest({ method: "POST", url: "/api/broker/instances/demo/google-workspace/refresh-token", headers: {} }, env);
  const googleGrant = await authorizeHttpRequest({ method: "POST", url: "/api/broker/google-workspace/grants", headers: {} }, env);
  const privateRoute = await authorizeHttpRequest({ method: "GET", url: "/api/broker/instances", headers: {} }, env);

  assert.equal(register.ok, true);
  assert.equal(heartbeat.ok, true);
  assert.equal(onboarding.ok, true);
  assert.equal(history.ok, true);
  assert.equal(googleConnect.ok, true);
  assert.equal(googleRefresh.ok, true);
  assert.equal(googleGrant.ok, true);
  assert.equal(privateRoute.ok, false);
  assert.equal(privateRoute.statusCode, 401);
});
