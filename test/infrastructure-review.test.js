import assert from "node:assert/strict";
import test from "node:test";
import { reviewInfrastructure } from "../scripts/security/review-infrastructure.mjs";

test("infrastructure dispatcher is offline, explicit and has no apply mode", () => {
  assert.throws(() => reviewInfrastructure("apply", {}), /unknown_infrastructure/);
  assert.equal(reviewInfrastructure("kubernetes", { objects: [] }).ok, false);
  assert.equal(reviewInfrastructure("transport", { policy: { hostname: "app.example.com", hstsMaxAge: 60 }, protocol: "http",
    response: { status: 308, location: "https://app.example.com/" } }).ok, true);
  assert.throws(() => reviewInfrastructure("canonical-routing", {}), /canonical_bindings/);
});
