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
  encryptBrokerInstanceProxyPayload,
  decryptBrokerInstanceRequest,
  ensureBrokerClientRegistration,
  heartbeatBrokerInstance,
  listBrokerInstances,
  readBrokerInstanceRegistry,
  registerBrokerInstance,
  resolveBrokerConnectInstance,
  sendBrokerClientHeartbeat,
  writeBrokerInstanceRegistry,
} from "../packages/core/src/broker-instance-registry.js";
import { authorizeHttpRequest } from "../packages/core/src/security.js";
import { startServer } from "../apps/server/src/server.js";
import { isInstancePublicRef } from "../packages/core/src/canonical-public-references.js";
import { generateInstancePublicRef } from "../packages/core/src/canonical-public-references.js";
import { readInstanceIdentity, writeInstanceIdentity } from "../packages/core/src/instance-identity.js";
import { normalizeBrokerBaseUrl, readBrokerRegistrationIntent } from "../packages/core/src/broker-registration-intent.js";
import { writeSqliteBrokerRegistry } from "../packages/core/src/broker-instance-sqlite-store.js";

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

function saveEnv(keys) {
  return Object.fromEntries(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(prior) {
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function registrationIntentId() {
  return crypto.randomBytes(32).toString("base64url");
}

function localBrokerFetch(brokerEnv, calls = []) {
  return async (_url, options = {}) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    try {
      const payload = await registerBrokerInstance({
        env: brokerEnv,
        body,
        request: request(options.headers || {}),
      });
      return { ok: true, status: 200, async json() { return payload; } };
    } catch (error) {
      return {
        ok: false,
        status: Number(error?.statusCode || 500),
        async json() { return { ok: false, error: error?.message || "broker_registration_failed" }; },
      };
    }
  };
}

test("broker registration issues broker UUID and encrypted channel bootstrap", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-broker-register-"));
  const client = __brokerInstanceRegistryTestInternals.createX25519Identity();
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_BROKER_REGISTRATION_TOKEN: "register-secret",
    ORKESTR_CANONICAL_INSTANCE_URLS: "1",
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
  assert.equal(isInstancePublicRef(registration.publicRef), true);
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
  assert.equal(instances.instances[0].publicRef, registration.publicRef);
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
    ORKESTR_CANONICAL_INSTANCE_URLS: "1",
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
  assert.equal(isInstancePublicRef(listed.instances[0].publicRef), true);
  assert.equal(listed.instances[0].endpointBaseUrl, "http://10.0.0.12:19822");
  assert.equal(listed.instances[0].connectBaseUrl, "https://connect.orkestr.de");
  assert.equal(listed.instances[0].relayAccountId, "responder");
  assert.equal(listed.instances[0].whatsappChatHashConfigured, true);
  assert.equal(listed.instances[0].whatsappChatHash, undefined);
  assert.equal(JSON.stringify(listed).includes("49176123456"), false);
  assert.equal(JSON.stringify(listed).includes("+49 176 123456"), false);
  assert.equal(resolved.ok, true);
  assert.equal(resolved.instance.instanceId, registration.instanceId);
  assert.equal(resolved.instance.publicRef, registration.publicRef);
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

test("broker public reference is authoritative for first registration, cache reuse, and reconnect", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-broker-client-public-ref-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const publicRef = generateInstancePublicRef();
  const calls = [];
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_BROKER_BASE_URL: "https://broker.example.test",
    ORKESTR_CANONICAL_INSTANCE_URLS: "1",
  };
  const fetchImpl = async (_url, options = {}) => {
    calls.push(JSON.parse(options.body));
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          ok: true, instanceId: "11111111-2222-4333-8444-555555555555", publicRef,
          channelId: `channel-${calls.length}`, registeredAt: "2026-08-12T12:00:00.000Z",
          broker: { keyId: "broker-key", publicKey: "synthetic-broker-key" },
        };
      },
    };
  };
  const first = await ensureBrokerClientRegistration(env, { fetchImpl });
  const reused = await ensureBrokerClientRegistration(env, { fetchImpl });
  const reconnect = await ensureBrokerClientRegistration({ ...env, ORKESTR_BROKER_FORCE_REREGISTER: "1" }, { fetchImpl });
  assert.equal(first.publicRef, publicRef);
  assert.equal(reused.reused, true);
  assert.equal(reconnect.publicRef, publicRef);
  assert.equal(calls[1].brokerInstanceId, first.instanceId);
  assert.equal((await readInstanceIdentity(env)).publicRef, publicRef);
});

test("broker public reference accepts equal persisted identity and rejects conflicts during intent recovery", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-broker-client-ref-conflict-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const publicRef = generateInstancePublicRef();
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_BROKER_BASE_URL: "https://broker.example.test",
    ORKESTR_BROKER_REGISTRATION_TOKEN: "synthetic-registration-token",
    ORKESTR_CANONICAL_INSTANCE_URLS: "1",
  };
  let responseRef = publicRef;
  const fetchImpl = async () => ({
    ok: true, status: 200,
    async json() { return { ok: true, instanceId: "broker-instance", publicRef: responseRef, channelId: "channel", broker: { publicKey: "key" } }; },
  });
  await assert.rejects(ensureBrokerClientRegistration(env, {
    fetchImpl,
    async writeRegistrationCache() { throw new Error("synthetic_cache_crash"); },
  }), /broker_client_registration_cache_write_failed/);
  assert.equal((await readInstanceIdentity(env)).publicRef, publicRef);
  const conflictRef = generateInstancePublicRef();
  responseRef = conflictRef;
  await assert.rejects(ensureBrokerClientRegistration(env, { fetchImpl }), /broker_instance_public_ref_conflict/);
  assert.equal((await readInstanceIdentity(env)).publicRef, publicRef);
});

