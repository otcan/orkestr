#!/usr/bin/env node
import { migrateCanonicalPublicReferences } from "../packages/core/src/canonical-public-reference-migration.js";

const args = new Set(process.argv.slice(2));
if (args.has("--help") || args.has("-h")) {
  process.stdout.write([
    "Usage: node scripts/migrate-canonical-public-references.mjs [--dry-run|--apply]",
    "",
    "Dry-run is the default and reports counts without generating or persisting refs.",
    "Apply requires ORKESTR_CANONICAL_INSTANCE_URLS=1.",
    "",
  ].join("\n"));
  process.exit(0);
}

if (args.has("--dry-run") && args.has("--apply")) {
  process.stderr.write("Choose only one of --dry-run or --apply.\n");
  process.exit(2);
}

const unknown = [...args].filter((arg) => !["--dry-run", "--apply"].includes(arg));
if (unknown.length) {
  process.stderr.write(`Unknown argument: ${unknown[0]}\n`);
  process.exit(2);
}

const mode = args.has("--apply") ? "apply" : "dry-run";
try {
  const result = await migrateCanonicalPublicReferences({ mode });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error?.code || error?.message || "canonical_public_ref_migration_failed"}\n`);
  process.exit(1);
}
