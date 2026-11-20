// The native-attach hold: a root-written record the V2 server honours.
//
// `<hold_dir>/<conversation>.json` says "the owner's terminal holds this
// conversation's native session until expires_at_ms": while it is valid the
// server opens no window, joins none and starts no Deep run for the
// conversation; incoming work queues and runs on the same session after the
// record is removed or expires. The server only reads these records (custody:
// root-owned, not group/world writable, one link); the terminal renews it
// every RENEW_MS, so a dead terminal releases within TTL_MS.
// `<conversation>.ended.json` tells the first V2 run afterwards that the owner
// worked in the session from the terminal. Every hold is also appended to the
// audit log (start, end, native id, reason).
import fs from "node:fs";
import path from "node:path";

export const HOLD_FORMAT = "orkestr-native-attach-hold-v1";
export const ENDED_FORMAT = "orkestr-native-attach-ended-v1";
export const TTL_MS = 120_000;
export const RENEW_MS = 30_000;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function holdError(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

// Like the release-interruption records: root-owned, group-readable by the
// V2 runtime group (the server reads through it), never writable, one link.
function writeAtomic(file, value, { fsImpl = fs, gid = null } = {}) {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fsImpl.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  if (Number.isInteger(gid)) fsImpl.chownSync(temporary, 0, gid);
  fsImpl.chmodSync(temporary, Number.isInteger(gid) ? 0o440 : 0o400);
  fsImpl.renameSync(temporary, file);
}

export function holdPaths(dir, conversationId) {
  if (!uuidPattern.test(conversationId)) throw holdError("v2_native_hold_invalid", "conversation id is not a lowercase UUID");
  return { hold: path.join(dir, `${conversationId}.json`), ended: path.join(dir, `${conversationId}.ended.json`) };
}

export function readHold(dir, conversationId, { fsImpl = fs, now = Date.now() } = {}) {
  const { hold } = holdPaths(dir, conversationId);
  let value;
  try {
    value = JSON.parse(fsImpl.readFileSync(hold, "utf8"));
  } catch {
    return null;
  }
  if (value?.format !== HOLD_FORMAT || value.conversation_id !== conversationId) return null;
  const live = now < Math.min(Number(value.expires_at_ms), Number(value.renewed_at_ms) + 5 * 60_000);
  return { ...value, live };
}

function pidAlive(pid, kill = process.kill) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

// Creates the hold. Refuses when another live terminal holds it (unless
// takeover, which signals that terminal to hand back first).
export async function acquireHold({ dir, gid = null, native, conversationId, fsImpl = fs, now = Date.now, kill = process.kill, sleep, takeover = false, selfPid = process.pid }) {
  if (!fsImpl.existsSync(dir)) {
    fsImpl.mkdirSync(dir, { recursive: true, mode: 0o750 });
    if (Number.isInteger(gid)) fsImpl.chownSync(dir, 0, gid);
  }
  const existing = readHold(dir, conversationId, { fsImpl, now: now() });
  if (existing?.live && existing.holder_pid !== selfPid && pidAlive(existing.holder_pid, kill)) {
    if (!takeover) {
      throw holdError("v2_native_attached_elsewhere", `this chat's ${existing.provider} session is already open in another terminal (pid ${existing.holder_pid}, since ${new Date(existing.acquired_at_ms).toISOString()}); rerun with --takeover to close it there`);
    }
    try {
      kill(existing.holder_pid, "SIGTERM");
    } catch {}
    const deadline = now() + 10_000;
    while (now() < deadline && pidAlive(existing.holder_pid, kill)) await sleep(200);
    if (pidAlive(existing.holder_pid, kill)) throw holdError("v2_native_takeover_failed", `pid ${existing.holder_pid} did not hand back`);
  }
  const at = now();
  const record = {
    format: HOLD_FORMAT,
    conversation_id: conversationId,
    session_id: native.sessionId,
    native_session_id: native.nativeSessionId,
    provider: native.provider,
    binding_generation: native.generation,
    holder_pid: selfPid,
    acquired_at_ms: at,
    renewed_at_ms: at,
    expires_at_ms: at + TTL_MS,
  };
  writeAtomic(holdPaths(dir, conversationId).hold, record, { fsImpl, gid });
  return record;
}

export function renewHold(dir, record, { fsImpl = fs, now = Date.now, gid = null } = {}) {
  const current = readHold(dir, record.conversation_id, { fsImpl, now: now() });
  // Someone else's record (a takeover) or none: this terminal lost the hold.
  if (!current || current.holder_pid !== record.holder_pid || current.acquired_at_ms !== record.acquired_at_ms) return false;
  const at = now();
  Object.assign(record, { renewed_at_ms: at, expires_at_ms: at + TTL_MS });
  writeAtomic(holdPaths(dir, record.conversation_id).hold, record, { fsImpl, gid });
  return true;
}

// Hands back: the ended record for V2's next run, the audit line, then the
// hold itself is removed (only if it is still this terminal's).
// `opened` false (nothing was opened, e.g. V2 never became idle): no ended
// record, so V2's next run is not told about a session that never happened.
export function releaseHold(dir, record, { fsImpl = fs, now = Date.now, gid = null, auditLog = "", reason = "exited", extra = {}, opened = true } = {}) {
  const at = now();
  const paths = holdPaths(dir, record.conversation_id);
  const ended = {
    format: ENDED_FORMAT,
    conversation_id: record.conversation_id,
    native_session_id: record.native_session_id,
    started_at_ms: record.acquired_at_ms,
    ended_at_ms: at,
    reason,
  };
  if (opened) {
    try {
      writeAtomic(paths.ended, ended, { fsImpl, gid });
    } catch {}
  }
  if (auditLog) {
    try {
      fsImpl.appendFileSync(auditLog, `${JSON.stringify({ ...ended, opened, provider: record.provider, session_id: record.session_id, holder_pid: record.holder_pid, ...extra })}\n`, { mode: 0o600 });
    } catch {}
  }
  const current = readHold(dir, record.conversation_id, { fsImpl, now: at });
  if (current && current.holder_pid === record.holder_pid && current.acquired_at_ms === record.acquired_at_ms) {
    try {
      fsImpl.unlinkSync(paths.hold);
    } catch {}
  }
  return ended;
}
