import { encryptVaultShare } from "../../../packages/core/src/vault-share-crypto.js";
import { requestJson } from "./api-client.js";

// `orkestr vault share <item>` (docs/vault-sharing.md). Reads the granted
// item's password, encrypts it here, and sends only the envelope to the
// server. The decryption key is appended to the printed link as a #fragment;
// it is never part of a request. The optional passphrase is read from a
// hidden prompt and must be told to the recipient separately.

export const VAULT_SHARE_USAGE = [
  "  orkestr vault share <item> [--ttl 1d] [--views 1] [--passphrase-prompt] [--label text] [--json]",
  "  orkestr vault receive <name> [--once] [--ttl 1d] [--label text] [--json]   (link for someone outside Orkestr)",
].join("\n");

function flag(argv, name) {
  const index = argv.indexOf(name);
  if (index >= 0) return String(argv[index + 1] ?? "");
  const inline = argv.find((item) => item.startsWith(`${name}=`));
  return inline ? inline.slice(name.length + 1) : "";
}

export async function vaultShareCommand(item, argv, threadId, ctx, credentials) {
  if (!item) throw new Error(`Usage:\n${VAULT_SHARE_USAGE}`);
  let passphrase = "";
  if (argv.includes("--passphrase-prompt")) {
    if (typeof ctx.readPassphrase !== "function") throw new Error("vault_share_passphrase_unavailable: run from an interactive TTY");
    passphrase = String(await ctx.readPassphrase() || "");
    if (passphrase.length < 8) throw new Error("vault_share_passphrase_too_short: use at least 8 characters");
  }
  const payload = await credentials(threadId, item, ["password"], ctx);
  const value = String(payload?.password || "");
  if (!value) throw new Error("vault_share_empty: the item has no password");
  const { envelope, key } = encryptVaultShare(value, { passphrase });
  const body = { envelope, name: item };
  for (const name of ["ttl", "views", "label"]) {
    const option = flag(argv, `--${name}`);
    if (option) body[name] = name === "views" ? Number(option) : option;
  }
  if (threadId) body.threadId = threadId;
  const created = await requestJson("/api/secret-links/e2e", { ...ctx, method: "POST", body });
  const url = `${created.url}#${key}`;
  if (argv.includes("--json")) ctx.stdout.write(`${JSON.stringify({ ok: true, link: created.link, url }, null, 2)}\n`);
  else ctx.stdout.write(`${url}\n${passphrase ? "Tell the recipient the passphrase through a different channel.\n" : ""}`);
  return 0;
}

/**
 * `orkestr vault receive <name>`: a public link where someone outside
 * Orkestr submits a password; it lands in the owner's Vault, granted to the
 * calling thread, and the thread gets a record-only note with the item id.
 */
export async function vaultReceiveCommand(name, argv, threadId, ctx) {
  if (!name) throw new Error(`Usage:\n${VAULT_SHARE_USAGE}`);
  const body = { name, once: argv.includes("--once") };
  for (const option of ["ttl", "label"]) {
    const value = flag(argv, `--${option}`);
    if (value) body[option] = value;
  }
  if (threadId) body.threadId = threadId;
  const created = await requestJson("/api/secret-links/e2e-request", { ...ctx, method: "POST", body });
  if (argv.includes("--json")) ctx.stdout.write(`${JSON.stringify({ ok: true, link: created.link, url: created.url }, null, 2)}\n`);
  else ctx.stdout.write(`${created.url}\nSend this link to the person who has the password. When they submit it, it appears in the Vault as "${name}" and this thread gets a note with the item id.\n`);
  return 0;
}
