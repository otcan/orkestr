import assert from "node:assert/strict";
import test from "node:test";
import { buildOtpauthUri, parseOtpauthMigrationUri, parseOtpauthUri } from "../packages/core/src/vault-otpauth.js";
import { base32Decode, base32Encode, currentCode, hotp, totp } from "../packages/core/src/vault-totp.js";

// RFC test vectors and synthetic otpauth / Google Authenticator payloads only.

const sha1Seed = Buffer.from("12345678901234567890", "ascii");
const sha256Seed = Buffer.from("12345678901234567890123456789012", "ascii");
const sha512Seed = Buffer.from("1234567890123456789012345678901234567890123456789012345678901234", "ascii");

test("RFC 4226 Appendix D HOTP vectors", () => {
  const expected = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
  expected.forEach((code, counter) => assert.equal(hotp(sha1Seed, counter), code));
});

test("RFC 6238 Appendix B TOTP vectors for SHA1, SHA256 and SHA512", () => {
  const vectors = [
    [59, "94287082", "46119246", "90693936"],
    [1111111109, "07081804", "68084774", "25091201"],
    [1111111111, "14050471", "67062674", "99943326"],
    [1234567890, "89005924", "91819424", "93441116"],
    [2000000000, "69279037", "90698825", "38618901"],
    [20000000000, "65353130", "77737706", "47863826"],
  ];
  for (const [seconds, sha1, sha256, sha512] of vectors) {
    const nowMs = seconds * 1000;
    assert.equal(totp(sha1Seed, { nowMs, digits: 8, algorithm: "SHA1" }), sha1, `SHA1 @${seconds}`);
    assert.equal(totp(sha256Seed, { nowMs, digits: 8, algorithm: "SHA256" }), sha256, `SHA256 @${seconds}`);
    assert.equal(totp(sha512Seed, { nowMs, digits: 8, algorithm: "SHA512" }), sha512, `SHA512 @${seconds}`);
  }
});

