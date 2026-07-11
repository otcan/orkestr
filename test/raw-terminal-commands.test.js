import assert from "node:assert/strict";
import test from "node:test";
import {
  exactSecurityApproveChallengeId,
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
    rawSecurityApproveChallengeId("orkestr connect approve A1B2C3"),
    "A1B2C3",
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
      "Approve this browser",
      "orkestr connect approve V7Q9KD",
      "pending",
    ].join("\n")),
    "V7Q9KD",
  );
  assert.equal(
    rawSecurityApproveChallengeId([
      "Approve this shared review",
      "Create approval command",
      "orkestr connect approve V7Q9KD",
      "pending",
    ].join("\n")),
    "V7Q9KD",
  );
});

test("raw terminal parser keeps non-control text out of the approval path", () => {
  assert.equal(rawSecurityApproveChallengeId("approve this plan"), "");
  assert.equal(rawSecurityApproveChallengeId("hi"), "");
  assert.equal(
    rawSecurityApproveChallengeId("Do not run this:\norkestr security approve rokSko-uJ6Q02OhBlInyhahJ"),
    "",
  );
  assert.equal(
    rawSecurityApproveChallengeId([
      "Fresh approval command:",
      "",
      "```bash",
      "orkestr connect approve FAKE1234",
      "```",
      "",
      "Why did the assistant send this? It should come from the session.",
    ].join("\n")),
    "",
  );
  assert.equal(rawControlCommandMayMatch("a"), true);
  assert.equal(rawControlCommandMayMatch("as"), false);
  assert.equal(rawControlCommandMayMatch("orkestr security approve"), true);
  assert.equal(rawControlCommandMayMatch("orkestr connect approve"), true);
  assert.equal(rawControlCommandMayMatch("/desktop"), false);
  assert.equal(rawControlCommandMayMatch("orkestr desktop approve"), false);
});

test("exact approval parser only accepts a standalone command", () => {
  assert.equal(
    exactSecurityApproveChallengeId("orkestr connect approve A1B2C3"),
    "A1B2C3",
  );
  assert.equal(
    exactSecurityApproveChallengeId([
      "Orkestr security",
      "",
      "Approve this browser",
      "orkestr connect approve V7Q9KD",
      "pending",
    ].join("\n")),
    "",
  );
  assert.equal(
    exactSecurityApproveChallengeId("Do not run this:\norkestr security approve rokSko-uJ6Q02OhBlInyhahJ"),
    "",
  );
});