test("broker client registration recovers a cache-write crash from persisted canonical identity", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-broker-client-cache-crash-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const instanceId = "11111111-2222-4333-8444-666666666666";
  const publicRef = generateInstancePublicRef();
  const calls = [];
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_BROKER_BASE_URL: "https://broker.example.test",
    ORKESTR_CANONICAL_INSTANCE_URLS: "1",
  };
  const fetchImpl = async (_url, options = {}) => {
    calls.push(JSON.parse(options.body));
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          ok: true,
          instanceId,
          publicRef,
          channelId: `channel-${calls.length}`,
          broker: { keyId: "broker-key", publicKey: "synthetic-broker-key" },
        };
      },
    };
  };

  await assert.rejects(
    ensureBrokerClientRegistration(env, {
      fetchImpl,
      async writeRegistrationCache() {
        throw new Error("synthetic_cache_write_failure");
      },
    }),
    (error) => {
      assert.equal(error.message, "broker_client_registration_cache_write_failed");
      assert.equal(error.recoverable, true);
      assert.equal(error.instanceId, instanceId);
      assert.equal(error.publicRef, publicRef);
      assert.match(error.cause?.message || "", /synthetic_cache_write_failure/);
      return true;
    },
  );
  const persistedIdentity = await readInstanceIdentity(env);
  assert.equal(persistedIdentity.internalInstanceId, instanceId);
  assert.equal(persistedIdentity.publicRef, publicRef);
  await assert.rejects(
    fs.access(path.join(home, "secrets", "broker-client-registration.json")),
    (error) => error?.code === "ENOENT",
  );

  const recovered = await ensureBrokerClientRegistration(env, { fetchImpl });
  assert.equal(recovered.instanceId, instanceId);
  assert.equal(recovered.publicRef, publicRef);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].brokerInstanceId, undefined);
  assert.equal(calls[1].brokerInstanceId, instanceId);
  const cached = JSON.parse(await fs.readFile(path.join(home, "secrets", "broker-client-registration.json"), "utf8"));
  assert.equal(cached.instanceId, instanceId);
  assert.equal(cached.publicRef, publicRef);
});

test("broker client registration without recovery evidence fails before a conflicting remote response", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-broker-client-cache-retry-conflict-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const instanceId = "11111111-2222-4333-8444-777777777777";
  const publicRef = generateInstancePublicRef();
  const conflictingRef = generateInstancePublicRef();
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_BROKER_BASE_URL: "https://broker.example.test",
    ORKESTR_CANONICAL_INSTANCE_URLS: "1",
  };
  await writeInstanceIdentity({ internalInstanceId: instanceId, publicRef }, env);
  let calls = 0;
  const fetchImpl = async (_url, options = {}) => {
    calls += 1;
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          ok: true,
          instanceId,
          publicRef: conflictingRef,
          channelId: "channel-conflict",
          broker: { publicKey: "synthetic-broker-key" },
        };
      },
    };
  };

  assert.deepEqual(await ensureBrokerClientRegistration(env, { fetchImpl }), {
    ok: false,
    reason: "broker_registration_recovery_intent_missing",
    status: 409,
  });
  assert.equal(calls, 0);
  assert.equal((await readInstanceIdentity(env)).publicRef, publicRef);
  await assert.rejects(
    fs.access(path.join(home, "secrets", "broker-client-registration.json")),
    (error) => error?.code === "ENOENT",
  );
});

test("canonical broker client registration serializes concurrent first registration", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-broker-client-concurrent-first-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const instanceId = "11111111-2222-4333-8444-888888888888";
  const publicRef = generateInstancePublicRef();
  let calls = 0;
  let releaseRegistration;
  const registrationPaused = new Promise((resolve) => {
    releaseRegistration = resolve;
  });
  let firstCallStarted;
  const firstCallObserved = new Promise((resolve) => {
    firstCallStarted = resolve;
  });
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_BROKER_BASE_URL: "https://broker.example.test",
    ORKESTR_CANONICAL_INSTANCE_URLS: "1",
  };
  const fetchImpl = async () => {
    calls += 1;
    firstCallStarted();
    await registrationPaused;
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          ok: true,
          instanceId,
          publicRef,
          channelId: "channel-concurrent",
          broker: { keyId: "broker-key", publicKey: "synthetic-broker-key" },
        };
      },
    };
  };

  const first = ensureBrokerClientRegistration(env, { fetchImpl });
  await firstCallObserved;
  const second = ensureBrokerClientRegistration(env, { fetchImpl });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, 1);
  releaseRegistration();
  const [registered, reused] = await Promise.all([first, second]);

  assert.equal(calls, 1);
  assert.equal(registered.reused, false);
  assert.equal(reused.reused, true);
  assert.equal(registered.instanceId, instanceId);
  assert.equal(reused.instanceId, instanceId);
  assert.equal(reused.publicRef, publicRef);
});

test("feature-off broker force and target changes do not request the cached instance id", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-broker-client-legacy-reregister-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const calls = [];
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_BROKER_BASE_URL: "https://broker.example.test",
    ORKESTR_DEMO_WHATSAPP_NUMBER: "+49 176 111111",
  };
  const fetchImpl = async (_url, options = {}) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          ok: true,
          instanceId: `legacy-instance-${calls.length}`,
          channelId: `legacy-channel-${calls.length}`,
          broker: { keyId: "broker-key", publicKey: "synthetic-broker-key" },
        };
      },
    };
  };

  const first = await ensureBrokerClientRegistration(env, { fetchImpl });
  const forced = await ensureBrokerClientRegistration({ ...env, ORKESTR_BROKER_FORCE_REREGISTER: "1" }, { fetchImpl });
  const changedTarget = await ensureBrokerClientRegistration({
    ...env,
    ORKESTR_DEMO_WHATSAPP_NUMBER: "+49 176 222222",
  }, { fetchImpl });

  assert.equal(first.instanceId, "legacy-instance-1");
  assert.equal(forced.instanceId, "legacy-instance-2");
  assert.equal(changedTarget.instanceId, "legacy-instance-3");
  assert.equal(calls.length, 3);
  assert.equal(calls.every((body) => body.brokerInstanceId === undefined), true);
  assert.equal(calls.every((body) => body.registrationIntentId === undefined), true);
});

