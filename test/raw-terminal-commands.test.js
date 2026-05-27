import assert from "node:assert/strict";
import test from "node:test";
import {
  rawControlCommandMayMatch,
  rawSecurityApproveChallengeId,
} from "../packages/core/src/raw-terminal-commands.js";

test("raw terminal parser recognizes pairing approval commands", () => {
  assert.equal(
    rawSecurityApproveChallengeId("approve challenge: rokSko-uJ6Q02OhBlInyhahJ"),
    "rokSko-uJ6Q02OhBlInyhahJ",
  );
  assert.equal(
    rawSecurityApproveChallengeId("orkestr security approve rokSko-uJ6Q02OhBlInyhahJ"),
    "rokSko-uJ6Q02OhBlInyhahJ",
  );
  assert.equal(
    rawSecurityApproveChallengeId("/approve challenge rokSko-uJ6Q02OhBlInyhahJ"),
    "rokSko-uJ6Q02OhBlInyhahJ",
  );
});

test("raw terminal parser keeps non-control text out of the approval path", () => {
  assert.equal(rawSecurityApproveChallengeId("approve this plan"), "");
  assert.equal(rawSecurityApproveChallengeId("hi"), "");
  assert.equal(rawControlCommandMayMatch("a"), true);
  assert.equal(rawControlCommandMayMatch("as"), false);
  assert.equal(rawControlCommandMayMatch("orkestr security approve"), true);
});
