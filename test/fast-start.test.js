import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { installedChromePath, whatsappChromeMissingHint, whatsappChromePath } from "../packages/connectors/src/whatsapp-chrome-path.js";

test("WhatsApp uses an explicit Chrome path, else an installed Chrome, else puppeteer's own", () => {
  const none = () => false;
  const only = (wanted) => (candidate) => candidate === wanted;
  assert.equal(whatsappChromePath({ WA_CHROME_PATH: "/opt/chrome" }, "linux", none), "/opt/chrome");
  assert.equal(whatsappChromePath({ PUPPETEER_EXECUTABLE_PATH: "/x/chrome" }, "darwin", none), "/x/chrome");
  const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  assert.equal(whatsappChromePath({}, "darwin", only(mac)), mac);
  assert.equal(installedChromePath("linux", only("/usr/bin/chromium")), "/usr/bin/chromium");
  assert.equal(whatsappChromePath({}, "linux", none), "", "nothing found: puppeteer decides");
  assert.match(whatsappChromeMissingHint, /Install Chrome, or set WA_CHROME_PATH/);
});

test("the bridge maps a missing Chrome to a clear dependency_missing hint", async () => {
  const bridge = await fs.readFile("packages/connectors/src/whatsapp-local-bridge.js", "utf8");
  assert.match(bridge, /const executablePath = whatsappChromePath\(env\);/);
  assert.match(bridge, /state: chromeMissing \? "dependency_missing"/);
  assert.match(bridge, /error: chromeMissing \? whatsappChromeMissingHint : message/);
});

test("npm start builds the server once on a fresh clone and npm ci skips puppeteer's Chrome", async () => {
  const pkg = JSON.parse(await fs.readFile("package.json", "utf8"));
  assert.equal(pkg.scripts.prestart, "node scripts/ensure-server-build.mjs");
  assert.equal(pkg.scripts.start, "node dist/server/apps/server/src/server.js");
  const rc = await fs.readFile(".puppeteerrc.cjs", "utf8");
  assert.match(rc, /skipDownload: process\.env\.ORKESTR_DOWNLOAD_CHROME !== "1"/);
});

test("README copy-paste shell blocks have no # comment lines (zsh treats them as commands)", async () => {
  const readme = await fs.readFile("README.md", "utf8");
  const start = readme.slice(readme.indexOf("### Start Orkestr"), readme.indexOf("### What works today"));
  assert.match(start, /npm ci\nnpm start\n/);
  for (const block of start.matchAll(/```bash\n([\s\S]*?)```/g)) {
    for (const line of block[1].split("\n")) assert.doesNotMatch(line, /(^|\s)#/, line);
  }
});
