import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const appDir = "apps/web/src/app/";

async function read(name) {
  return fs.readFile(`${appDir}${name}`, "utf8");
}

test("personal-agent home follows the OP-02 capability contract and stays hidden when disabled", async () => {
  const [source, template] = await Promise.all([read("app.component.ts"), read("app.component.html")]);
  const file = ts.createSourceFile("app.component.ts", source, ts.ScriptTarget.Latest, true);
  const declaration = file.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "AppComponent");
  const enabledMethod = declaration.members.find(node => node.name?.getText(file) === "personalAgentHomeEnabled");
  const harnessSource = `class Harness { personalAgentCapability = { enabled: () => this.value?.enabled === true }; value = null; ${enabledMethod.getText(file)} }; exports.Harness = Harness;`;
  const output = ts.transpileModule(harnessSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const exports = {};
  vm.runInNewContext(output, { exports });
  const app = new exports.Harness();
  assert.equal(app.personalAgentHomeEnabled(), false);
  app.value = { enabled: false, capability: false };
  assert.equal(app.personalAgentHomeEnabled(), false);
  app.value = { enabled: true, capability: false };
  assert.equal(app.personalAgentHomeEnabled(), true, "configured home may show its explicit offline state");

  const nav = template.match(/<nav class="instance-topbar-nav"[\s\S]*?<\/nav>/)?.[0] || "";
  assert.match(nav, /@if \(personalAgentHomeEnabled\(\)\)[\s\S]*>Home<\/button>/);
  assert.match(template, /@if \(activePanel === "personalHome" && personalAgentHomeEnabled\(\)\)[\s\S]*<ork-personal-agent-home/);
  assert.match(template, /\} @else if \(activePanel === "chat" \|\| \(activePanel === "personalHome" && !personalAgentHomeEnabled\(\)\)\) \{\s*<section #messagePane class="messages"/,
    "the existing conversations/message renderer remains the unchanged flag-off branch");
});

test("home shell exposes verified state and existing-thread actions without fabricated product data", async () => {
  const [component, template, styles] = await Promise.all([
    read("personal-agent-home.component.ts"),
    read("personal-agent-home.component.html"),
    read("personal-agent-home.component.css"),
  ]);
  assert.match(template, /Grounded briefing/);
  for (const section of ["Primary conversation", "Active work", "Needs attention", "Recent results", "Conversations"]) {
    assert.match(template, new RegExp(section));
  }
  for (const state of ["loading", "offline", "stale", "unavailable"]) assert.match(component, new RegExp(`"${state}"`));
  assert.match(template, /aria-live="polite"/);
  assert.match(template, /\(openConversation\)|openConversation\.emit\(thread\)/);
  assert.match(template, /\(showAllConversations\)|showAllConversations\.emit\(\)/);
  assert.match(template, /conversations\.slice\(0, 5\)/);
  assert.doesNotMatch(template, /\b\d+\s+(?:active|pending|completed)\b/i);
  assert.doesNotMatch(component + template, /fixture|mock(?:ed)? data/i);
  assert.match(styles, /@media \(max-width: 860px\)/);
  assert.match(styles, /@media \(max-width: 560px\)/);
  assert.match(styles, /:focus-visible|focus/i);
});

test("personal-agent UI fixture is synthetic and only used by this test", async () => {
  const fixture = { id: "synthetic-thread", title: "Example conversation", status: "active" };
  const component = await read("personal-agent-home.component.ts");
  assert.equal(fixture.id, "synthetic-thread");
  assert.doesNotMatch(component, /synthetic-thread|Example conversation/);
});
