import { requestJson } from "./api-client.js";

function positional(argv) {
  const values = [];
  const flagsWithValues = new Set([
    "--address",
    "--id",
    "--idempotency-key",
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
    "--recipient",
    "--request-id",
    "--state",
    "--status",
    "--suffix",
    "--target",
    "--tenant-vm",
    "--tenant-vm-id",
    "--title",
    "--to",
    "--type",
    "--user-id",
    "--from",
    "--message-id",
    "--mode",
    "--approval",
    "--route-id",
    "--thread",
    "--thread-id",
    "--work-id",
    "--context-id",
    "--expected-policy-revision",
    "--provider",
    "--subject",
    "--text",
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
    ["--thread", "threadId"],
    ["--thread-id", "threadId"],
    ["--mode", "mode"],
    ["--idempotency-key", "idempotencyKey"],
  ]) {
    const value = flagValue(argv, flag);
    if (value) body[key] = value;
  }
  return body;
}

function mailboxActionBody(argv = []) {
  const body = {};
  for (const [flag, key] of [
    ["--idempotency-key", "idempotencyKey"],
    ["--request-id", "requestId"],
    ["--provider", "provider"],
    ["--state", "state"],
    ["--status", "status"],
    ["--suffix", "suffix"],
    ["--reason", "overrideReason"],
    ["--approval", "approval"],
  ]) {
    const value = flagValue(argv, flag);
    if (value) body[key] = value;
  }
  if (argv.includes("--confirm")) body.confirm = true;
  return body;
}

function mailboxRouteBody(argv = []) {
  const body = mailboxActionBody(argv);
  for (const [flag, key] of [
    ["--thread", "threadId"],
    ["--thread-id", "threadId"],
    ["--mode", "mode"],
    ["--expected-policy-revision", "expectedPolicyRevision"],
  ]) {
    const value = flagValue(argv, flag);
    if (value) body[key] = value;
  }
  return body;
}

