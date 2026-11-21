// One resolution for every CLI argument that names a thread.
//
// The thread picker (`orkestr attach` without a target) numbers the active
// thread list (`GET /api/threads/summary`); the server itself only matches an
// exact id, name or binding name. A thread argument may therefore be:
//   - the picker number ("132"), the same numbering `orkestr list --numbered` shows;
//   - an exact id, name or binding name (passed through, the server matches it);
//   - an unambiguous prefix of an id (4+ characters) or of a name.
// A number or prefix is replaced by the thread id, with a one-line note on
// stderr so a misread number is visible. Anything else is passed unchanged.
import { requestJson } from "./api-client.js";
import { threadName } from "./format.js";

const minimumIdPrefix = 4;

function clean(value) {
  return String(value ?? "").trim();
}

function names(thread) {
  return [thread.name, thread.bindingName, thread.title, thread.binding?.displayName, threadName(thread)].map(clean).filter(Boolean);
}

function label(thread, number) {
  return `${number ? `#${number} ` : ""}"${threadName(thread) || thread.id}" (${thread.id})`;
}

export function targetError(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

// Pure resolution against the picker's list. Returns { id, thread, how } or null.
export function matchThreadTarget(threads, value) {
  const text = clean(value);
  if (!text || !Array.isArray(threads) || !threads.length) return null;
  const exact = threads.find((thread) => clean(thread.id) === text) ||
    threads.find((thread) => names(thread).includes(text));
  if (/^[0-9]+$/.test(text)) {
    const number = Number.parseInt(text, 10);
    const numbered = number >= 1 && number <= threads.length ? threads[number - 1] : null;
    if (numbered && exact && exact !== numbered) {
      throw targetError("thread_target_ambiguous", `${text} is list number ${label(numbered, number)} and also the name of ${label(exact)}; pass the id`);
    }
    if (numbered) return { id: numbered.id, thread: numbered, how: "number", number };
  }
  if (exact) return { id: exact.id, thread: exact, how: "exact" };
  const lower = text.toLowerCase();
  const byId = text.length >= minimumIdPrefix ? threads.filter((thread) => clean(thread.id).toLowerCase().startsWith(lower)) : [];
  const byName = threads.filter((thread) => names(thread).some((name) => name.toLowerCase().startsWith(lower)));
  const candidates = [...new Set([...byId, ...byName])];
  if (candidates.length === 1) return { id: candidates[0].id, thread: candidates[0], how: "prefix" };
  if (candidates.length > 1) {
    const shown = candidates.slice(0, 5).map((thread) => label(thread, threads.indexOf(thread) + 1)).join(", ");
    throw targetError("thread_target_ambiguous", `"${text}" matches ${candidates.length} threads: ${shown}${candidates.length > 5 ? ", ..." : ""}`);
  }
  return null;
}

// Resolves one thread argument. A list number always goes through the
// picker's list; a prefix only when `prefixes` is set (after the exact
// argument was not found: the list is 1+ MB, an exact target never reads it).
// If the list cannot be read, the argument is passed on unchanged.
export async function resolveThreadTarget(value, ctx, { prefixes = true } = {}) {
  const text = clean(value);
  if (!text || (!prefixes && !/^[0-9]+$/.test(text))) return { value: text, thread: null };
  let threads;
  try {
    threads = (await requestJson("/api/threads/summary", ctx))?.threads || [];
  } catch {
    return { value: text, thread: null };
  }
  const match = matchThreadTarget(threads, text);
  if (!match) return { value: text, thread: null };
  if (match.how !== "exact") ctx.stderr?.write?.(`orkestr: ${text} = ${label(match.thread, match.how === "number" ? match.number : 0)}\n`);
  return { value: match.id, thread: match.thread };
}

// Which arguments of a command name a thread: positional slots (indexes into
// the command's positional values) and value flags.
export function threadTargetSlots(command, args) {
  const sub = clean(args[0]);
  switch (command) {
    case "attach":
    case "send":
    case "interrupt":
    case "wake":
    case "sleep":
    case "reset":
    case "hard-reset":
    case "hard_reset":
    case "safe-reset":
    case "safe_reset":
      return { positions: [0], flags: [] };
    case "switch":
      return { positions: args.includes("--self") ? [] : [0], flags: [] };
    case "watch":
    case "watches":
      if (["list", "ls", "read", "show"].includes(sub)) return { positions: [1], flags: ["--from"] };
      if (["cancel", "rm"].includes(sub)) return { positions: [], flags: ["--from"] };
      if (!sub || ["help", "--help"].includes(sub)) return { positions: [], flags: [] };
      return { positions: [0], flags: ["--from"] };
    case "thread":
      return sub === "mission" ? { positions: [2], flags: [] } : { positions: [], flags: [] };
    case "task-agent":
    case "task_agent":
      return ["spawn", "list"].includes(sub) ? { positions: [1], flags: [] } : { positions: [], flags: [] };
    case "worker":
      if (sub === "create") return { positions: [1], flags: [] };
      if (sub === "release-role") return { positions: [2], flags: [] };
      return { positions: [], flags: [] };
    case "api-session":
    case "api":
      return { positions: [], flags: ["--thread"] };
    default:
      return { positions: [], flags: [] };
  }
}

// Rewrites a command's thread arguments in place of the originals.
// `positionalIndexes(args)` maps positional values to their argv indexes.
export async function resolveThreadTargetArgs(command, args, ctx, positionalIndexes, { prefixes = true } = {}) {
  const slots = threadTargetSlots(command, args);
  const indexes = positionalIndexes(args);
  const at = [
    ...slots.positions.map((position) => indexes[position]).filter((index) => index !== undefined),
    ...slots.flags.map((flag) => args.indexOf(flag)).filter((index) => index >= 0 && index + 1 < args.length).map((index) => index + 1),
  ];
  if (!at.length) return args;
  const next = [...args];
  for (const index of at) next[index] = (await resolveThreadTarget(next[index], ctx, { prefixes })).value;
  return next;
}
