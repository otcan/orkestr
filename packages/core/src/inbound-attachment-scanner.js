import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function clean(value = "") {
  return String(value || "").trim();
}

export async function scanInboundAttachment(filePath, policy, injectedScanner) {
  // The current command adapter is retained solely for the isolated test
  // harness. Production must not inherit API-process privileges or environment
  // into a scanner until the external worker contract is implemented.
  if (!policy?.testIsolation) {
    return { approved: false, retryable: true, reason: "scanner_not_ready" };
  }
  if (typeof injectedScanner === "function") {
    const result = await injectedScanner({ filePath });
    if (result === true || result?.verdict === "clean" || result?.approved === true) return { approved: true };
    return { approved: false, retryable: result?.retryable === true, reason: clean(result?.reason) || "scanner_rejected" };
  }
  if (!policy.scanner) return { approved: false, retryable: true, reason: "scanner_not_ready" };
  const args = policy.scanner.args.map((argument) => argument.replaceAll("{file}", filePath));
  try {
    await execFileAsync(policy.scanner.command, args, {
      timeout: policy.scannerTimeoutMs,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    });
    return { approved: true };
  } catch (error) {
    if (Number(error?.code) === policy.scannerRejectExitCode) return { approved: false, retryable: false, reason: "scanner_rejected" };
    return { approved: false, retryable: true, reason: "scanner_unavailable" };
  }
}
