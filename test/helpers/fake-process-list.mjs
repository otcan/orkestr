import fs from "node:fs/promises";
import path from "node:path";

// Installs a fake `ps` next to a fake tmux so runtime doctor scans only see
// processes a test declares. Without it the doctor lists real host processes
// and may flag (or, with repair, signal) unrelated Codex processes.
// Tests opt in to rows by pointing FAKE_PS_OUTPUT at a file containing
// "pid ppid pgid comm args" lines; by default the listing is empty.
export async function installFakePs(bin) {
  const psPath = path.join(bin, "ps");
  await fs.writeFile(
    psPath,
    `#!/usr/bin/env bash
if [ -n "\${FAKE_PS_OUTPUT:-}" ] && [ -f "\${FAKE_PS_OUTPUT:-}" ]; then cat "\${FAKE_PS_OUTPUT:-}"; fi
exit 0
`,
    "utf8",
  );
  await fs.chmod(psPath, 0o755);
  return psPath;
}