test("legacy broker registration adopts canonically with channel proof in open and token modes", async (t) => {
  for (const mode of ["open", "token"]) {
    const clientHome = await fs.mkdtemp(path.join(os.tmpdir(), `orkestr-broker-adopt-client-${mode}-`));
    const brokerHome = await fs.mkdtemp(path.join(os.tmpdir(), `orkestr-broker-adopt-server-${mode}-`));
    t.after(() => Promise.all([
      fs.rm(clientHome, { recursive: true, force: true }),
      fs.rm(brokerHome, { recursive: true, force: true }),
    ]));
    const tokenEnv = mode === "token" ? { ORKESTR_BROKER_REGISTRATION_TOKEN: "adoption-token" } : {};
    const legacyClientEnv = {
      ORKESTR_HOME: clientHome,
      ORKESTR_BROKER_BASE_URL: "https://broker.example.test///",
      ...tokenEnv,
    };
    const legacyBrokerEnv = {
      ORKESTR_HOME: brokerHome,
      ORKESTR_BROKER_INSTANCE_STORE: "json",
      ...(mode === "open" ? { ORKESTR_BROKER_REGISTRATION_OPEN: "1" } : tokenEnv),
    };
    const calls = [];
    const legacy = await ensureBrokerClientRegistration(legacyClientEnv, {
      fetchImpl: localBrokerFetch(legacyBrokerEnv, calls),
    });
    assert.equal(legacy.publicRef, undefined);
    assert.equal((await listBrokerInstances(legacyBrokerEnv)).instances.length, 1);

    const canonicalClientEnv = {
      ...legacyClientEnv,
      ORKESTR_BROKER_BASE_URL: "https://broker.example.test",
      ORKESTR_CANONICAL_INSTANCE_URLS: "1",
    };
    const canonicalBrokerEnv = { ...legacyBrokerEnv, ORKESTR_CANONICAL_INSTANCE_URLS: "1" };
    const adopted = await ensureBrokerClientRegistration(canonicalClientEnv, {
      fetchImpl: localBrokerFetch(canonicalBrokerEnv, calls),
    });
    const instances = await listBrokerInstances(canonicalBrokerEnv);
    assert.equal(instances.instances.length, 1);
    assert.equal(adopted.instanceId, legacy.instanceId);
    assert.equal(adopted.publicRef, instances.instances[0].publicRef);
    assert.equal(isInstancePublicRef(adopted.publicRef), true);
    assert.equal(calls[1].brokerInstanceId, legacy.instanceId);
    assert.ok(calls[1].legacyAdoptionProof?.envelope?.ciphertext);
    assert.ok(calls[1].registrationIntentId);

    const reused = await ensureBrokerClientRegistration({
      ...canonicalClientEnv,
      ORKESTR_BROKER_BASE_URL: "https://broker.example.test/",
    }, { fetchImpl: localBrokerFetch(canonicalBrokerEnv, calls) });
    assert.equal(reused.reused, true);
    assert.equal(reused.instanceId, legacy.instanceId);
    assert.equal(calls.length, 2);
    const cache = JSON.parse(await fs.readFile(path.join(clientHome, "secrets", "broker-client-registration.json"), "utf8"));
    assert.equal(cache.brokerBaseUrl, "https://broker.example.test");
  }
});

test("legacy adoption exact replay recovers identity-sync and cache-write loss in open and token modes", async (t) => {
  for (const mode of ["open", "token"]) {
    for (const failure of ["identity", "cache"]) {
      const clientHome = await fs.mkdtemp(path.join(os.tmpdir(), `orkestr-broker-adopt-retry-${mode}-${failure}-`));
      const brokerHome = await fs.mkdtemp(path.join(os.tmpdir(), `orkestr-broker-adopt-retry-server-${mode}-${failure}-`));
      t.after(() => Promise.all([
        fs.rm(clientHome, { recursive: true, force: true }),
        fs.rm(brokerHome, { recursive: true, force: true }),
      ]));
      const tokenEnv = mode === "token" ? { ORKESTR_BROKER_REGISTRATION_TOKEN: "adoption-retry-token" } : {};
      const clientEnv = { ORKESTR_HOME: clientHome, ORKESTR_BROKER_BASE_URL: "https://broker.example.test/", ...tokenEnv };
      const brokerEnv = {
        ORKESTR_HOME: brokerHome,
        ORKESTR_BROKER_INSTANCE_STORE: "json",
        ...(mode === "open" ? { ORKESTR_BROKER_REGISTRATION_OPEN: "1" } : tokenEnv),
      };
      const calls = [];
      const legacy = await ensureBrokerClientRegistration(clientEnv, { fetchImpl: localBrokerFetch(brokerEnv, calls) });
      const canonicalClientEnv = { ...clientEnv, ORKESTR_CANONICAL_INSTANCE_URLS: "1" };
      const canonicalBrokerEnv = { ...brokerEnv, ORKESTR_CANONICAL_INSTANCE_URLS: "1" };
      const failureOptions = failure === "identity"
        ? { async syncRegistrationIdentity() { throw new Error("synthetic_adoption_identity_loss"); } }
        : { async writeRegistrationCache() { throw new Error("synthetic_adoption_cache_loss"); } };
      await assert.rejects(ensureBrokerClientRegistration(canonicalClientEnv, {
        fetchImpl: localBrokerFetch(canonicalBrokerEnv, calls),
        ...failureOptions,
      }), /synthetic_adoption_identity_loss|broker_client_registration_cache_write_failed/);
      assert.equal((await listBrokerInstances(canonicalBrokerEnv)).instances.length, 1);
      const pending = await readBrokerRegistrationIntent(canonicalClientEnv);
      assert.ok(pending?.registrationIntentId);

      const recovered = await ensureBrokerClientRegistration({
        ...canonicalClientEnv,
        ORKESTR_BROKER_BASE_URL: "https://broker.example.test",
      }, { fetchImpl: localBrokerFetch(canonicalBrokerEnv, calls) });
      const instances = await listBrokerInstances(canonicalBrokerEnv);
      assert.equal(instances.instances.length, 1);
      assert.equal(recovered.instanceId, legacy.instanceId);
      assert.equal(recovered.publicRef, instances.instances[0].publicRef);
      assert.equal(calls.length, 3);
      assert.equal(calls[1].registrationIntentId, pending.registrationIntentId);
      assert.equal(calls[2].registrationIntentId, pending.registrationIntentId);
      assert.ok(calls[2].legacyAdoptionProof?.envelope?.ciphertext);
      assert.equal(await readBrokerRegistrationIntent(canonicalClientEnv), null);
    }
  }
});

