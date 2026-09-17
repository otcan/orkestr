import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import * as age from "age-encryption";

// Execute the actual web API method with the standard Fetch/Blob interfaces,
// avoiding Angular injection setup or a second upload implementation.
async function uploadHarness() {
  const source = await fs.readFile(new URL("../apps/web/src/app/api.service.ts", import.meta.url), "utf8");
  const file = ts.createSourceFile("api.service.ts", source, ts.ScriptTarget.Latest, true);
  const declaration = file.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "ApiService");
  const method = declaration.members.find(node => node.name?.getText(file) === "uploadInboundAttachmentCiphertext");
  const compiled = ts.transpileModule(`export class UploadHarness { api(path: string) { return '/api' + path; } ${method.getText(file)} }`,
    {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022}}).outputText;
  const {UploadHarness} = await import("data:text/javascript;base64," + Buffer.from(compiled).toString("base64"));
  return new UploadHarness();
}

test("web upload method sends only encrypted bytes using a mobile-compatible Blob", async () => {
  const harness = await uploadHarness();
  const identity = await age.generateIdentity();
  const encrypter = new age.Encrypter();
  encrypter.addRecipient(await age.identityToRecipient(identity));
  const plaintext = "browser-only-secret-".repeat(12000);
  const stream = await encrypter.encrypt(new Blob([plaintext]).stream());
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async (url, options) => {
    requests++;
    assert.equal(url, "/api/attachment-encryption/inbound/sessions/example-session/ciphertext");
    assert.equal(options.method, "PUT");
    assert.equal(options.headers["content-type"], "application/age");
    assert.equal(options.credentials, "same-origin");
    assert.ok(options.body instanceof Blob);
    assert.equal(options.duplex, undefined);
    const wire = new Uint8Array(await options.body.arrayBuffer());
    assert.equal(Buffer.from(wire).includes(Buffer.from("browser-only-secret")), false);
    const decrypter = new age.Decrypter();
    decrypter.addIdentity(identity);
    const decrypted = await decrypter.decrypt(new Blob([wire]).stream());
    assert.equal(await new Response(decrypted).text(), plaintext);
    return Response.json({session: {id: "example-session", state: "quarantined"}}, {status: 201});
  };
  try {
    assert.equal((await harness.uploadInboundAttachmentCiphertext("example-session", stream)).state, "quarantined");
    assert.equal(requests, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test("browser encryption failure sends no request and cannot fall back to plaintext", async () => {
  const harness = await uploadHarness();
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw Error("must not send"); };
  try {
    const broken = new ReadableStream({start(controller) {controller.error(Error("encryption-failed"));}});
    await assert.rejects(harness.uploadInboundAttachmentCiphertext("example-session", broken), /encryption-failed/);
    assert.equal(requests, 0);
  } finally { globalThis.fetch = originalFetch; }
});
