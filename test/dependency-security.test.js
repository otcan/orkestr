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
  // GHSA-62vg-58rm-qff7: the router (and the framework peers it pins) at 21.2.25.
  for (const name of ["common", "compiler", "compiler-cli", "core", "forms", "platform-browser", "router"]) {
    assert.equal(versionAt(`node_modules/@angular/${name}`), "21.2.25", name);
  }
  assert.equal(versionAt("node_modules/@angular/build"), "21.2.24");
  assert.equal(versionAt("node_modules/@nestjs/platform-express"), "11.2.3");
  assert.equal(versionAt("node_modules/multer"), "2.4.0");
  assert.equal(versionAt("node_modules/qs"), "6.16.0");
  for (const [packagePath, entry] of Object.entries(lock.packages)) {
    if (packagePath.endsWith("/node_modules/multer")) assert.equal(entry.version, "2.4.0", packagePath);
    if (packagePath.endsWith("/node_modules/qs")) assert.equal(entry.version, "6.16.0", packagePath);
  }
  // GHSA-22jm-h49p-29qw / GHSA-46jr-4wx8-v453: 1.32.0, including the copy @angular/cli would nest
  // (it pins 1.30.0; package.json overrides it).
  assert.equal(versionAt("node_modules/@modelcontextprotocol/sdk"), "1.32.0");
  for (const [packagePath, entry] of Object.entries(lock.packages)) {
    if (packagePath.endsWith("/node_modules/@modelcontextprotocol/sdk")) assert.equal(entry.version, "1.32.0", packagePath);
  }
  // GHSA-587h-7wmj-h5pm: the patched launch-editor dependency is in Vite 7.3.7.
  assert.equal(versionAt("node_modules/vite"), "7.3.7");
  // GHSA-wq5f-xc86-pv6w (bundled librsvg): sharp 0.35.5 or later.
  const [sharpMajor, sharpMinor, sharpPatch] = versionAt("node_modules/sharp").split(".").map(Number);
  assert.ok(sharpMajor > 0 || sharpMinor > 35 || (sharpMinor === 35 && sharpPatch >= 5), `sharp ${versionAt("node_modules/sharp")}`);
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
