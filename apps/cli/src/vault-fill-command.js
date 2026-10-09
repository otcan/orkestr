import { requestJson } from "./api-client.js";

// `orkestr vault fill <item> --desktop <slug> [--field username|password|both] [--submit]`
// Types a granted credential into the focused field of a managed desktop the
// calling thread holds the lease on. The value never reaches this process;
// the server reports only "filled" or "failed".

export const VAULT_FILL_USAGE = "  orkestr vault fill <item> --desktop <slug> [--field username|password|both] [--submit] [--json]";

const valueFlags = new Set(["--desktop", "--field", "--cwd"]);

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

export async function vaultFillCommand(argv, threadId, ctx, json, usage) {
  const item = firstPositional(argv);
  const desktop = flag(argv, "--desktop");
  const field = flag(argv, "--field") || "password";
  if (!item || !desktop || !["username", "password", "both"].includes(field)) throw new Error(usage);
  const payload = await requestJson("/api/vault/agent/fill", {
    ...ctx,
    method: "POST",
    body: { threadId, item, desktop, field, submit: argv.includes("--submit") },
  });
  const status = payload?.status === "filled" ? "filled" : "failed";
  ctx.stdout.write(json ? `${JSON.stringify({ status })}\n` : `${status}\n`);
  return status === "filled" ? 0 : 1;
}
