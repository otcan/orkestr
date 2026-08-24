import assert from "node:assert/strict";
import test from "node:test";
import { canonicalTimestamp, timestampMs } from "../packages/core/src/timestamp-normalization.js";

test("timestamp normalization accepts ISO, epoch seconds, and epoch milliseconds", () => {
  const epochSeconds = 1786352641;
  const expected = "2026-08-10T09:04:01.000Z";

  assert.equal(canonicalTimestamp(epochSeconds), expected);
  assert.equal(canonicalTimestamp(String(epochSeconds)), expected);
  assert.equal(canonicalTimestamp(epochSeconds * 1000), expected);
  assert.equal(timestampMs(expected), epochSeconds * 1000);
  assert.equal(canonicalTimestamp("not-a-timestamp"), "");
});
