import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

test("standalone launcher is route-isolated, mobile responsive, and uses redacted directory data", async () => {
  const [rootTemplate, rootComponent, api, launcherTemplate, launcherComponent, launcherStyles] = await Promise.all([
    fs.readFile("apps/web/src/app/app.component.html", "utf8"),
    fs.readFile("apps/web/src/app/app.component.ts", "utf8"),
    fs.readFile("apps/web/src/app/api.service.ts", "utf8"),
    fs.readFile("apps/web/src/app/public-apps-page.component.html", "utf8"),
    fs.readFile("apps/web/src/app/public-apps-page.component.ts", "utf8"),
    fs.readFile("apps/web/src/app/public-apps-page.component.css", "utf8"),
  ]);

  assert.match(rootTemplate, /@else if \(publicAppsActive\(\)\) \{\s*<ork-public-apps-page>/);
  assert.match(rootComponent, /publicAppsActive\(\): boolean \{\s*return this\.locationPathParts\(\)\[0\] === "apps";/s);
  assert.match(rootComponent, /if \(this\.sharedAppActive\(\) \|\| this\.publicAppsActive\(\)\) \{/);
  assert.match(api, /myLauncher\(\): Observable<LauncherDirectoryResponse>/);
  assert.match(api, /publicApp\(slug: string\)/);
  assert.match(launcherComponent, /this\.api\.myLauncher\(\)/);
  assert.match(launcherComponent, /this\.api\.publicApp\(slug\)/);
  assert.match(launcherComponent, /this\.api\.openInstanceAccount\(workspace\.publicRef\)/);
  assert.match(launcherTemplate, /Where do you want to work\?/);
  assert.match(launcherTemplate, /<h2 id="workspaces-title">Workspaces<\/h2>/);
  assert.match(launcherTemplate, /<h2 id="applications-title">Applications<\/h2>/);
  assert.match(launcherTemplate, /\[href\]="app\.url"/);
  assert.match(launcherStyles, /@media \(max-width: 700px\)/);
  assert.match(launcherStyles, /env\(safe-area-inset-bottom\)/);
  assert.match(launcherStyles, /grid-template-columns: 1fr/);
  assert.doesNotMatch(launcherTemplate, /targetRef|tenantRef|endpoint|thread/i);
  assert.doesNotMatch(api.match(/export interface PublicAppCard[\s\S]*?\n\}/)?.[0] || "", /targetRef|tenantRef|endpoint/i);
});
