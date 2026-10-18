import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

const file = "apps/web/src/app/thread-system-usage.component.ts";
const source = await fs.readFile(file, "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true,
} }).outputText;
const exports = {};
vm.runInNewContext(`(function(exports, require) { ${compiled} })`, { Date })(exports, () => ({
  Component: () => () => {}, Input: () => () => {},
}));
const { ThreadSystemUsageComponent } = exports;

test("thread readings preserve real zeroes and show server RAM in GiB", () => {
  const component = new ThreadSystemUsageComponent();
  component.summary = { generatedAt: new Date().toISOString(), cpu: { percent: 0 }, cpuPercent: 99,
    memory: { percent: 25, used: 4 * 1024 ** 3, total: 16 * 1024 ** 3 } };
  assert.equal(component.cpu(), "0.0%");
  assert.equal(component.memory(), "25.0%");
  assert.equal(component.memoryAmount(), "4.0 / 16.0 GiB");
  assert.equal(component.stale(), false);
  assert.match(component.sampleTitle(), /server usage, not this browser or an individual agent/);
});

test("missing and invalid readings never become a misleading zero percent", () => {
  const component = new ThreadSystemUsageComponent();
  assert.equal(component.cpu(), "—");
  assert.equal(component.memory(), "—");
  assert.equal(component.memoryAmount(), "");
  assert.match(component.sampleTitle(), /unavailable/);
  component.summary = { cpu: { percent: NaN }, memory: { percent: -1, used: 12, total: 0 } };
  assert.equal(component.cpu(), "—");
  assert.equal(component.memory(), "—");
  assert.equal(component.memoryAmount(), "");
  component.summary = { cpuPercent: 12.34, memory: { percent: 101 } };
  assert.equal(component.cpu(), "12.3%");
  assert.equal(component.memory(), "—");
});

test("old or unverified samples are explicitly marked as last samples", () => {
  const component = new ThreadSystemUsageComponent();
  component.summary = { generatedAt: new Date(Date.now() - 120_000).toISOString(), cpu: { percent: 42 } };
  assert.equal(component.stale(), true);
  assert.equal(component.cpu(), "42.0%");
  assert.match(component.sampleTitle(), /Showing the last sample/);
  component.summary = { generatedAt: "invalid" };
  assert.equal(component.stale(), true);
});

test("version badge reveals the full installed OSS version with native keyboard controls", async () => {
  const template = await fs.readFile("apps/web/src/app/app.component.html", "utf8");
  const styles = await fs.readFile("apps/web/src/thread-tools.css", "utf8");
  assert.match(template, /<ork-thread-system-usage \[summary\]="opsSystem">/);
  assert.match(template, /<details class="deployment-version">\s*<summary class="version-pill"/);
  assert.match(template, /OSS version <code>\{\{ versionInfo\?\.version/);
  assert.match(template, /<pre>\{\{ deploymentVersionTitle\(\) \}\}<\/pre>/);
  assert.match(styles, /\.chat-head \.deployment-version > \.version-pill \{ display: inline-flex/);
  assert.match(styles, /summary:focus-visible/);
  assert.doesNotMatch(source, /setInterval|HttpClient|firstValueFrom/);
});