test("legacy adoption proof is possession-bound, intent-bound, and exact-replay safe", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-broker-adoption-proof-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const legacyEnv = { ORKESTR_HOME: home, ORKESTR_BROKER_REGISTRATION_OPEN: "1", ORKESTR_BROKER_INSTANCE_STORE: "json" };
  const canonicalEnv = { ...legacyEnv, ORKESTR_CANONICAL_INSTANCE_URLS: "1" };
  const client = __brokerInstanceRegistryTestInternals.createX25519Identity();
  const attacker = __brokerInstanceRegistryTestInternals.createX25519Identity();
  const target = "+49 176 111111";
  const legacy = await registerBrokerInstance({
    env: legacyEnv,
    request: request(),
    body: { encryptionPublicKey: client.publicKey, whatsappNumber: target, relayAccountId: "sender" },
  });
  const intent = registrationIntentId();
  const targetScopeHash = crypto.createHash("sha256").update(JSON.stringify({
    relayAccountId: "sender",
    whatsappTargetHash: crypto.createHash("sha256").update("49176111111@c.us").digest("hex"),
  })).digest("hex");
  const baseBody = {
    brokerInstanceId: legacy.instanceId,
    registrationIntentId: intent,
    encryptionPublicKey: client.publicKey,
    whatsappNumber: target,
    relayAccountId: "sender",
  };
  await assert.rejects(registerBrokerInstance({ env: canonicalEnv, request: request(), body: baseBody }), /broker_registration_adoption_proof_required/);

  const proofPayload = {
    kind: "broker_registration_legacy_adoption_v1",
    instanceId: legacy.instanceId,
    registrationIntentId: intent,
    authorizationCredentialHash: "open",
    targetScopeHash,
  };
  const proofWith = (privateKey, payload = proofPayload) => ({
    channelId: legacy.channelId,
    envelope: encryptBrokerChannelPayload(payload, {
      clientPrivateKey: privateKey,
      brokerPublicKey: legacy.broker.publicKey,
      channelId: legacy.channelId,
    }),
  });
  await assert.rejects(registerBrokerInstance({
    env: canonicalEnv,
    request: request(),
    body: { ...baseBody, legacyAdoptionProof: proofWith(attacker.privateKey) },
  }), /broker_registration_adoption_proof_denied/);
  await assert.rejects(registerBrokerInstance({
    env: canonicalEnv,
    request: request(),
    body: { ...baseBody, legacyAdoptionProof: proofWith(client.privateKey, { ...proofPayload, registrationIntentId: registrationIntentId() }) },
  }), /broker_registration_adoption_proof_mismatch/);
  await assert.rejects(registerBrokerInstance({
    env: canonicalEnv,
    request: request(),
    body: { ...baseBody, encryptionPublicKey: attacker.publicKey, legacyAdoptionProof: proofWith(client.privateKey) },
  }), /broker_registration_adoption_key_conflict/);
  await assert.rejects(registerBrokerInstance({
    env: canonicalEnv,
    request: request(),
    body: { ...baseBody, whatsappNumber: "+49 176 222222", legacyAdoptionProof: proofWith(client.privateKey) },
  }), /broker_registration_adoption_target_conflict/);

  const adopted = await registerBrokerInstance({
    env: canonicalEnv,
    request: request(),
    body: { ...baseBody, legacyAdoptionProof: proofWith(client.privateKey) },
  });
  assert.equal(adopted.instanceId, legacy.instanceId);
  assert.equal((await listBrokerInstances(canonicalEnv)).instances.length, 1);
  const replayed = await registerBrokerInstance({
    env: canonicalEnv,
    request: request(),
    body: { ...baseBody, legacyAdoptionProof: proofWith(client.privateKey) },
  });
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.instanceId, adopted.instanceId);
  assert.equal(replayed.publicRef, adopted.publicRef);
  assert.notEqual(replayed.channelId, adopted.channelId);
  await assert.rejects(registerBrokerInstance({
    env: canonicalEnv,
    request: request(),
    body: { ...baseBody, registrationIntentId: registrationIntentId(), legacyAdoptionProof: proofWith(client.privateKey) },
  }), /broker_requested_instance_id_requires_token|broker_registration_intent_rebind_denied/);
});

test("broker base URL normalization is strict and canonical", () => {
  assert.equal(normalizeBrokerBaseUrl("HTTPS://Broker.Example.Test:443/path///"), "https://broker.example.test/path");
  assert.equal(normalizeBrokerBaseUrl("http://broker.example.test:80/"), "http://broker.example.test");
  for (const invalid of [
    "file:///tmp/broker",
    "broker.example.test",
    "https://user@broker.example.test",
    "https://broker.example.test?tenant=one",
    "https://broker.example.test/#fragment",
  ]) {
    assert.throws(() => normalizeBrokerBaseUrl(invalid), /broker_registration_intent_broker_invalid/);
  }
});

test("registration intent recovers a real remote commit before local identity sync", async (t) => {
  const clientHome = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-broker-intent-client-sync-crash-"));
  const brokerHome = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-broker-intent-server-sync-crash-"));
  t.after(() => Promise.all([
    fs.rm(clientHome, { recursive: true, force: true }),
    fs.rm(brokerHome, { recursive: true, force: true }),
  ]));
  const clientEnv = {
    ORKESTR_HOME: clientHome,
    ORKESTR_BROKER_BASE_URL: "https://broker.example.test",
    ORKESTR_CANONICAL_INSTANCE_URLS: "1",
  };
  const brokerEnv = {
    ORKESTR_HOME: brokerHome,
    ORKESTR_BROKER_REGISTRATION_OPEN: "1",
    ORKESTR_CANONICAL_INSTANCE_URLS: "1",
    ORKESTR_BROKER_INSTANCE_STORE: "json",
  };
  const calls = [];
  const fetchImpl = localBrokerFetch(brokerEnv, calls);

  await assert.rejects(
    ensureBrokerClientRegistration(clientEnv, {
      fetchImpl,
      async syncRegistrationIdentity() { throw new Error("synthetic_identity_sync_crash"); },
    }),
    /synthetic_identity_sync_crash/,
  );
  const pending = await readBrokerRegistrationIntent(clientEnv);
  const afterCrash = await listBrokerInstances(brokerEnv);
  assert.equal(afterCrash.instances.length, 1);
  assert.equal(await readInstanceIdentity(clientEnv), null);

  const recovered = await ensureBrokerClientRegistration(clientEnv, { fetchImpl });
  const afterRecovery = await listBrokerInstances(brokerEnv);
  assert.equal(afterRecovery.instances.length, 1);
  assert.equal(recovered.instanceId, afterCrash.instances[0].instanceId);
  assert.equal(recovered.publicRef, afterCrash.instances[0].publicRef);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].registrationIntentId, pending.registrationIntentId);
  assert.equal(calls[1].registrationIntentId, pending.registrationIntentId);
  assert.equal(calls[1].brokerInstanceId, undefined);
  assert.equal(JSON.stringify(recovered).includes(pending.registrationIntentId), false);
  assert.equal(await readBrokerRegistrationIntent(clientEnv), null);
});

