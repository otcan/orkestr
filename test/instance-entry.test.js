import assert from "node:assert/strict";
import test from "node:test";
import {
  maybeHandleInstanceEntry,
  normalizeInstanceAlias,
  renderInstanceEntry,
  resolveInstanceEntry,
} from "../dist/server/apps/server/src/instance-entry.js";
import { instanceSetupReturnPath } from "../dist/server/apps/server/src/instance-connect-setup.js";

const localRef = "ins_AQEBAQEBAQEBAQEBAQEBAQ";
const brokerRef = "ins_AgICAgICAgICAgICAgICAg";

function dependencies({ local = null, brokers = [], usable = true } = {}) {
  return {
    readLocalIdentity: async () => local,
    readRegistry: async () => ({ instances: brokers }),
    resolveBroker: async (instanceId) => usable
      ? { ok: true, instance: { instanceId } }
      : null,
  };
}

test("instance entry accepts configured local names and opaque IDs without a directory", async () => {
  const env = {
    ORKESTR_INSTANCE_NAME: "Main Orkestr",
    ORKESTR_INSTANCE_ALIASES: "primary, Personal",
  };
  const local = { internalInstanceId: "local-internal", publicRef: localRef };
  const deps = dependencies({ local });

  assert.deepEqual(await resolveInstanceEntry(" main   orkestr ", env, deps), {
    internalInstanceId: "local-internal",
    publicRef: localRef,
  });
  assert.deepEqual(await resolveInstanceEntry("PERSONAL", env, deps), {
    internalInstanceId: "local-internal",
    publicRef: localRef,
  });
  assert.deepEqual(await resolveInstanceEntry(localRef, env, deps), {
    internalInstanceId: "local-internal",
    publicRef: localRef,
  });

  const html = renderInstanceEntry();
  assert.match(html, /<h1>Which Orkestr\?<\/h1>/);
  assert.match(html, /name="instance"/);
  assert.doesNotMatch(html, /<select|<option|local-internal|Approve this browser/);
});

test("instance entry fails closed when a name is ambiguous or a broker is unusable", async () => {
  const local = { internalInstanceId: "local-internal", publicRef: localRef };
  const broker = {
    instanceId: "broker-internal",
    publicRef: brokerRef,
    displayName: "Main Orkestr",
  };
  const env = { ORKESTR_INSTANCE_NAME: "Main Orkestr" };

  assert.equal(await resolveInstanceEntry("Main Orkestr", env, dependencies({ local, brokers: [broker] })), null);
  assert.equal(await resolveInstanceEntry(brokerRef, env, dependencies({ brokers: [broker], usable: false })), null);
  assert.equal(await resolveInstanceEntry("missing", env, dependencies({ local, brokers: [broker] })), null);
});

test("instance entry alias normalization rejects path-like values", () => {
  assert.equal(normalizeInstanceAlias("  Team   Desk  "), "team desk");
  assert.equal(normalizeInstanceAlias("../team"), "");
  assert.equal(normalizeInstanceAlias("team?ref=one"), "");
});

test("instance pairing retains a canonical instance return path", () => {
  assert.equal(
    instanceSetupReturnPath("internal-id", `/instance/${localRef}/desktops?view=all`),
    `/instance/${localRef}/desktops?view=all`,
  );
  assert.equal(
    instanceSetupReturnPath("internal-id", "/instance/not-an-instance/desktops"),
    "/i/internal-id/app/",
  );
});

test("instance entry promotes a name into an instance-bound pairing redirect", async () => {
  const response = {
    statusCode: 0,
    headers: {},
    body: "",
    status(value) { this.statusCode = value; return this; },
    header(name, value) { this.headers[name] = value; return this; },
    type(value) { this.headers["content-type"] = value; return this; },
    send(value) { this.body = value; return this; },
  };
  const env = {
    ORKESTR_PUBLIC_APP_URL: "https://app.example.test",
    ORKESTR_PUBLIC_AUTH_URL: "https://connect.example.test",
    ORKESTR_INSTANCE_NAME: "Main",
  };
  const handled = await maybeHandleInstanceEntry({
    method: "POST",
    headers: { host: "app.example.test" },
    body: { instance: "Main" },
    ip: "192.0.2.10",
  }, response, "/instance-entry", {
    env,
    dependencies: dependencies({ local: { internalInstanceId: "local-internal", publicRef: localRef } }),
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 303);
  const location = new URL(response.headers.location);
  assert.equal(location.origin, "https://connect.example.test");
  assert.equal(location.pathname, "/setup/pairing");
  assert.equal(location.searchParams.get("instanceId"), "local-internal");
  assert.equal(location.searchParams.get("return"), `/instance/${localRef}`);
});

test("instance entry never promotes a configured primary host", async () => {
  const response = {
    statusCode: 0,
    headers: {},
    body: "",
    status(value) { this.statusCode = value; return this; },
    header(name, value) { this.headers[name] = value; return this; },
    type(value) { this.headers["content-type"] = value; return this; },
    send(value) { this.body = value; return this; },
  };
  const env = {
    ORKESTR_PUBLIC_APP_URL: "https://app.example.test",
    ORKESTR_PUBLIC_AUTH_URL: "https://connect.example.test",
    ORKESTR_INSTANCE_NAME: "Main",
    ORKESTR_PRIMARY_INSTANCE_URL: "https://main.ops.example.test/",
  };
  const local = { internalInstanceId: "local-internal", publicRef: localRef };
  const handled = await maybeHandleInstanceEntry({
    method: "POST",
    headers: { host: "app.example.test" },
    body: { instance: "Main" },
    ip: "192.0.2.11",
  }, response, "/instance-entry", {
    env,
    dependencies: dependencies({ local }),
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 303);
  const location = new URL(response.headers.location);
  assert.equal(location.origin, "https://connect.example.test");
  assert.equal(location.searchParams.get("instanceId"), "local-internal");
  assert.doesNotMatch(renderInstanceEntry(), /Open Main Orkestr|main\.ops\.example\.test/);
});
