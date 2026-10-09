import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { decryptVaultShare } from "../packages/core/src/vault-share-crypto.js";

// The Vault page encrypts shares in the browser; its output must open with
// the same derivation as the CLI and the public recipient page.

const appDir = new URL("../apps/web/src/app/", import.meta.url);

async function loadBrowserCrypto(t) {
  const source = await fs.readFile(new URL("vault-outside-crypto.ts", appDir), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vault-outside-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "vault-outside-crypto.mjs");
  await fs.writeFile(file, outputText);
  return import(file);
}

test("browser share encryption opens with the shared derivation, with and without passphrase", async (t) => {
  const { encryptVaultShare } = await loadBrowserCrypto(t);
  const plain = await encryptVaultShare("synthetic-browser-share");
  assert.equal(plain.envelope.kdf, undefined);
  assert.equal(decryptVaultShare(plain.envelope, plain.key), "synthetic-browser-share");
  const locked = await encryptVaultShare("synthetic-browser-locked", "example passphrase");
  assert.equal(locked.envelope.kdf.iterations, 600_000);
  assert.throws(() => decryptVaultShare(locked.envelope, locked.key, "wrong passphrase"));
  assert.equal(decryptVaultShare(locked.envelope, locked.key, "example passphrase"), "synthetic-browser-locked");
  assert.equal(JSON.stringify(locked.envelope).includes(locked.key), false);
});

test("vault page wires Share…, Request from someone… and the shared-links panel", async () => {
  const html = await fs.readFile(new URL("vault-page.component.html", appDir), "utf8");
  assert.match(html, /openOutside\(item\)">Share…/);
  assert.match(html, /openOutside\(null\)">Request from someone…/);
  assert.match(html, /<ork-vault-outside-panel>/);
  const dialog = await fs.readFile(new URL("vault-outside-dialog.component.ts", appDir), "utf8");
  // The key only ever goes into the displayed link, never into a request body.
  assert.match(dialog, /this\.url = `\$\{result\.url\}#\$\{key\}`/);
  assert.doesNotMatch(dialog, /share\(\{[^}]*key[,}]/);
});