test("registration intent recovers a cache-write crash against a real open broker", async (t) => {
  const clientHome = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-broker-intent-client-cache-crash-"));
  const brokerHome = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-broker-intent-server-cache-crash-"));
  t.after(() => Promise.all([
    fs.rm(clientHome, { recursive: true, force: true }),
    fs.rm(brokerHome, { recursive: true, force: true }),
  ]));
  const clientEnv = {
    ORKESTR_HOME: clientHome,
    ORKESTR_BROKER_BASE_URL: "https://broker.example.test",
    ORKESTR_CANONICAL_INSTANCE_URLS: "1",
  };
  const brokerEnv = {
    ORKESTR_HOME: brokerHome,
    ORKESTR_BROKER_REGISTRATION_OPEN: "1",
    ORKESTR_CANONICAL_INSTANCE_URLS: "1",
    ORKESTR_BROKER_INSTANCE_STORE: "sqlite",
  };
  const calls = [];
  const fetchImpl = localBrokerFetch(brokerEnv, calls);

  await assert.rejects(ensureBrokerClientRegistration(clientEnv, {
    fetchImpl,
    async writeRegistrationCache() { throw new Error("synthetic_cache_crash"); },
  }), /broker_client_registration_cache_write_failed/);
  const identity = await readInstanceIdentity(clientEnv);
  const pending = await readBrokerRegistrationIntent(clientEnv);
  assert.ok(identity?.internalInstanceId);
  assert.ok(pending?.registrationIntentId);

  const recovered = await ensureBrokerClientRegistration(clientEnv, { fetchImpl });
  const instances = await listBrokerInstances(brokerEnv);
  assert.equal(instances.instances.length, 1);
  assert.equal(recovered.instanceId, identity.internalInstanceId);
  assert.equal(recovered.publicRef, identity.publicRef);
  assert.equal(calls[1].brokerInstanceId, identity.internalInstanceId);
  assert.equal(calls[1].registrationIntentId, pending.registrationIntentId);
  assert.equal(await readBrokerRegistrationIntent(clientEnv), null);
});

test("durable cache reconciles and cleans an exact leftover registration intent", async (t) => {
  const clientHome = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-broker-intent-cleanup-"));
  const brokerHome = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-broker-intent-cleanup-server-"));
  t.after(() => Promise.all([
    fs.rm(clientHome, { recursive: true, force: true }),
    fs.rm(brokerHome, { recursive: true, force: true }),
  ]));
  const clientEnv = { ORKESTR_HOME: clientHome, ORKESTR_BROKER_BASE_URL: "https://broker.example.test", ORKESTR_CANONICAL_INSTANCE_URLS: "1" };
  const brokerEnv = { ORKESTR_HOME: brokerHome, ORKESTR_BROKER_REGISTRATION_OPEN: "1", ORKESTR_CANONICAL_INSTANCE_URLS: "1", ORKESTR_BROKER_INSTANCE_STORE: "json" };
  let cleanupAttempts = 0;
  const registered = await ensureBrokerClientRegistration(clientEnv, {
    fetchImpl: localBrokerFetch(brokerEnv),
    async removeRegistrationIntent() {
      cleanupAttempts += 1;
      throw new Error("synthetic_cleanup_crash");
    },
  });
  assert.equal(cleanupAttempts, 1);
  assert.ok(await readBrokerRegistrationIntent(clientEnv));

  const reused = await ensureBrokerClientRegistration(clientEnv, { fetchImpl: localBrokerFetch(brokerEnv) });
  assert.equal(reused.reused, true);
  assert.equal(reused.instanceId, registered.instanceId);
  assert.equal(await readBrokerRegistrationIntent(clientEnv), null);
});

test("durable canonical cache rejects a relay-account-only scope change before network access", async (t) => {
  const clientHome = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-broker-intent-cache-relay-scope-"));
  const brokerHome = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-broker-intent-cache-relay-server-"));
  t.after(() => Promise.all([
    fs.rm(clientHome, { recursive: true, force: true }),
    fs.rm(brokerHome, { recursive: true, force: true }),
  ]));
  const clientEnv = {
    ORKESTR_HOME: clientHome,
    ORKESTR_BROKER_BASE_URL: "https://broker.example.test",
    ORKESTR_CANONICAL_INSTANCE_URLS: "1",
    ORKESTR_BROKER_WHATSAPP_RELAY_ACCOUNT_ID: "relay-one",
  };
  const brokerEnv = { ORKESTR_HOME: brokerHome, ORKESTR_BROKER_REGISTRATION_OPEN: "1", ORKESTR_CANONICAL_INSTANCE_URLS: "1", ORKESTR_BROKER_INSTANCE_STORE: "json" };
  await ensureBrokerClientRegistration(clientEnv, { fetchImpl: localBrokerFetch(brokerEnv) });
  let calls = 0;
  await assert.rejects(ensureBrokerClientRegistration({
    ...clientEnv,
    ORKESTR_BROKER_WHATSAPP_RELAY_ACCOUNT_ID: "relay-two",
  }, {
    fetchImpl: async () => { calls += 1; throw new Error("unexpected_remote_call"); },
  }), /broker_registration_target_scope_conflict/);
  assert.equal(calls, 0);
});