function writeRouteMutation(payload = {}, ctx, json = false) {
  if (json) {
    ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  if (payload.status === "approval_required") {
    const challenge = payload.challenge || {};
    const approval = challenge.approveCode || challenge.id || "<challenge-id>";
    ctx.stdout.write(`Approval required: ${challenge.approveCommand || `orkestr security approve ${approval}`}\nRetry the same route command with --approval ${approval}.\n`);
    return;
  }
  ctx.stdout.write(`${payload.route?.id || ""}\n`);
}

function mailboxIngestBody(argv = []) {
  const body = {
    mailboxId: flagValue(argv, "--mailbox") || flagValue(argv, "--mailbox-id") || "",
    recipient: flagValue(argv, "--recipient") || flagValue(argv, "--to") || "",
    headers: {
      messageId: flagValue(argv, "--message-id") || "",
      from: flagValue(argv, "--from") || "",
      subject: flagValue(argv, "--subject") || "",
    },
    body: {
      text: flagValue(argv, "--text") || "",
    },
    envelope: {
      rcptTo: flagValue(argv, "--recipient") || flagValue(argv, "--to") || "",
      mailFrom: flagValue(argv, "--from") || "",
    },
  };
  if (!body.mailboxId) delete body.mailboxId;
  if (!body.recipient) delete body.recipient;
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

function formatMailboxAction(label = "Mailbox", mailbox = {}) {
  return [
    `${label}: ${mailbox.address || mailbox.id || "-"}`,
    `Status: ${mailbox.status || "-"}`,
    `Owner: ${mailbox.ownerUserId || "-"}`,
    `Target: ${mailbox.target?.type === "vm" ? `vm:${mailbox.target.tenantVmId || "-"}` : "main"}`,
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

function formatMailboxInfrastructure(infrastructure = {}) {
  return [
    `Mailbox infrastructure: ${infrastructure.ready ? "ready" : "not ready"}`,
    `Domain: ${infrastructure.domain || "-"}`,
    `Adapter: ${infrastructure.adapter || "-"}`,
    `Propagation: ${infrastructure.propagationState || "-"}`,
    infrastructure.reason ? `Reason: ${infrastructure.reason}` : "",
  ].filter(Boolean).join("\n") + "\n";
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
  if (subcommand === "status" || subcommand === "infrastructure") {
    const payload = await requestJson("/api/mailboxes/infrastructure", ctx);
    if (json) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else ctx.stdout.write(formatMailboxInfrastructure(payload.infrastructure || {}));
    return 0;
  }
  if (subcommand === "verify") {
    const mailboxId = positional(rest)[0] || flagValue(rest, "--mailbox") || flagValue(rest, "--mailbox-id");
    if (!mailboxId) throw new Error("Usage: orkestr mailboxes verify <mailbox-id> [--state verified|verification-pending] [--json]");
    const payload = await requestJson(`/api/mailboxes/${encodeURIComponent(mailboxId)}/verification`, { ...ctx, method: "PATCH", body: mailboxActionBody(rest) });
    if (json) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else ctx.stdout.write(formatMailboxAction("Mailbox", payload.mailbox || {}));
    return 0;
  }
  if (subcommand === "delete" || subcommand === "remove") {
    const mailboxId = positional(rest)[0] || flagValue(rest, "--mailbox") || flagValue(rest, "--mailbox-id");
    if (!mailboxId) throw new Error("Usage: orkestr mailboxes delete <mailbox-id> [--json]");
    const payload = await requestJson(`/api/mailboxes/${encodeURIComponent(mailboxId)}`, { ...ctx, method: "DELETE", body: mailboxActionBody(rest) });
    if (json) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else ctx.stdout.write(formatMailboxAction("Deleted", payload.mailbox || {}));
    return 0;
  }
  if (subcommand === "rotate") {
    const mailboxId = positional(rest)[0] || flagValue(rest, "--mailbox") || flagValue(rest, "--mailbox-id");
    if (!mailboxId) throw new Error("Usage: orkestr mailboxes rotate <mailbox-id> [--suffix value] [--json]");
    const payload = await requestJson(`/api/mailboxes/${encodeURIComponent(mailboxId)}/rotate`, { ...ctx, method: "POST", body: mailboxActionBody(rest) });
    if (json) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else ctx.stdout.write(formatMailboxAction("Rotated to", payload.mailbox || {}));
    return 0;
  }
  if (subcommand === "ingest") {
    const body = mailboxIngestBody(rest);
    if (!body.mailboxId && !body.recipient) throw new Error("Usage: orkestr mailboxes ingest [--mailbox-id id|--recipient address] [--message-id id] [--text text] [--json]");
    const payload = await requestJson("/api/mailboxes/ingest", { ...ctx, method: "POST", body });
    if (json) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else ctx.stdout.write(`${payload.action || "mailbox_ingested"} ${payload.mailbox?.id || ""}\n`);
    return 0;
  }
  if (subcommand === "relay-audits" || subcommand === "relay-audit") {
    const payload = await requestJson(`/api/mailboxes/relay-audits${mailboxQueryString(rest)}`, ctx);
    if (json) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else ctx.stdout.write(formatMailboxRelayAuditTable(payload.relayAudits || []));
    return 0;
  }
  if (subcommand === "retry") {
    const relayAuditId = positional(rest)[0];
    if (!relayAuditId) throw new Error("Usage: orkestr mailboxes retry <relay-audit-id> [--json]");
    const payload = await requestJson(`/api/mailboxes/relay-audits/${encodeURIComponent(relayAuditId)}/retry`, { ...ctx, method: "POST", body: mailboxActionBody(rest) });
    if (json) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else ctx.stdout.write(formatMailboxRelayAuditTable([payload.relayAudit || {}]));
    return 0;
  }
  if (subcommand === "dead-letters" || subcommand === "dead-letter") {
    const payload = await requestJson(`/api/mailboxes/dead-letters${mailboxQueryString(rest)}`, ctx);
    if (json) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else ctx.stdout.write(formatMailboxDeadLetterTable(payload.deadLetters || []));
    return 0;
  }
  if (subcommand === "replay") {
    const deadLetterId = positional(rest)[0];
    if (!deadLetterId) throw new Error("Usage: orkestr mailboxes replay <dead-letter-id> --confirm [--json]");
    const payload = await requestJson(`/api/mailboxes/dead-letters/${encodeURIComponent(deadLetterId)}/replay`, { ...ctx, method: "POST", body: mailboxActionBody(rest) });
    if (json) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else ctx.stdout.write(formatMailboxRelayAuditTable([payload.relayAudit || {}]));
    return 0;
  }
  if (subcommand === "routes" || subcommand === "route") {
    const values = positional(rest);
    const action = values[0] || "list";
    const mailboxId = flagValue(rest, "--mailbox") || flagValue(rest, "--mailbox-id");
    if (!mailboxId) throw new Error("Usage: orkestr mailboxes routes <list|status|create|move|revoke|retry|cancel|context-discard> --mailbox-id id [--json]");
    const body = mailboxRouteBody(rest);
    if (action === "list") {
      const payload = await requestJson(`/api/mailboxes/${encodeURIComponent(mailboxId)}/routes`, ctx);
      if (json) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      else ctx.stdout.write(`${(payload.routes || []).map((route) => `${route.id} ${route.mode} ${route.threadId} ${route.status}`).join("\n")}\n`);
      return 0;
    }
    if (action === "status") {
      const payload = await requestJson(`/api/mailboxes/${encodeURIComponent(mailboxId)}/route-status`, ctx);
      if (json) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      else ctx.stdout.write(`${JSON.stringify(payload.status || {}, null, 2)}\n`);
      return 0;
    }
    if (action === "create") {
      const payload = await requestJson(`/api/mailboxes/${encodeURIComponent(mailboxId)}/routes`, { ...ctx, method: "POST", body });
      writeRouteMutation(payload, ctx, json);
      return 0;
    }
    if (action === "move") {
      const routeId = flagValue(rest, "--route-id") || values[1];
      if (!routeId) throw new Error("Usage: orkestr mailboxes routes move --mailbox-id id --route-id id --thread-id id [--mode mode] [--approval challenge-id]");
      const payload = await requestJson(`/api/mailboxes/${encodeURIComponent(mailboxId)}/routes/${encodeURIComponent(routeId)}`, { ...ctx, method: "PATCH", body });
      writeRouteMutation(payload, ctx, json);
      return 0;
    }
    if (action === "revoke") {
      const routeId = flagValue(rest, "--route-id") || values[1];
      if (!routeId) throw new Error("Usage: orkestr mailboxes routes revoke --mailbox-id id --route-id id");
      const payload = await requestJson(`/api/mailboxes/${encodeURIComponent(mailboxId)}/routes/${encodeURIComponent(routeId)}`, { ...ctx, method: "DELETE", body });
      if (json) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`); else ctx.stdout.write(`${payload.route?.status || "revoked"}\n`);
      return 0;
    }
    if (action === "retry") {
      const workId = flagValue(rest, "--work-id") || values[1];
      if (!workId) throw new Error("Usage: orkestr mailboxes routes retry --mailbox-id id --work-id id");
      const payload = await requestJson(`/api/mailboxes/${encodeURIComponent(mailboxId)}/route-work/${encodeURIComponent(workId)}/retry`, { ...ctx, method: "POST", body });
      if (json) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`); else ctx.stdout.write(`${payload.accepted || payload.delivered || 0}\n`);
      return 0;
    }
    if (action === "cancel") {
      const workId = flagValue(rest, "--work-id") || values[1];
      if (!workId) throw new Error("Usage: orkestr mailboxes routes cancel --mailbox-id id --work-id id");
      const payload = await requestJson(`/api/mailboxes/${encodeURIComponent(mailboxId)}/route-work/${encodeURIComponent(workId)}`, { ...ctx, method: "DELETE", body });
      if (json) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`); else ctx.stdout.write(`${payload.work?.state || "cancelled"}\n`);
      return 0;
    }
    if (action === "context-discard") {
      const contextId = flagValue(rest, "--context-id") || values[1];
      if (!contextId) throw new Error("Usage: orkestr mailboxes routes context-discard --mailbox-id id --context-id id");
      const payload = await requestJson(`/api/mailboxes/${encodeURIComponent(mailboxId)}/contexts/${encodeURIComponent(contextId)}`, { ...ctx, method: "DELETE", body });
      if (json) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`); else ctx.stdout.write("discarded\n");
      return 0;
    }
    throw new Error("Usage: orkestr mailboxes routes <list|status|create|move|revoke|retry|cancel|context-discard> --mailbox-id id");
  }
  throw new Error("Usage: orkestr mailboxes [list|status|create|verify|delete|rotate|ingest|retry|relay-audits|dead-letters|replay|routes] [--json]");
}
