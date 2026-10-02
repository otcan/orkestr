// `orkestr watch`: subscribe the calling thread to another thread's finished
// turns. Orkestr delivers the result into the watcher thread (see
// packages/core/src/thread-watch-pump.js).
import { requestJson } from "./api-client.js";
import { resolveCallingThreadId } from "./update-detach.js";

const valueFlags = new Set(["--from", "--thread", "--thread-id", "--on", "--payload", "--reply", "--match", "--expires", "--message", "--mode"]);

export const watchUsage = [
  "  orkestr watch <thread> [--once|--continuous] [--on final,failed|any] [--payload full|summary|none] [--reply chat|internal] [--no-wake] [--match <regex>] [--expires 7d] [--from <thread>] [--json]",
  "  orkestr watch list [<thread>] [--all] [--json]",
  "  orkestr watch cancel <watch-id> [--from <thread>] [--json]",
  "  orkestr watch read <thread> [--message <id>] [--json]",
];

function flagValue(argv, flag) {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] || "" : "";
}

function positional(argv) {
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (valueFlags.has(argv[index])) { index += 1; continue; }
    if (!argv[index].startsWith("--")) values.push(argv[index]);
  }
  return values;
}

async function callingThread(argv, ctx) {
  const id = flagValue(argv, "--from") || await resolveCallingThreadId({
    argv, env: ctx.env || process.env, cwd: ctx.cwd || process.cwd(), flagValue,
    requestJson: (path, options) => requestJson(path, { ...ctx, ...options }),
  });
  if (!id) throw new Error("Cannot tell which thread is watching. Run this inside an Orkestr thread or pass --from <thread>.");
  return id;
}

function write(ctx, json, payload, text) {
  ctx.stdout.write(json ? `${JSON.stringify(payload, null, 2)}\n` : `${text}\n`);
  return 0;
}

function describe(watch) {
  const what = [watch.mode, `on=${(watch.on || []).join(",")}`, `payload=${watch.payload}`, watch.wake ? `reply=${watch.reply}` : "no-wake"];
  if (watch.match) what.push(`match=/${watch.match}/`);
  if (watch.auto) what.push(`auto=${watch.auto}`);
  return `${watch.id} ${watch.watcherThreadId} <- ${watch.targetThreadId} ${what.join(" ")} status=${watch.status} fired=${watch.fireCount || 0} expires=${watch.expiresAt}`;
}

async function createWatch(argv, ctx, json) {
  const target = positional(argv)[0];
  if (!target) throw new Error(`Usage:\n${watchUsage[0]}`);
  const watcher = await callingThread(argv, ctx);
  const body = {
    target,
    mode: argv.includes("--continuous") ? "continuous" : flagValue(argv, "--mode") || "once",
    on: flagValue(argv, "--on") || undefined,
    payload: flagValue(argv, "--payload") || undefined,
    reply: flagValue(argv, "--reply") || undefined,
    wake: !argv.includes("--no-wake"),
    match: flagValue(argv, "--match") || undefined,
    expires: flagValue(argv, "--expires") || undefined,
  };
  const payload = await requestJson(`/api/threads/${encodeURIComponent(watcher)}/watches`, { ...ctx, method: "POST", body });
  return write(ctx, json, payload, `Watching: ${describe(payload.watch)}`);
}

async function listWatches(argv, ctx, json) {
  const thread = positional(argv)[0] || await callingThread(argv, ctx);
  const query = argv.includes("--all") ? "?all=1" : "";
  const payload = await requestJson(`/api/threads/${encodeURIComponent(thread)}/watches${query}`, ctx);
  const watches = payload.watches || [];
  return write(ctx, json, payload, watches.length ? watches.map(describe).join("\n") : "No thread watches.");
}

async function cancelWatch(argv, ctx, json) {
  const watchId = positional(argv)[0];
  if (!watchId) throw new Error(`Usage:\n${watchUsage[2]}`);
  const thread = await callingThread(argv, ctx);
  const payload = await requestJson(`/api/threads/${encodeURIComponent(thread)}/watches/${encodeURIComponent(watchId)}`, { ...ctx, method: "DELETE" });
  return write(ctx, json, payload, `Cancelled ${payload.watch?.id || watchId} (${payload.watch?.status || "cancelled"})`);
}

async function readWatchedMessage(argv, ctx, json) {
  const thread = positional(argv)[0];
  if (!thread) throw new Error(`Usage:\n${watchUsage[3]}`);
  const messageId = flagValue(argv, "--message");
  const query = messageId ? `?messageId=${encodeURIComponent(messageId)}` : "";
  const payload = await requestJson(`/api/threads/${encodeURIComponent(thread)}/watch-message${query}`, ctx);
  const message = payload.message || {};
  return write(ctx, json, payload, `[${message.phase || message.role} ${message.createdAt || ""} ${message.id || ""}]\n${message.text || ""}`);
}

export async function watchCommand(argv, ctx) {
  const json = argv.includes("--json");
  const sub = argv[0];
  if (!sub || sub === "help" || sub === "--help") {
    ctx.stdout.write(`Usage:\n${watchUsage.join("\n")}\n`);
    return sub ? 0 : 1;
  }
  if (sub === "list" || sub === "ls") return listWatches(argv.slice(1), ctx, json);
  if (sub === "cancel" || sub === "rm") return cancelWatch(argv.slice(1), ctx, json);
  if (sub === "read" || sub === "show") return readWatchedMessage(argv.slice(1), ctx, json);
  return createWatch(argv, ctx, json);
}
