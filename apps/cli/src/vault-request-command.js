import { requestJson } from "./api-client.js";

// `orkestr vault request <name> [--once] [--ttl 15m] [--thread <id>]
// [--username-too] [--label text] [--json]` (docs/vault.md). Prints a
// one-time link for the owner; the submitted password becomes a Vault item
// granted to this thread. No value ever passes through this command.

const valueFlags = new Set(["--ttl", "--thread", "--label", "--cwd"]);

function flag(argv, name) {
  const index = argv.indexOf(name);
  if (index >= 0) return String(argv[index + 1] ?? "");
  const inline = argv.find((item) => item.startsWith(`${name}=`));
  return inline ? inline.slice(name.length + 1) : "";
}

function firstPositional(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    if (valueFlags.has(argv[index])) index += 1;
    else if (!argv[index].startsWith("--")) return argv[index];
  }
  return "";
}

export async function vaultRequestCommand(argv, threadId, ctx, json, usage) {
  const name = firstPositional(argv);
  if (!name) throw new Error(usage);
  const body = {
    threadId: flag(argv, "--thread") || threadId,
    name,
    ttl: flag(argv, "--ttl"),
    label: flag(argv, "--label"),
    once: argv.includes("--once"),
    usernameToo: argv.includes("--username-too"),
  };
  const payload = await requestJson("/api/vault/agent/requests", { ...ctx, method: "POST", body });
  if (json) {
    ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return 0;
  }
  ctx.stdout.write(`${payload?.url || ""}\n`);
  ctx.stderr.write(`Send this one-time link to the owner (expires ${payload?.request?.expiresAt}). After they submit, "${name}" is granted to this thread; use \`orkestr vault exec\`.\n`);
  return 0;
}
