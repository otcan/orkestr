import assert from "node:assert/strict";
import test from "node:test";
import {
  appendSanitizedForwardedHeaders,
  rawUpgradeHeaderAllowed,
} from "../dist/server/apps/server/src/upgrade-forwarded-headers.js";

test("upgrade serializers reject raw forwarded headers and append only sanitized values", () => {
  assert.equal(rawUpgradeHeaderAllowed("X-Forwarded-Host"), false);
  assert.equal(rawUpgradeHeaderAllowed("x-forwarded-proto"), false);
  assert.equal(rawUpgradeHeaderAllowed("upgrade"), true);

  const lines = [];
  appendSanitizedForwardedHeaders(lines, {
    headers: {
      "x-forwarded-host": "app.example.test:8443",
      "x-forwarded-proto": "https",
    },
  });
  assert.deepEqual(lines, [
    "X-Forwarded-Host: app.example.test:8443",
    "X-Forwarded-Proto: https",
  ]);

  const stripped = [];
  appendSanitizedForwardedHeaders(stripped, { headers: {} });
  assert.deepEqual(stripped, []);
});
