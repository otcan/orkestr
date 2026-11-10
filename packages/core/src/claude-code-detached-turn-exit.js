import fs from "node:fs/promises";
import os from "node:os";

// When a detached Claude turn ends before its wrapper ran (for example a
// signal while `systemd-run --scope` was still creating the scope, before it
// exec'd the wrapper), no exit record exists. The server observed the exit
// through its child handle, so it records that exit. The wrapper's own record
// is never overwritten, and the record says it was observed by the server.
export async function recordObservedExit(record, { code, signal }, readExistingExit) {
  const exitPath = record.paths?.exit;
  if (!exitPath || await readExistingExit()) return;
  const number = signal ? os.constants.signals[signal] : undefined;
  const shellCode = Number.isInteger(code) ? code : Number.isInteger(number) ? 128 + number : null;
  if (shellCode === null) return;
  const at = Math.floor(Date.now() / 1000);
  const tmp = `${exitPath}.server-${process.pid}.tmp`;
  try {
    await fs.writeFile(tmp, `${JSON.stringify({ code: shellCode, at, observedBy: "server" })}\n`, { mode: 0o600 });
    // link() refuses to replace an existing record, so a late wrapper write wins.
    await fs.link(tmp, exitPath).catch((error) => { if (error?.code !== "EEXIST") throw error; });
    if (signal) await fs.appendFile(`${exitPath}.signals`, `${signal.replace(/^SIG/, "")} ${at}\n`, { mode: 0o600 });
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}
