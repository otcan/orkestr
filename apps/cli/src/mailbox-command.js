import { requestJson } from "./api-client.js";

function positional(argv) {
  const values = [];
  const flagsWithValues = new Set([
    "--address",
    "--id",
    "--label",
    "--limit",
    "--local-part",
    "--mailbox",
    "--mailbox-id",
    "--name",
    "--owner",
    "--owner-user-id",
    "--purpose",
    "--reason",
    "--state",
    "--status",
    "--suffix",
    "--target",
    "--tenant-vm",
    "--tenant-vm-id",
    "--title",
    "--type",
    "--user-id",
    "--vm",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--json") continue;
    if (flagsWithValues.has(value)) {
      index += 1;
      continue;
    }
    if (!String(value || "").startsWith("--")) values.push(value);
  }
  return values;
}

function flagValue(argv, flag) {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] || "" : "";
}

function mailboxCreateBody(argv = []) {
  const values = positional(argv);
  const body = {};
  const purpose = flagValue(argv, "--purpose") || flagValue(argv, "--name") || values[0] || "";
  if (purpose) body.purpose = purpose;
  const displayName = flagValue(argv, "--label") || flagValue(argv, "--title") || "";
  if (displayName) body.displayName = displayName;
  for (const [flag, key] of [
    ["--id", "id"],
    ["--owner", "ownerUserId"],
    ["--owner-user-id", "ownerUserId"],
    ["--user-id", "ownerUserId"],
    ["--address", "address"],
    ["--local-part", "localPart"],
    ["--suffix", "suffix"],
    ["--status", "status"],
    ["--target", "targetType"],
    ["--type", "targetType"],
    ["--tenant-vm", "tenantVmId"],
    ["--tenant-vm-id", "tenantVmId"],
    ["--vm", "tenantVmId"],
    ["--reason", "overrideReason"],
  ]) {
    const value = flagValue(argv, flag);
    if (value) body[key] = value;
  }
  return body;
}

function mailboxQueryString(argv = []) {
  const params = new URLSearchParams();
  for (const [flag, key] of [
    ["--mailbox", "mailboxId"],
    ["--mailbox-id", "mailboxId"],
    ["--tenant-vm", "tenantVmId"],
    ["--tenant-vm-id", "tenantVmId"],
    ["--vm", "tenantVmId"],
    ["--state", "state"],
    ["--limit", "limit"],
  ]) {
    const value = flagValue(argv, flag);
    if (value) params.set(key, value);
  }
  return params.size ? `?${params.toString()}` : "";
}

function formatMailboxTable(mailboxes = []) {
  if (!mailboxes.length) return "No mailboxes.\n";
  return [
    "ID\tADDRESS\tOWNER\tTARGET\tSTATUS\tSOURCE",
    ...mailboxes.map((mailbox) => [
      mailbox.id || "-",
      mailbox.address || "-",
      mailbox.ownerUserId || "-",
      mailbox.target?.type === "vm" ? `vm:${mailbox.target.tenantVmId || "-"}` : "main",
      mailbox.status || "-",
      mailbox.targetSelection?.selectionSource || mailbox.source || "-",
    ].join("\t")),
  ].join("\n") + "\n";
}

function formatMailboxCreated(mailbox = {}) {
  return [
    `Mailbox: ${mailbox.address || mailbox.id || "-"}`,
    `Owner: ${mailbox.ownerUserId || "-"}`,
    `Target: ${mailbox.target?.type === "vm" ? `vm:${mailbox.target.tenantVmId || "-"}` : "main"}`,
    `Selection: ${mailbox.targetSelection?.selectionSource || "-"} ${mailbox.targetSelection?.ambiguityResult || ""}`.trim(),
  ].join("\n") + "\n";
}

function formatMailboxRelayAuditTable(audits = []) {
  if (!audits.length) return "No mailbox relay audits.\n";
  return [
    "ID\tMAILBOX\tTENANT_VM\tSTATE\tSELECTION\tCREATED",
    ...audits.map((audit) => [
      audit.id || "-",
      audit.mailboxId || "-",
      audit.tenantVmId || "-",
      audit.state || "-",
      audit.targetSelection?.selectionSource || "-",
      audit.createdAt || "-",
    ].join("\t")),
  ].join("\n") + "\n";
}

function formatMailboxDeadLetterTable(deadLetters = []) {
  if (!deadLetters.length) return "No mailbox dead letters.\n";
  return [
    "ID\tMAILBOX\tTENANT_VM\tREASON\tSTATE\tCREATED",
    ...deadLetters.map((entry) => [
      entry.id || "-",
      entry.mailboxId || "-",
      entry.tenantVmId || "-",
      entry.reason || "-",
      entry.state || "-",
      entry.createdAt || "-",
    ].join("\t")),
  ].join("\n") + "\n";
}

export async function mailboxesCommand(argv, ctx) {
  const subcommand = argv[0]?.startsWith("--") ? "list" : argv[0] || "list";
  const rest = subcommand === "list" && argv[0]?.startsWith("--") ? argv : argv.slice(1);
  const json = argv.includes("--json") || rest.includes("--json");
  if (subcommand === "list" || subcommand === "ls") {
    const payload = await requestJson("/api/mailboxes", ctx);
    if (json) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else ctx.stdout.write(formatMailboxTable(payload.mailboxes || []));
    return 0;
  }
  if (subcommand === "create") {
    const body = mailboxCreateBody(rest);
    if (!body.purpose && !body.displayName) throw new Error("Usage: orkestr mailboxes create --purpose <name> [--target vm --tenant-vm-id <id>] [--json]");
    const payload = await requestJson("/api/mailboxes", { ...ctx, method: "POST", body });
    if (json) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else ctx.stdout.write(formatMailboxCreated(payload.mailbox || {}));
    return 0;
  }
  if (subcommand === "relay-audits" || subcommand === "relay-audit") {
    const payload = await requestJson(`/api/mailboxes/relay-audits${mailboxQueryString(rest)}`, ctx);
    if (json) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else ctx.stdout.write(formatMailboxRelayAuditTable(payload.relayAudits || []));
    return 0;
  }
  if (subcommand === "dead-letters" || subcommand === "dead-letter") {
    const payload = await requestJson(`/api/mailboxes/dead-letters${mailboxQueryString(rest)}`, ctx);
    if (json) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else ctx.stdout.write(formatMailboxDeadLetterTable(payload.deadLetters || []));
    return 0;
  }
  throw new Error("Usage: orkestr mailboxes [list|create|relay-audits|dead-letters] [--json]");
}
