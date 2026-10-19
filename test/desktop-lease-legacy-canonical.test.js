import test from "node:test";
import assert from "node:assert/strict";
import { canonicalLegacyBytes, parseLegacyJson } from "../packages/browsers/src/desktop-lease-canonical.js";

test("language-independent canonical vectors bind Unicode, numeric bits and object order", () => {
  const vectors = [
    [null, "n"], [true, "t"], [false, "f"], [0, "d0000000000000000"],
    [1, "d3ff0000000000000"], [0.125, "d3fc0000000000000"], [-2.5, "dc004000000000000"],
    ["ä", "s2:ä"], ["😀", "s4:😀"], [[null, true], "a2:[nt]"],
    [{ z: false, a: 1 }, "o2:{s1:ad3ff0000000000000s1:zf}"],
    [{ "😀": null, "\uE000": true }, "o2:{s3:\uE000ts4:😀n}"],
  ];
  for (const [value, expected] of vectors) assert.deepEqual(canonicalLegacyBytes(value), Buffer.from(expected));
  assert.deepEqual(canonicalLegacyBytes({ a: 1, z: false }), canonicalLegacyBytes({ z: false, a: 1 }));
  assert.deepEqual(canonicalLegacyBytes(parseLegacyJson('{"x":1.0}')), canonicalLegacyBytes({ x: 1 }));
});

test("ambiguous JSON, unsafe numbers, invalid Unicode, depth and cycles refuse", () => {
  for (const raw of ['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"x":{"a":1,"a":1}}',
    '{"x":1e400}', '{"x":9007199254740992}', '{"x":-0}', '{"x":-0.0}',
    '{"x":"\\ud800"}', '{"\\udc00":1}', '[1,]', '{"x":1,}', '01', 'true false',
    '['.repeat(66) + '0' + ']'.repeat(66)]) assert.throws(() => parseLegacyJson(raw), /legacy_encoding_invalid/);
  assert.throws(() => parseLegacyJson(Buffer.from([0xff])), /legacy_encoding_invalid/);
  const cycle = {}; cycle.loop = cycle;
  for (const value of [cycle, NaN, Infinity, -0, undefined, 1n, new Date(), [, 1],
    { get secret() { assert.fail("getter executed"); } }, { [Symbol("secret")]: 1 }]) {
    assert.throws(() => canonicalLegacyBytes(value), /legacy_encoding_invalid/);
  }
  assert.throws(() => canonicalLegacyBytes(Array(100_001).fill(null)), /legacy_encoding_invalid/);
  assert.throws(() => canonicalLegacyBytes("x".repeat(8 * 1024 * 1024)), /legacy_encoding_invalid/);
});

test("escaped duplicate checks do not confuse JSON strings or prototype keys", () => {
  const raw = '{"__proto__":{"x":1},"text":"\\\" a\\\\b \\n","array":[{},[],1e-100]}';
  const parsed = parseLegacyJson(raw);
  assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
  assert.equal(Object.hasOwn(parsed, "__proto__"), true);
  assert.equal(parsed.__proto__.x, 1);
  assert.deepEqual(parsed, JSON.parse(raw));
});

test("UTF-8 BOM input refuses without silently stripping original bytes", () => {
  const raw = Buffer.from('{"fencingCounter":0,"desktopLeases":[]}');
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), raw]);
  const surrounded = Buffer.concat([Buffer.from("prefix"), bom, Buffer.from("suffix")]);
  const slice = surrounded.subarray(6, 6 + bom.length), original = Buffer.from(surrounded);
  for (const input of [bom, slice, new Uint8Array(slice.buffer, slice.byteOffset, slice.byteLength),
    new DataView(slice.buffer, slice.byteOffset, slice.byteLength),
    slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength), `\uFEFF${raw}`]) {
    assert.throws(() => parseLegacyJson(input), /legacy_encoding_invalid/);
  }
  assert.deepEqual(surrounded, original);
  assert.deepEqual(parseLegacyJson(raw), JSON.parse(raw));
  assert.deepEqual(parseLegacyJson(Buffer.from('{"text":"\uFEFF"}')), { text: "\uFEFF" });
});
