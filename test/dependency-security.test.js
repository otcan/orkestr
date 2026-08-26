import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const lock = JSON.parse(fs.readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));

function versionAt(path) {
  return String(lock.packages?.[path]?.version || "");
}

function major(version) {
  return Number(String(version || "0").split(".")[0]);
}

test("framework and upload dependencies stay above the reviewed security floors", () => {
  assert.equal(versionAt("node_modules/@angular/core"), "21.2.21");
  assert.equal(versionAt("node_modules/@angular/build"), "21.2.21");
  assert.equal(versionAt("node_modules/@nestjs/platform-express"), "11.2.3");
  assert.equal(versionAt("node_modules/multer"), "2.2.0");
  assert.equal(versionAt("node_modules/@modelcontextprotocol/sdk"), "1.30.0");
  assert.ok(versionAt("node_modules/tar") > "7.5.20");
});

test("whatsapp-web.js resolves through the reviewed patched Puppeteer override", () => {
  assert.equal(versionAt("node_modules/whatsapp-web.js"), "1.34.7");
  assert.ok(major(versionAt("node_modules/puppeteer")) >= 25);
  assert.ok(major(versionAt("node_modules/puppeteer-core")) >= 25);
  assert.ok(major(versionAt("node_modules/@puppeteer/browsers")) >= 3);
  assert.equal(versionAt("node_modules/whatsapp-web.js/node_modules/puppeteer"), "");
  assert.equal(versionAt("node_modules/whatsapp-web.js/node_modules/@puppeteer/browsers"), "");
  assert.equal(versionAt("node_modules/extract-zip"), "");
});
