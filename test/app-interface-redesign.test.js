import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const source = (path) => fs.readFile(path, "utf8");

function luminance(hex) {
  const channels = hex.match(/[\da-f]{2}/gi).map((channel) => {
    const value = parseInt(channel, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrast(first, second) {
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

test("application navigation keeps core destinations, existing route handlers and keyboard access", async () => {
  const [template, component, config, style] = await Promise.all([
    source("apps/web/src/app/app.component.html"),
    source("apps/web/src/app/app.component.ts"),
    source("angular.json"),
    source("apps/web/src/app-interface.css"),
  ]);

  assert.match(template, /href="#main-content">Skip to main content/);
  assert.match(template, /id="main-content" class="chat" tabindex="-1"/);
  assert.match(template, /aria-label="Primary navigation"/);
  for (const [label, panel] of [
    ["Conversations", "chat"], ["Desktops", "instanceDesktops"], ["Timers", "instanceTimers"],
  ]) {
    assert.ok(template.includes(`openPanel('${panel}')">${label}</button>`), `${label} route`);
  }
  // Connectors are enabled in Setup; the old Connections page is not in the navigation.
  assert.ok(template.includes(`openSetup('system')">Setup</button>`), "Setup route");
  assert.ok(!template.includes(">Connections</button>"), "no Connections page");
  for (const panel of ["files", "instanceApps", "instanceVault", "instanceSettings"]) {
    assert.ok(template.includes(`openPanel('${panel}')`), `${panel} remains reachable`);
  }
  assert.match(component, /isGlobalPanel\(panel: Panel\): boolean/);
  assert.match(style, /:focus-visible/);
  assert.match(style, /prefers-reduced-motion: reduce/);
  assert.ok(JSON.parse(config).projects.web.architect.build.options.styles.includes("apps/web/src/app-interface.css"));
});

test("self-hosted first run offers owner pairing without claiming an unpaired chat is ready", async () => {
  const [template, component, emptyMessages, desk] = await Promise.all([
    source("apps/web/src/app/first-thread-wizard.component.html"),
    source("apps/web/src/app/first-thread-wizard.component.ts"),
    source("apps/web/src/app/thread-message-list.component.html"),
    source("apps/web/src/app/user-desk-page.component.html"),
  ]);

  assert.match(component, /whatsappAccessMode: WhatsAppAccessMode = "self_hosted"/);
  assert.match(component, /this\.setupStatus\.whatsappOnboarding\?\.selectedMode/);
  assert.match(component, /available\.includes\(selected\)/);
  assert.match(component, /if \(this\.canManageSetup && this\.whatsappModeTouched\)/);
  assert.match(component, /this\.whatsappReady && this\.pairedWhatsAppAccount/);
  assert.match(component, /connectWhatsAppPrivateChat/);
  assert.match(component, /this\.createdThread = thread/);
  assert.match(template, /availableWhatsAppModes\(\)\.includes\('managed'\)/);
  assert.match(template, /availableWhatsAppModes\(\)\.includes\('self_hosted'\)/);
  assert.match(template, /\(pairedAccount\)="onWhatsAppPaired\(\$event\)"/);
  assert.match(template, /You can link WhatsApp, Gmail and timers later in Setup/);
  assert.match(template, /setupRequested\.emit\('whatsapp'\)/);
  assert.match(template, /runtimeProvider === 'claude-code' \? 'Claude Code/);
  assert.match(template, /role="alert"/);
  assert.match(template, /role="status" aria-live="polite"/);
  assert.match(template, /openCreatedThread\(\)/);
  assert.match(template, /@if \(desktopWarning\)/);
  assert.match(emptyMessages, /Ready for your first message/);
  assert.match(desk, /does not connect a LinkedIn API/);
  assert.doesNotMatch(template, /Orkestr relay.*Default\./);
});

test("core interface text and controls meet WCAG AA contrast in the dark palette", async () => {
  const style = await source("apps/web/src/app-interface.css");
  const color = (name) => {
    const match = style.match(new RegExp(`--ui-${name}: (#[0-9a-f]{6});`, "i"));
    assert.ok(match, `missing ${name} token`);
    return match[1];
  };
  for (const [foreground, background] of [
    ["text", "canvas"], ["text", "surface"], ["muted", "surface"],
    ["accent-ink", "accent"], ["focus", "canvas"],
  ]) {
    assert.ok(contrast(color(foreground), color(background)) >= 4.5, `${foreground} on ${background} contrast`);
  }
});
