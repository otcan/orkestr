import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readManagedDesktopSession } from "../packages/browsers/src/browserctl.js";

test("desktop target read asks a capable local provider for one live session", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-targeted-desktop-"));
  const command = path.join(home, "browserctl");
  await fs.writeFile(command, `#!/bin/sh
if [ "$1" != target ] || [ "$2" != example-desk ]; then exit 41; fi
printf '%s\\n' '{"ok":true,"session":{"slug":"example-desk","status":"active","type":"desktop","upstream":"127.0.0.1:16084","managed":true}}'
`, { mode: 0o700 });
  const session = await readManagedDesktopSession("example-desk", {
    ORKESTR_HOME: home,
    ORKESTR_ADMIN_USER_ID: "admin",
    ORKESTR_BROWSERCTL_PATH: command,
    ORKESTR_BROWSERCTL_TARGETED_READ: "1",
  });
  assert.equal(session.slug, "example-desk");
  assert.equal(session.status, "active");
  assert.equal(session.upstream, "127.0.0.1:16084");
  await assert.rejects(
    () => readManagedDesktopSession("other-desk", {
      ORKESTR_HOME: home,
      ORKESTR_ADMIN_USER_ID: "admin",
      ORKESTR_BROWSERCTL_PATH: command,
      ORKESTR_BROWSERCTL_TARGETED_READ: "1",
    }),
  );
});
