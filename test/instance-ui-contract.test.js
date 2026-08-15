import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

test("instance shell uses one lean navigation and canonical desktop and timer routes", async () => {
  const [template, component, styles] = await Promise.all([
    fs.readFile("apps/web/src/app/app.component.html", "utf8"),
    fs.readFile("apps/web/src/app/app.component.ts", "utf8"),
    fs.readFile("apps/web/src/styles.css", "utf8"),
  ]);

  assert.match(template, /<nav class="instance-nav" aria-label="Instance navigation">/);
  for (const destination of ["Threads", "Files", "Desktops", "Timers", "Settings"]) {
    assert.match(template, new RegExp(`>${destination}<\\/button>`));
  }
  assert.doesNotMatch(template, /class="user-mode-nav"/);
  assert.doesNotMatch(template, /class="user-mode-card"/);
  assert.doesNotMatch(template, /openPanel\('userJobs'\)/);
  assert.doesNotMatch(template, />Jobs<\/button>/);
  assert.doesNotMatch(template, /<ork-ops-page/);
  assert.match(component, /panel === "instanceDesktops"\) return this\.instancePath\("\/desktops"\)/);
  assert.match(component, /panel === "instanceTimers"\) return this\.instancePath\("\/timers"\)/);
  assert.doesNotMatch(component, /type Panel = [^;]*"userJobs"/);
  assert.doesNotMatch(component, /OpsPageComponent|openTools\(|toolsView/);
  assert.match(styles, /\.instance-nav\s*\{/);
  assert.match(styles, /\.instance-metric-strip\s*\{/);
});

test("Jobs frontend page and page-specific client calls are absent", async () => {
  const [api, files] = await Promise.all([
    fs.readFile("apps/web/src/app/api.service.ts", "utf8"),
    fs.readdir("apps/web/src/app"),
  ]);

  assert.equal(files.includes("user-jobs-page.component.ts"), false);
  assert.equal(files.includes("user-jobs-page.component.html"), false);
  assert.doesNotMatch(api, /jobAlertRoutes\(/);
  assert.doesNotMatch(api, /createJobAlertRoute\(/);
  assert.doesNotMatch(api, /testJobAlertRoute\(/);
  assert.doesNotMatch(api, /createCalendarExport\(/);
  assert.doesNotMatch(api, /orkestrMailDrafts\(/);
});

test("desktop and timer pages expose focused instance health and action hierarchy", async () => {
  const [desktopTemplate, desktopComponent, timerTemplate, timerComponent] = await Promise.all([
    fs.readFile("apps/web/src/app/user-desk-page.component.html", "utf8"),
    fs.readFile("apps/web/src/app/user-desk-page.component.ts", "utf8"),
    fs.readFile("apps/web/src/app/user-timers-page.component.html", "utf8"),
    fs.readFile("apps/web/src/app/user-timers-page.component.ts", "utf8"),
  ]);

  assert.match(desktopTemplate, /<h3>Desktops<\/h3>/);
  assert.match(desktopTemplate, /Desktop ID/);
  assert.match(desktopTemplate, /Assigned threads/);
  assert.match(desktopTemplate, /Open Desktop/);
  assert.match(desktopTemplate, /Share/);
  assert.match(desktopComponent, /this\.api\.createDesktopShare\(slug, \{/);
  assert.doesNotMatch(desktopTemplate, /\/desktop\/[^\s]+\/vnc\.html/);

  assert.match(timerTemplate, /<h3>Timers<\/h3>/);
  assert.match(timerTemplate, /Timer health/);
  assert.match(timerTemplate, /Owning thread/);
  assert.match(timerTemplate, /Next run/);
  assert.match(timerTemplate, /Last run/);
  assert.match(timerTemplate, /Run now/);
  assert.match(timerComponent, /automationOutcomeLabel\(automation: AutomationRecord\)/);
});
