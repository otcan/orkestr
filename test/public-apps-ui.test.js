import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

test("public app launcher is route-isolated and renders only redacted app cards", async () => {
  const [rootTemplate, rootComponent, api, launcherTemplate, launcherComponent] = await Promise.all([
    fs.readFile("apps/web/src/app/app.component.html", "utf8"),
    fs.readFile("apps/web/src/app/app.component.ts", "utf8"),
    fs.readFile("apps/web/src/app/api.service.ts", "utf8"),
    fs.readFile("apps/web/src/app/public-apps-page.component.html", "utf8"),
    fs.readFile("apps/web/src/app/public-apps-page.component.ts", "utf8"),
  ]);

  assert.match(rootTemplate, /@else if \(publicAppsActive\(\)\) \{\s*<ork-public-apps-page>/);
  assert.match(rootComponent, /publicAppsActive\(\): boolean \{\s*return this\.locationPathParts\(\)\[0\] === "apps";/s);
  assert.match(rootComponent, /if \(this\.sharedAppActive\(\) \|\| this\.publicAppsActive\(\)\) \{/);
  assert.match(api, /myPublicApps\(\): Observable<PublicAppsResponse>/);
  assert.match(api, /publicApp\(slug: string\)/);
  assert.match(launcherComponent, /this\.api\.myPublicApps\(\)/);
  assert.match(launcherComponent, /this\.api\.publicApp\(slug\)/);
  assert.match(launcherTemplate, /Only applications granted to your account appear here\./);
  assert.doesNotMatch(launcherTemplate, /targetRef|tenantRef|endpoint|thread/i);
  assert.doesNotMatch(api.match(/export interface PublicAppCard[\s\S]*?\n\}/)?.[0] || "", /targetRef|tenantRef|endpoint/i);
});