test("base32 decode is case-insensitive, ignores spaces/padding and rejects junk", () => {
  assert.equal(base32Encode(sha1Seed), "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  assert.deepEqual(base32Decode("gezd gnbv gy3t qojq gezd gnbv gy3t qojq"), sha1Seed);
  assert.deepEqual(base32Decode("MZXW6==="), Buffer.from("foo"));
  assert.deepEqual(base32Decode("MZXW6YQ"), Buffer.from("foob"));
  assert.deepEqual(base32Decode("mzxw6ytboi======"), Buffer.from("foobar"));
  for (const bad of ["", "1!", "MZXW1", "===="]) {
    assert.throws(() => base32Decode(bad), (error) => error.message === "vault_totp_secret_invalid" && !error.message.includes(bad || "x"));
  }
});

test("currentCode reports expiry for TOTP and the next counter for HOTP", () => {
  const secret = base32Encode(sha1Seed);
  const code = currentCode({ secret, digits: 8 }, 59_000);
  assert.deepEqual(code, { code: "94287082", digits: 8, period: 30, expiresInSeconds: 1 });
  const counter = currentCode({ secret, type: "hotp", counter: 1 });
  assert.equal(counter.code, "287082");
  assert.equal(counter.nextCounter, 2);
});

test("otpauth URIs parse label/issuer/params and round-trip", () => {
  const parsed = parseOtpauthUri("otpauth://totp/Example%20Co:alice@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Example%20Co&algorithm=SHA256&digits=8&period=60");
  assert.deepEqual(parsed, {
    secret: "JBSWY3DPEHPK3PXP", algorithm: "SHA256", digits: 8, period: 60, type: "totp", counter: 0, issuer: "Example Co", accountName: "alice@example.com",
  });
  const labelOnly = parseOtpauthUri("otpauth://totp/ExampleIssuer:bob?secret=jbswy3dpehpk3pxp");
  assert.equal(labelOnly.issuer, "ExampleIssuer");
  assert.equal(labelOnly.algorithm, "SHA1");
  const hotpConfig = parseOtpauthUri("otpauth://hotp/Example:carol?secret=JBSWY3DPEHPK3PXP&counter=7");
  assert.equal(hotpConfig.type, "hotp");
  assert.equal(hotpConfig.counter, 7);
  assert.deepEqual(parseOtpauthUri(buildOtpauthUri(parsed)), parsed);
  assert.deepEqual(parseOtpauthUri(buildOtpauthUri(hotpConfig)), hotpConfig);
  for (const [bad, code] of [
    ["https://example.com/?secret=JBSWY3DPEHPK3PXP", "vault_otpauth_invalid"],
    ["otpauth://steam/Example?secret=JBSWY3DPEHPK3PXP", "vault_totp_type_unsupported"],
    ["otpauth://totp/Example?secret=JBSWY3DPEHPK3PXP&algorithm=MD5", "vault_totp_algorithm_unsupported"],
    ["otpauth://totp/Example?secret=JBSWY3DPEHPK3PXP&digits=7", "vault_totp_digits_unsupported"],
    ["otpauth://hotp/Example?secret=JBSWY3DPEHPK3PXP", "vault_totp_counter_invalid"],
    ["otpauth://totp/Example?secret=!!", "vault_totp_secret_invalid"],
  ]) {
    assert.throws(() => parseOtpauthUri(bad), (error) => error.message === code);
  }
});

// Tiny protobuf encoder for synthetic Google Authenticator export payloads.
function varint(value) {
  let number = BigInt(value);
  const bytes = [];
  do {
    let byte = Number(number & 0x7fn);
    number >>= 7n;
    if (number) byte |= 0x80;
    bytes.push(byte);
  } while (number);
  return Buffer.from(bytes);
}
const fieldVarint = (field, value) => Buffer.concat([varint((field << 3) | 0), varint(value)]);
const fieldBytes = (field, value) => {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
  return Buffer.concat([varint((field << 3) | 2), varint(bytes.length), bytes]);
};
function otpParameters({ secret, name, issuer, algorithm = 1, digits = 1, type = 2, counter }) {
  const parts = [fieldBytes(1, secret), fieldBytes(2, name)];
  if (issuer !== undefined) parts.push(fieldBytes(3, issuer));
  parts.push(fieldVarint(4, algorithm), fieldVarint(5, digits), fieldVarint(6, type));
  if (counter !== undefined) parts.push(fieldVarint(7, counter));
  return Buffer.concat(parts);
}
function migrationUri(accounts, extra = []) {
  const payload = Buffer.concat([...accounts.map((account) => fieldBytes(1, otpParameters(account))), fieldVarint(2, 1), fieldVarint(3, 1), fieldVarint(4, 0), fieldVarint(5, 12345), ...extra]);
  return `otpauth-migration://offline?data=${encodeURIComponent(payload.toString("base64"))}`;
}

test("otpauth-migration payloads decode every account and reject bad ones safely", () => {
  const uri = migrationUri([
    { secret: sha1Seed, name: "Example:alice@example.com", issuer: "Example" },
    { secret: sha256Seed, name: "bob@example.org", issuer: "Example Org", algorithm: 2, digits: 2 },
    { secret: sha1Seed, name: "Counter:carol", type: 1, counter: 5 },
    { secret: sha1Seed, name: "Legacy:dave", algorithm: 0, digits: 0, type: 0 },
    { secret: sha1Seed, name: "Weak:erin", algorithm: 4 },
  ]);
  const parsed = parseOtpauthMigrationUri(uri);
  assert.equal(parsed.accounts.length, 5);
  const [alice, bob, carol, dave, erin] = parsed.accounts;
  assert.deepEqual(alice.config, { secret: base32Encode(sha1Seed), algorithm: "SHA1", digits: 6, period: 30, type: "totp", counter: 0, issuer: "Example", accountName: "alice@example.com" });
  assert.equal(bob.config.algorithm, "SHA256");
  assert.equal(bob.config.digits, 8);
  assert.equal(carol.config.type, "hotp");
  assert.equal(carol.config.counter, 5);
  assert.equal(carol.config.issuer, "Counter");
  assert.equal(dave.config.algorithm, "SHA1");
  assert.equal(dave.config.type, "totp");
  assert.deepEqual(erin, { ok: false, reason: "vault_totp_algorithm_unsupported" });
});

test("otpauth-migration rejects malformed, truncated and oversized input", () => {
  const good = Buffer.concat([fieldBytes(1, otpParameters({ secret: sha1Seed, name: "x" }))]);
  const truncated = good.subarray(0, good.length - 3);
  const overlong = Buffer.concat([varint((1 << 3) | 2), varint(10_000), Buffer.from("abc")]);
  const badWire = Buffer.from([0x0f, 0x01]);
  for (const buffer of [truncated, overlong, badWire, Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01])]) {
    assert.throws(() => parseOtpauthMigrationUri(`otpauth-migration://offline?data=${encodeURIComponent(buffer.toString("base64"))}`), /vault_migration_(malformed|invalid)/);
  }
  assert.throws(() => parseOtpauthMigrationUri("otpauth-migration://offline?data="), /vault_migration_invalid/);
  assert.throws(() => parseOtpauthMigrationUri("otpauth-migration://offline?data=%%%"), /vault_migration_invalid|vault_otpauth_invalid/);
  assert.throws(() => parseOtpauthMigrationUri("otpauth://totp/x?secret=AAAA"), /vault_migration_invalid/);
  const huge = Buffer.alloc(70 * 1024, 0);
  assert.throws(() => parseOtpauthMigrationUri(`otpauth-migration://offline?data=${huge.toString("base64")}`), /vault_migration_invalid/);
});
