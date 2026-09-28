import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const files = {
  switcher: new URL("../apps/web/src/app/executor-switcher.component.ts", import.meta.url),
  api: new URL("../apps/web/src/app/api.service.ts", import.meta.url),
  app: new URL("../apps/web/src/app/app.component.ts", import.meta.url),
  template: new URL("../apps/web/src/app/app.component.html", import.meta.url),
};

test("thread header offers an in-place Codex/Claude executor switch", async () => {
  const [switcher, api, app, template] = await Promise.all(Object.values(files).map((file) => fs.readFile(file, "utf8")));
  assert.match(switcher, /selector: "ork-executor-switcher"/);
  assert.match(switcher, /providers: QuotaProvider\[\] = \["codex", "claude"\]/);
  // A busy thread must never be switched mid-turn from the header.
  assert.match(switcher, /when: this\.working \? "after_turn" : "now"/);
  assert.match(switcher, /provider === "claude" \? "claude-code" : "codex"/);
  assert.doesNotMatch(switcher, /localStorage|sessionStorage|console\.log/);
  assert.match(api, /this\.http\.put<[^>]+>\(this\.api\(`\/threads\/\$\{encodeURIComponent\(id\)\}\/executor`\), body\)/);
  assert.match(api, /this\.http\.get<[^>]+>\(this\.api\(`\/threads\/\$\{encodeURIComponent\(id\)\}\/executor`\)\)/);
  assert.match(app, /ExecutorSwitcherComponent\]/);
  assert.match(template, /<ork-executor-switcher \[threadId\]="thread\.id" \[activeProvider\]="activeExecutorProvider\(thread\)" \[working\]="threadIsWorking\(thread\)" \(switched\)="onExecutorSwitched\(\)">/);
});
