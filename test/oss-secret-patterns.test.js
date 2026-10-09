import assert from "node:assert/strict";
import test from "node:test";
import { allowMarker, isFakeDigits, scanText } from "../scripts/security/oss-secret-patterns.mjs";

// Assembled at runtime so this fixture never matches the scanner itself.
const join = (...parts) => parts.join("");
const randomish = "Q7vK2mZp9XwR4tLb8NcY3hJd6FsG1aEu";

test("secret scan flags high-signal credential shapes", () => {
  const cases = {
    "private key": join("-----BEGIN ", "OPENSSH PRIVATE KEY-----"),
    "GitHub token": join("gh", "p_", randomish, "Ab12"),
    "OpenAI key": join("sk-", "proj-", randomish),
    "AWS access key": join("AK", "IA", "Q7VK2MZP9XWR4TLB"),
    "bearer token": join("Authorization: ", "Bearer ", randomish),
    "numeric WhatsApp id": join("999", "73829", "4617", "@c.us"),
  };
  for (const [name, line] of Object.entries(cases)) {
    assert.deepEqual(scanText(`ok\n${line}\n`), [{ line: 2, name }], name);
  }
});

test("secret scan never echoes the matched value", () => {
  const value = join("sk-", randomish);
  assert.equal(JSON.stringify(scanText(value)).includes(value), false);
});

test("secret scan allows obvious fake fixture values", () => {
  const lines = [
    join("sk-", "test-voice-transcription-key"),
    join("Bearer ", "test-bearer-token-for-host-boundaries"),
    join("AK", "IA", "IOSFODNN7EXAMPLE"),
    join("15550001111", "@c.us"),
    join("120363000000000001", "@g.us"),
    join("sk-", randomish, ` // ${allowMarker}`),
  ];
  assert.deepEqual(scanText(lines.join("\n")), []);
});

test("fake digit heuristic distinguishes synthetic numbers", () => {
  assert.equal(isFakeDigits("15550001111"), true);
  assert.equal(isFakeDigits("4912345678901"), true);
  assert.equal(isFakeDigits("999738294617"), false);
});
