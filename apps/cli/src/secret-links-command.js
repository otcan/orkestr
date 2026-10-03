import { requestJson } from "./api-client.js";

// `orkestr secret share|request|links` (docs/secret-links.md). Secret values
// are read from --stdin or a hidden TTY prompt only and are never printed;
// `share` prints just the one-time link.

export const SECRET_LINKS_USAGE = [
  "Usage:",
  "  orkestr secret share [--stdin] [--from secret://...] [--ttl 15m] [--label text] [--thread id] [--json]",
  "  orkestr secret request <name> [--ttl 15m] [--label text] [--thread id] [--json]",
  "  orkestr secret links list [--json]",
  "  orkestr secret links revoke <id> [--json]",
].join("\n");

const valueFlags = new Set(["--ttl", "--label", "--thread", "--thread-id", "--from"]);

function flag(argv, name) {
  const index = argv.indexOf(name);
  if (index >= 0) return String(argv[index + 1] ?? "");
  const inline = argv.find((item) => item.startsWith(`${name}=`));
  return inline ? inline.slice(name.length + 1) : "";
}

function positionals(argv) {
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (valueFlags.has(item)) {
      index += 1;
      continue;
    }
    if (!item.startsWith("--")) values.push(item);
  }
  return values;
}

function assertNoInlineValue(argv) {
  if (argv.some((item) => /^--(?:secret-)?value(?:=|$)/.test(item))) {
    throw new Error("secret_value_flag_disabled: use --stdin, an interactive TTY prompt, or --from secret://... so values are not written to shell history");
  }
}

function linkBody(argv) {
  const body = {};
  const ttl = flag(argv, "--ttl");
  const label = flag(argv, "--label");
  const threadId = flag(argv, "--thread") || flag(argv, "--thread-id");
  if (ttl) body.ttl = ttl;
  if (label) body.label = label;
  if (threadId) body.threadId = threadId;
  return body;
}

function formatLinks(links = []) {
  if (!links.length) return "No secret links.\n";
  return `${links.map((link) => [link.id, link.kind, link.status, link.name || "-", link.label || "", link.expiresAt || ""].join("\t")).join("\n")}\n`;
}

/**
 * @param {string} subcommand share | request | links
 * @param {string[]} argv remaining arguments
 * @param {object} ctx CLI context
 * @param {{ readValue: (argv: string[], ctx: object) => Promise<string> }} deps
 */
export async function secretLinksCommand(subcommand, argv, ctx, { readValue }) {
  const json = argv.includes("--json");
  assertNoInlineValue(argv);
  const write = (payload, text) => ctx.stdout.write(json ? `${JSON.stringify(payload, null, 2)}\n` : text);
  if (subcommand === "share") {
    const from = flag(argv, "--from");
    const body = linkBody(argv);
    if (from) body.from = from;
    else body.value = await readValue(argv, ctx);
    if (!from && !body.value) throw new Error("secret_value_required");
    const payload = await requestJson("/api/secret-links/share", { ...ctx, method: "POST", body });
    write({ ok: true, link: payload.link, url: payload.url }, `${payload.url}\n`);
    return 0;
  }
  if (subcommand === "request") {
    const name = positionals(argv)[0] || "";
    if (!name) throw new Error(SECRET_LINKS_USAGE);
    const payload = await requestJson("/api/secret-links/request", { ...ctx, method: "POST", body: { ...linkBody(argv), name } });
    write({ ok: true, link: payload.link, url: payload.url }, `${payload.url}\nWhen the owner submits it, use ${payload.link?.handle} by reference.\n`);
    return 0;
  }
  const [action = "list", id = ""] = positionals(argv);
  if (subcommand === "links" && (action === "list" || action === "ls")) {
    const payload = await requestJson("/api/secret-links", ctx);
    write(payload, formatLinks(payload.links || []));
    return 0;
  }
  if (subcommand === "links" && action === "revoke" && id) {
    const payload = await requestJson(`/api/secret-links/${encodeURIComponent(id)}/revoke`, { ...ctx, method: "POST", body: {} });
    write(payload, `Revoked ${payload.link?.id || id} (${payload.link?.status || "revoked"})\n`);
    return 0;
  }
  throw new Error(SECRET_LINKS_USAGE);
}