test("broker intent replay rotates one channel, permits operational updates, and rejects identity scope changes", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-broker-intent-binding-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_BROKER_REGISTRATION_OPEN: "1",
    ORKESTR_CANONICAL_INSTANCE_URLS: "1",
    ORKESTR_BROKER_INSTANCE_STORE: "sqlite",
  };
  const client = __brokerInstanceRegistryTestInternals.createX25519Identity();
  const otherClient = __brokerInstanceRegistryTestInternals.createX25519Identity();
  const intent = registrationIntentId();
  const first = await registerBrokerInstance({
    env,
    request: request(),
    body: {
      registrationIntentId: intent,
      encryptionPublicKey: client.publicKey,
      whatsappNumber: "+49 176 111111",
      version: "1.0.0",
      endpointBaseUrl: "https://old.example.test",
    },
  });
  assert.equal(JSON.stringify(first).includes(intent), false);
  const replay = await registerBrokerInstance({
    env,
    request: request(),
    body: {
      registrationIntentId: intent,
      encryptionPublicKey: client.publicKey,
      whatsappNumber: "+49 176 111111",
      version: "2.0.0",
      endpointBaseUrl: "https://new.example.test",
    },
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.instanceId, first.instanceId);
  assert.equal(replay.publicRef, first.publicRef);
  assert.notEqual(replay.channelId, first.channelId);
  const sharedSecret = __brokerInstanceRegistryTestInternals.deriveSharedSecret(client.privateKey, replay.broker.publicKey);
  const channelKey = __brokerInstanceRegistryTestInternals.deriveChannelKey(sharedSecret, replay.channelId);
  const welcome = __brokerInstanceRegistryTestInternals.decryptJson(replay.encryptedWelcome, channelKey);
  assert.equal(welcome.instanceId, first.instanceId);
  const instances = await listBrokerInstances(env);
  assert.equal(instances.instances.length, 1);
  assert.equal(JSON.stringify(instances).includes(intent), false);
  assert.equal(instances.instances[0].version, "2.0.0");
  assert.equal(instances.instances[0].endpointBaseUrl, "https://new.example.test");

  await assert.rejects(registerBrokerInstance({
    env,
    request: request(),
    body: { registrationIntentId: intent, encryptionPublicKey: otherClient.publicKey, whatsappNumber: "+49 176 111111" },
  }), /broker_registration_intent_binding_conflict/);
  await assert.rejects(registerBrokerInstance({
    env,
    request: request(),
    body: { registrationIntentId: intent, encryptionPublicKey: client.publicKey, whatsappNumber: "+49 176 222222" },
  }), /broker_registration_intent_binding_conflict/);
  await assert.rejects(registerBrokerInstance({
    env,
    request: request({ authorization: "Bearer different-open-scope" }),
    body: { registrationIntentId: intent, encryptionPublicKey: client.publicKey, whatsappNumber: "+49 176 111111" },
  }), /broker_registration_intent_binding_conflict/);
  await assert.rejects(registerBrokerInstance({
    env,
    request: request(),
    body: { brokerInstanceId: first.instanceId, encryptionPublicKey: client.publicKey, whatsappNumber: "+49 176 111111" },
  }), /broker_requested_instance_id_requires_token/);
  const events = await fs.readFile(path.join(home, "events.jsonl"), "utf8");
  assert.equal(events.includes(intent), false);
  assert.equal(JSON.stringify(await readBrokerInstanceRegistry(env)).includes(intent), false);
});

test("broker registration intent hashes stay unique in JSON and SQLite persistence", async (t) => {
  for (const store of ["json", "sqlite"]) {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), `orkestr-broker-intent-unique-${store}-`));
    t.after(() => fs.rm(home, { recursive: true, force: true }));
    const env = {
      ORKESTR_HOME: home,
      ORKESTR_BROKER_REGISTRATION_OPEN: "1",
      ORKESTR_CANONICAL_INSTANCE_URLS: "1",
      ORKESTR_BROKER_INSTANCE_STORE: store,
    };
    const client = __brokerInstanceRegistryTestInternals.createX25519Identity();
    await registerBrokerInstance({ env, request: request(), body: { registrationIntentId: registrationIntentId(), encryptionPublicKey: client.publicKey } });
    await registerBrokerInstance({ env, request: request(), body: { registrationIntentId: registrationIntentId(), encryptionPublicKey: client.publicKey } });
    const registry = await readBrokerInstanceRegistry(env);
    registry.instances[1].registrationIntentHash = registry.instances[0].registrationIntentHash;
    await assert.rejects(writeBrokerInstanceRegistry(registry, env), /broker_registration_intent_duplicate/);
    assert.equal((await listBrokerInstances(env)).instances.length, 2);
    if (store === "sqlite") {
      const directHome = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-broker-intent-direct-sqlite-"));
      t.after(() => fs.rm(directHome, { recursive: true, force: true }));
      await assert.rejects(writeSqliteBrokerRegistry(registry, {
        ...env,
        ORKESTR_HOME: directHome,
        ORKESTR_BROKER_INSTANCES_DB: path.join(directHome, "broker-instances.sqlite"),
      }), /UNIQUE constraint failed/);
      const mutation = await readBrokerInstanceRegistry(env);
      mutation.instances[0].registrationIntentBindingHash = crypto.randomBytes(32).toString("hex");
      await assert.rejects(writeSqliteBrokerRegistry(mutation, env), /broker_registration_intent_binding_immutable/);
    }
  }
});

