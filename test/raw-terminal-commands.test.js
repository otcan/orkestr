import assert from "node:assert/strict";
import test from "node:test";
import {
  rawControlCommandMayMatch,
  rawDesktopShareApproveChallenge,
  rawDesktopShareRequestSlug,
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
      "ssh root@orkestr.crawlerai.de",
      "orkestr security approve VxqcH2wTo7_DJhf01y-9KVDy",
      "sudo orkestr security approve VxqcH2wTo7_DJhf01y-9KVDy",
    ].join("\n")),
    "VxqcH2wTo7_DJhf01y-9KVDy",
  );
});

test("raw terminal parser recognizes desktop share approval and request commands", () => {
  assert.equal(
    rawDesktopShareApproveChallenge("orkestr desktop approve desk-abcDEF1234567890abcDEF"),
    "desk-abcDEF1234567890abcDEF",
  );
  assert.equal(
    rawDesktopShareApproveChallenge("approve desktop desk-abcDEF1234567890abcDEF"),
    "desk-abcDEF1234567890abcDEF",
  );
  assert.equal(
    rawDesktopShareApproveChallenge([
      "Orkestr Desktop Access",
      "Desktop challenge",
      "orkestr desktop approve desk-xyzXYZ1234567890xyzXYZ",
    ].join("\n")),
    "desk-xyzXYZ1234567890xyzXYZ",
  );
  assert.equal(rawDesktopShareRequestSlug("/desktop linkedin"), "linkedin");
  assert.equal(rawDesktopShareRequestSlug("/desktop"), "desktop");
  assert.equal(rawDesktopShareRequestSlug("/browser"), "desktop");
  assert.equal(rawDesktopShareRequestSlug("open desktop gmail"), "gmail");
  assert.equal(rawDesktopShareRequestSlug("share desktop desktop"), "desktop");
  assert.equal(rawDesktopShareRequestSlug("desktop"), "");
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
  assert.equal(rawControlCommandMayMatch("/desktop"), true);
});
