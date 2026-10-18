import { StringDecoder } from "node:string_decoder";

// Inspect bounded diagnostics in memory; never retain or publish source paths,
// commit messages, detection context or raw scanner output.
export function coverageTracker() {
  const decoder = new StringDecoder("utf8");
  let pending = "", commits = null, bytes = null, errorReported = false, duplicate = false;
  const line = raw => {
    const text = raw.replace(/\x1b\[[0-9;]*m/g, "");
    if (/^\S+\s+ERR(?:\s|$)/.test(text)) errorReported = true;
    const count = text.match(/^\S+\s+INF (\d+) commits scanned\.$/);
    const size = text.match(/^\S+\s+INF scanned ~(\d+) bytes(?:[ (]|$)/);
    if (count) {
      duplicate ||= commits !== null;
      commits = Number(count[1]);
    }
    if (size) {
      duplicate ||= bytes !== null;
      bytes = Number(size[1]);
    }
  };
  return {
    write(chunk) {
      pending += decoder.write(chunk);
      let end;
      while ((end = pending.indexOf("\n")) !== -1) {
        if (end > 16384) throw new Error("scanner_output_limit");
        line(pending.slice(0, end).replace(/\r$/, ""));
        pending = pending.slice(end + 1);
      }
      if (pending.length > 16384) throw new Error("scanner_output_limit");
    },
    finish() {
      pending += decoder.end();
      if (pending) line(pending);
      pending = "";
      return { reportedCommits: commits, reportedBytes: bytes, errorReported,
        summaryValid: !duplicate && Number.isSafeInteger(commits) && commits >= 0
          && Number.isSafeInteger(bytes) && bytes >= 0 };
    },
  };
}

export function requireCoverage(scope, coverage) {
  if (!coverage?.summaryValid || !Number.isSafeInteger(scope.scannableAddedLines))
    throw new Error("scanner_coverage_unproven");
  if (coverage.errorReported) throw new Error("scanner_reported_error");
  if (scope.scannableAddedLines > 0 && (!coverage.reportedCommits || !coverage.reportedBytes))
    throw new Error("scanner_zero_coverage");
}