test("pending local registration intent rejects target and authentication scope changes", async (t) => {
  for (const changedScope of ["target", "relay", "auth"]) {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), `orkestr-broker-intent-client-${changedScope}-`));
    t.after(() => fs.rm(home, { recursive: true, force: true }));
    const baseEnv = {
      ORKESTR_HOME: home,
      ORKESTR_BROKER_BASE_URL: "https://broker.example.test",
      ORKESTR_CANONICAL_INSTANCE_URLS: "1",
      ORKESTR_DEMO_WHATSAPP_NUMBER: "+49 176 111111",
      ORKESTR_BROKER_REGISTRATION_TOKEN: "registration-token-one",
    };
    let calls = 0;
    const unavailableBroker = async () => {
      calls += 1;
      throw new Error("synthetic_network_failure");
    };
    await assert.rejects(ensureBrokerClientRegistration(baseEnv, { fetchImpl: unavailableBroker }), /synthetic_network_failure/);
    assert.ok(await readBrokerRegistrationIntent(baseEnv));
    const changedEnv = changedScope === "target"
      ? { ...baseEnv, ORKESTR_DEMO_WHATSAPP_NUMBER: "+49 176 222222" }
      : changedScope === "relay"
        ? { ...baseEnv, ORKESTR_BROKER_WHATSAPP_RELAY_ACCOUNT_ID: "different-relay" }
      : { ...baseEnv, ORKESTR_BROKER_REGISTRATION_TOKEN: "registration-token-two" };
    await assert.rejects(
      ensureBrokerClientRegistration(changedEnv, { fetchImpl: unavailableBroker }),
      /broker_registration_intent_binding_conflict/,
    );
    assert.equal(calls, 1);
  }
});

test("durable canonical cache rejects an authentication-scope change before reuse or network access", async (t) => {
  const clientHome = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-broker-intent-cache-auth-scope-"));
  const brokerHome = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-broker-intent-cache-auth-server-"));
  t.after(() => Promise.all([
    fs.rm(clientHome, { recursive: true, force: true }),
    fs.rm(brokerHome, { recursive: true, force: true }),
  ]));
  const clientEnv = {
    ORKESTR_HOME: clientHome,
    ORKESTR_BROKER_BASE_URL: "https://broker.example.test",
    ORKESTR_CANONICAL_INSTANCE_URLS: "1",
    ORKESTR_BROKER_REGISTRATION_TOKEN: "token-one",
  };
  const brokerEnv = {
    ORKESTR_HOME: brokerHome,
    ORKESTR_BROKER_REGISTRATION_TOKEN: "token-one",
    ORKESTR_CANONICAL_INSTANCE_URLS: "1",
    ORKESTR_BROKER_INSTANCE_STORE: "json",
  };
  await ensureBrokerClientRegistration(clientEnv, { fetchImpl: localBrokerFetch(brokerEnv) });
  let calls = 0;
  await assert.rejects(ensureBrokerClientRegistration({
    ...clientEnv,
    ORKESTR_BROKER_REGISTRATION_TOKEN: "token-two",
  }, {
    fetchImpl: async () => { calls += 1; throw new Error("unexpected_remote_call"); },
  }), /broker_registration_auth_scope_conflict/);
  assert.equal(calls, 0);
});

test("canonical recovery without cache or intent reports an explicit diagnostic in open and token modes", async (t) => {
  for (const mode of ["open", "token"]) {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), `orkestr-broker-intent-missing-${mode}-`));
    t.after(() => fs.rm(home, { recursive: true, force: true }));
    const env = {
      ORKESTR_HOME: home,
      ORKESTR_BROKER_BASE_URL: "https://broker.example.test",
      ORKESTR_CANONICAL_INSTANCE_URLS: "1",
      ...(mode === "token" ? { ORKESTR_BROKER_REGISTRATION_TOKEN: "synthetic-registration-token" } : {}),
    };
    await writeInstanceIdentity({
      internalInstanceId: "11111111-2222-4333-8444-999999999999",
      publicRef: generateInstancePublicRef(),
    }, env);
    let calls = 0;
    const result = await ensureBrokerClientRegistration(env, { fetchImpl: async () => { calls += 1; throw new Error("unexpected_remote_call"); } });
    assert.deepEqual(result, { ok: false, reason: "broker_registration_recovery_intent_missing", status: 409 });
    assert.equal(calls, 0);
  }
});

test("broker client registration prefers canonical broker base over demo fallback", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-broker-client-base-precedence-"));
  const calls = [];
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_BROKER_BASE_URL: "https://broker.orkestr.test",
    ORKESTR_DEMO_BROKER_BASE_URL: "https://connect.crawlerai.de",
  };
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), body: JSON.parse(options.body) });
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          ok: true,
          instanceId: "instance-canonical",
          channelId: "channel-canonical",
          registeredAt: "2026-06-11T00:00:00.000Z",
          broker: {
            keyId: "broker-key-1",
            publicKey: "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VuAyEA2IFd3Rdi7NTih5q0Glq82pzgjEycOnu/MpuxJdGzGn4=\n-----END PUBLIC KEY-----\n",
          },
        };
      },
    };
  };

  const registered = await ensureBrokerClientRegistration(env, { fetchImpl });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://broker.orkestr.test/api/broker/instances/register");
  assert.equal(registered.brokerBaseUrl, "https://broker.orkestr.test");
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
    body: {
      encryptionPublicKey: client.publicKey,
      version: "before",
      endpointBaseUrl: "http://10.43.10.12",
      connectBaseUrl: "https://connect.crawlerai.de",
      setupUrl: "https://connect.crawlerai.de/setup/pairing?return=%2Fsetup",
      relayAccountId: "sender",
    },
  });

  await assert.rejects(
    () => heartbeatBrokerInstance(registration.instanceId, {
      env,
      request: { ip: "198.51.100.11", headers: {} },
      body: { channelId: registration.channelId, envelope: { iv: "bad", ciphertext: "bad", tag: "bad" } },
    }),
    /invalid_encrypted_payload|Unsupported state|unable to authenticate/i,
  );

  const envelope = encryptBrokerChannelPayload({
    version: "after",
    connectBaseUrl: "https://connect.orkestr.de",
    setupUrl: "",
    relayAccountId: "",
  }, {
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
  assert.equal(instances.instances[0].endpointBaseUrl, "http://10.43.10.12");
  assert.equal(instances.instances[0].connectBaseUrl, "https://connect.orkestr.de");
  assert.equal(instances.instances[0].setupUrl, "");
  assert.equal(instances.instances[0].relayAccountId, "");
  assert.ok(instances.instances[0].lastHeartbeatAt);
});

