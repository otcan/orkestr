import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return fs.readFile(path, "utf8");
}

test("owner Hush device controls bind a pairing only to a server-owned profile", async () => {
  const [api, component, template, settings, settingsTemplate] = await Promise.all([
    source("apps/web/src/app/api.service.ts"),
    source("apps/web/src/app/hush-device-management-panel.component.ts"),
    source("apps/web/src/app/hush-device-management-panel.component.html"),
    source("apps/web/src/app/instance-settings-page.component.ts"),
    source("apps/web/src/app/instance-settings-page.component.html"),
  ]);
  const contracts = api.slice(api.indexOf("export interface HushProfileSummary"), api.indexOf("export interface ThreadWorkerRetireResponse"));
  const methods = api.slice(api.indexOf("  hushProfiles()"), api.indexOf("  updateThreadRepo(", api.indexOf("  hushProfiles()")));

  assert.match(settings, /HushDeviceManagementPanelComponent/);
  assert.match(settingsTemplate, /<ork-hush-device-management-panel><\/ork-hush-device-management-panel>/);
  assert.match(template, /server-owned Hush profile/i);
  assert.match(template, /name="hush-profile"/);
  assert.match(component, /this\.api\.approveHushPairing\(profileId, pairingCode\)/);
  assert.match(methods, /this\.api\("\/mobile\/profiles"\)/);
  assert.match(methods, /this\.api\("\/mobile\/devices"\)/);
  assert.match(methods, /\/mobile\/profiles\/\$\{encodeURIComponent\(profileId\)\}\/pairings\/approve/);
  assert.match(methods, /\{ pairingCode \}/);
  assert.match(methods, /\/mobile\/devices\/\$\{encodeURIComponent\(deviceId\)\}\/revoke/);
  assert.match(contracts, /export interface HushProfileSummary/);
  assert.match(contracts, /export interface HushPairedDevice/);
  assert.doesNotMatch(contracts, /\bthreadId\b|\btargetThreadId\b|\bendpoint\b|\bpublicKey\b/i);
  assert.doesNotMatch(methods, /\bthreadId\b|\btargetThreadId\b/i);
  assert.doesNotMatch(component, /\bthreadId\b|\btargetThreadId\b/i);
  assert.doesNotMatch(template, /thread id|conversation id|endpoint/i);
});

test("owner Hush pairing UI clears bearer codes and presents safe lifecycle states", async () => {
  const [component, template] = await Promise.all([
    source("apps/web/src/app/hush-device-management-panel.component.ts"),
    source("apps/web/src/app/hush-device-management-panel.component.html"),
  ]);

  assert.match(component, /this\.pairingCode = "";/);
  assert.match(component, /case "expired":/);
  assert.match(component, /case "revoked":/);
  assert.match(component, /pairingStateLabel\(\): string/);
  assert.match(component, /deviceCanRevoke\(device: HushPairedDevice\): boolean/);
  assert.match(component, /errorText\(error: unknown\): string/);
  assert.match(component, /return "This Hush device request could not be completed\. Refresh and try again\.";/);
  assert.doesNotMatch(component, /return record\?\.message|return String\(error/);
  assert.match(template, /autocomplete="one-time-code"/);
  assert.match(template, /Pairing \{\{ pairingStateLabel\(\) \}\}/);
  assert.doesNotMatch(template, /Pairing \{\{ pairingStatus \}\}/);
  assert.match(template, /Paired devices/);
  assert.match(template, /\(click\)="revokeDevice\(device\)"/);
  assert.match(template, /@if \(deviceCanRevoke\(device\)\)/);
  assert.match(template, /No active Hush profiles are available to this owner\./);
});
