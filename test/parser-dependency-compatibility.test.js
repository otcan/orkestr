import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import multer from "multer";
import qs from "qs";

async function parseMultipart(form, limits = {}) {
  const encoded = new Request("http://fixture.invalid/upload", { method: "POST", body: form });
  const bytes = Buffer.from(await encoded.arrayBuffer());
  const request = Readable.from([bytes]);
  request.headers = {
    "content-type": encoded.headers.get("content-type"),
    "content-length": String(bytes.length),
  };
  await new Promise((resolve, reject) => {
    multer({ storage: multer.memoryStorage(), limits }).any()(request, {}, error => error ? reject(error) : resolve());
  });
  return request;
}

test("patched multipart parser accepts exact-limit memory uploads and browser-escaped filenames", async () => {
  const form = new FormData();
  form.append("path", "documents");
  form.append("files", new Blob(["abcd"], { type: "text/plain" }), 'report "draft" 50%.txt');
  const request = await parseMultipart(form, { fileSize: 4, files: 1 });
  assert.equal(request.body.path, "documents");
  assert.equal(request.files.length, 1);
  assert.equal(request.files[0].originalname, 'report "draft" 50%.txt');
  assert.equal(request.files[0].buffer.toString(), "abcd");
  assert.equal(request.files[0].size, 4);
  const oversized = new FormData();
  oversized.append("files", new Blob(["abcde"]), "large.txt");
  await assert.rejects(parseMultipart(oversized, { fileSize: 4 }), { code: "LIMIT_FILE_SIZE" });
});

test("patched multipart array-index defense requires and honors an explicit limit", async () => {
  // Bounded values exercise the advisory without ever allocating a large array.
  const accepted = new FormData();
  accepted.append("items[2]", "value");
  const request = await parseMultipart(accepted, { fieldArrayIndexLimit: 2 });
  assert.equal(request.body.items[2], "value");
  const rejected = new FormData();
  rejected.append("items[3]", "value");
  await assert.rejects(parseMultipart(rejected, { fieldArrayIndexLimit: 2 }), { code: "LIMIT_FIELD_ARRAY_INDEX" });
});

test("patched qs preserves plain form data and enforces the opted-in comma array bound", () => {
  assert.deepEqual(qs.parse("path=docs&name=report%20one&enabled=true", { depth: 0 }), {
    path: "docs", name: "report one", enabled: "true",
  });
  assert.throws(() => qs.parse("items[]=a,b,c", {
    comma: true, arrayLimit: 2, throwOnLimitExceeded: true,
  }), RangeError);
  assert.doesNotThrow(() => qs.stringify({ value: { constructor: { isBuffer: "not-callable" } } }));
});