test("broker client heartbeat registers stable instance id over HTTP and refreshes auth state", async () => {
  const brokerHome = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-broker-heartbeat-http-"));
  const tenantHome = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-broker-heartbeat-client-"));
  const envKeys = [
    "ORKESTR_HOME",
    "ORKESTR_AUTH_REQUIRED",
    "ORKESTR_RECOVER_RUNNING_ON_START",
    "ORKESTR_BROKER_REGISTRATION_TOKEN",
    "ORKESTR_BROKER_CLIENT_HEARTBEAT",
    "ORKESTR_DEMO_BROKER_BASE_URL",
    "ORKESTR_BROKER_BASE_URL",
  ];
  const prior = saveEnv(envKeys);
  process.env.ORKESTR_HOME = brokerHome;
  process.env.ORKESTR_AUTH_REQUIRED = "1";
  process.env.ORKESTR_RECOVER_RUNNING_ON_START = "0";
  process.env.ORKESTR_BROKER_REGISTRATION_TOKEN = "register-secret";
  delete process.env.ORKESTR_BROKER_CLIENT_HEARTBEAT;
  delete process.env.ORKESTR_DEMO_BROKER_BASE_URL;
  delete process.env.ORKESTR_BROKER_BASE_URL;

  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const { port } = server.address();
  try {
    const tenantEnv = {
      ORKESTR_HOME: tenantHome,
      ORKESTR_DEMO_BROKER_BASE_URL: `http://127.0.0.1:${port}`,
      ORKESTR_DEMO_BROKER_REGISTRATION_TOKEN: "register-secret",
      ORKESTR_BROKER_INSTANCE_ID: "11111111-2222-4333-8444-555555555555",
      ORKESTR_SERVICE_NAME: "tenant-heartbeat-e2e",
      ORKESTR_VERSION: "tenant-v1",
      ORKESTR_TENANT_VM_ID: "tenant-heartbeat-e2e",
      ORKESTR_API_BASE: "http://10.43.10.12",
      ORKESTR_CONNECT_PUBLIC_BASE_URL: "https://connect.example.test",
      ORKESTR_CONNECT_PUBLIC_SETUP_URL: "https://connect.example.test/i/11111111-2222-4333-8444-555555555555/setup",
      ORKESTR_BROKER_WHATSAPP_RELAY_ACCOUNT_ID: "sender",
    };
    const staleResult = await sendBrokerClientHeartbeat({
      ...tenantEnv,
      ORKESTR_BROKER_INSTANCE_ID: "",
    });
    assert.equal(staleResult.ok, true);
    assert.notEqual(staleResult.registration.instanceId, tenantEnv.ORKESTR_BROKER_INSTANCE_ID);

    const result = await sendBrokerClientHeartbeat(tenantEnv);
    const listed = await listBrokerInstances({ ORKESTR_HOME: brokerHome });
    const instance = listed.instances.find((candidate) => candidate.instanceId === tenantEnv.ORKESTR_BROKER_INSTANCE_ID);

    assert.equal(result.ok, true);
    assert.equal(result.registration.instanceId, tenantEnv.ORKESTR_BROKER_INSTANCE_ID);
    assert.equal(result.registration.reused, false);
    assert.equal(listed.instances.length, 2);
    assert.ok(instance);
    assert.equal(instance.instanceId, "11111111-2222-4333-8444-555555555555");
    assert.equal(instance.status, "online");
    assert.equal(instance.displayName, "tenant-heartbeat-e2e");
    assert.equal(instance.version, "tenant-v1");
    assert.equal(instance.endpointBaseUrl, "http://10.43.10.12");
    assert.equal(instance.connectBaseUrl, "https://connect.example.test");
    assert.equal(instance.setupUrl, "https://connect.example.test/i/11111111-2222-4333-8444-555555555555/setup");
    assert.equal(instance.relayAccountId, "sender");
    assert.deepEqual(instance.capabilities, ["tenant-vm", "pairing-challenge", "whatsapp", "codex", "gmail", "desks"]);
    assert.ok(instance.lastHeartbeatAt);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    restoreEnv(prior);
  }
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

test("broker proxy payloads use the freshest registration for the route endpoint", async () => {
  const parentHome = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-broker-proxy-channel-parent-"));
  const tenantHome = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-broker-proxy-channel-tenant-"));
  const oldClient = __brokerInstanceRegistryTestInternals.createX25519Identity();
  const currentClient = __brokerInstanceRegistryTestInternals.createX25519Identity();
  const env = {
    ORKESTR_HOME: parentHome,
    ORKESTR_BROKER_REGISTRATION_TOKEN: "register-secret",
  };
  const endpointBaseUrl = "https://tenant.example.test";
  const oldRegistration = await registerBrokerInstance({
    env,
    request: request({ authorization: "Bearer register-secret" }),
    body: {
      encryptionPublicKey: oldClient.publicKey,
      endpointBaseUrl,
      displayName: "Fırat Jobs VM",
    },
  });
  const currentRegistration = await registerBrokerInstance({
    env,
    request: request({ authorization: "Bearer register-secret" }),
    body: {
      encryptionPublicKey: currentClient.publicKey,
      endpointBaseUrl,
      displayName: "firat-jobs-vm",
    },
  });
  await fs.mkdir(path.join(tenantHome, "secrets"), { recursive: true });
  await fs.writeFile(path.join(tenantHome, "secrets", "broker-client-identity.json"), JSON.stringify({
    privateKey: currentClient.privateKey,
    publicKey: currentClient.publicKey,
  }));
  await fs.writeFile(path.join(tenantHome, "secrets", "broker-client-registration.json"), JSON.stringify({
    instanceId: currentRegistration.instanceId,
    channelId: currentRegistration.channelId,
    brokerBaseUrl: "https://broker.example.test",
    brokerPublicKey: currentRegistration.broker.publicKey,
  }));

  const encrypted = await encryptBrokerInstanceProxyPayload(oldRegistration.instanceId, {
    kind: "broker_app_proxy",
    instanceId: oldRegistration.instanceId,
    path: "/api/whereiam?cwd=%2Fworkspace",
  }, env);
  const decrypted = await decryptBrokerClientPayload(encrypted.body, { ORKESTR_HOME: tenantHome });

  assert.equal(encrypted.record.instanceId, oldRegistration.instanceId);
  assert.equal(encrypted.encryptionRecord.instanceId, currentRegistration.instanceId);
  assert.equal(decrypted.registration.instanceId, currentRegistration.instanceId);
  assert.equal(decrypted.payload.instanceId, oldRegistration.instanceId);
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
