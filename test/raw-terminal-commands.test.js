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
  assert.equal(
    rawSecurityApproveChallengeId("sudo orkestr security approve rokSko-uJ6Q02OhBlInyhahJ"),
    "rokSko-uJ6Q02OhBlInyhahJ",
  );
  assert.equal(
    rawSecurityApproveChallengeId([
      "Orkestr security",
      "",
      "Pairing Required",
      "Challenge ID",
      "VxqcH2wTo7_DJhf01y-9KVDy",
      "pending",
      "Approve From SSH",
      "ssh root@orkestr.example.test",
      "orkestr security approve VxqcH2wTo7_DJhf01y-9KVDy",
      "sudo orkestr security approve VxqcH2wTo7_DJhf01y-9KVDy",
    ].join("\n")),
    "VxqcH2wTo7_DJhf01y-9KVDy",
  );
});

test("raw terminal parser keeps non-control text out of the approval path", () => {
  assert.equal(rawSecurityApproveChallengeId("approve this plan"), "");
  assert.equal(rawSecurityApproveChallengeId("hi"), "");
  assert.equal(
    rawSecurityApproveChallengeId("Do not run this:\norkestr security approve rokSko-uJ6Q02OhBlInyhahJ"),
    "",
  );
  assert.equal(rawControlCommandMayMatch("a"), true);
  assert.equal(rawControlCommandMayMatch("as"), false);
  assert.equal(rawControlCommandMayMatch("orkestr security approve"), true);
  assert.equal(rawControlCommandMayMatch("/desktop"), false);
  assert.equal(rawControlCommandMayMatch("orkestr desktop approve"), false);
});
