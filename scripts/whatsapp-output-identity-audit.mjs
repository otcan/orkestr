import fs from "node:fs/promises";
import { auditWhatsAppOutputIdentity } from "../packages/connectors/src/whatsapp-output-identity-audit.js";

// Offline snapshots only: this command cannot hydrate history, open a runtime
// repository, send connector messages, or apply repairs.
const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== "--snapshot" || args[2] !== "--scope") {
  console.error("Usage: node scripts/whatsapp-output-identity-audit.mjs --snapshot snapshot.json --scope scope.json");
  process.exitCode = 2;
} else {
  try {
    const read = async (file, maxBytes) => {
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > maxBytes) throw new Error("output_audit_file_limit");
      return JSON.parse(await fs.readFile(file, "utf8"));
    };
    const snapshot = await read(args[1], 64 * 1024 * 1024);
    const scope = await read(args[3], 16384);
    console.log(JSON.stringify(auditWhatsAppOutputIdentity(snapshot, scope), null, 2));
  } catch (error) {
    // Do not print paths or JSON parsing excerpts from private snapshots.
    console.error(/^output_audit_[a-z_]+$/.test(error.message) ? error.message : "output_audit_failed");
    process.exitCode = 1;
  }
}
