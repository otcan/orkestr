// Diagnostics only for the synthetic recycled-PID test. Never enumerate host
// processes or read provider output/prompts; inspect only its owned wrapper.
import fs from "node:fs";

function boundedText(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const bytes = Buffer.alloc(2048);
    return bytes.subarray(0, fs.readSync(fd, bytes, 0, bytes.length, 0)).toString("utf8");
  } catch (error) {
    return { error: error.code || error.name };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function size(file) {
  try { return fs.statSync(file).size; } catch (error) { return { error: error.code || error.name }; }
}

export function detachedSignalIdentity(record) {
  const result = {
    pid: record.pid, pgid: record.pgid, recordedStartTime: record.procStartTime,
    platform: process.platform, node: process.version,
    eventBytes: size(record.paths.events),
  };
  if (process.platform === "linux") {
    result.wrapperStat = boundedText(`/proc/${record.pid}/stat`);
    // Direct children only, no unrelated process traversal or signalling.
    result.children = boundedText(`/proc/${record.pid}/task/${record.pid}/children`);
  }
  return result;
}

export function detachedSignalFailure(record, beforeSignal, status) {
  return {
    beforeSignal, status, afterExit: detachedSignalIdentity(record),
    exit: boundedText(record.paths.exit),
    signals: boundedText(`${record.paths.exit}.signals`),
    stderrBytes: size(record.paths.stderr),
  };
}
