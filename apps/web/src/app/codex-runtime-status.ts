import type { ConnectorStatus } from "./api.service";

// Codex runtime status helpers shared by the setup page, the first-run wizard
// and the Codex sign-in panel. No Angular imports, so tests can load it directly.

export function codexUnavailableReason(connector: ConnectorStatus | null | undefined): string {
  const reason = String(connector?.details?.["reason"] || "").toLowerCase();
  if (reason === "codex_disabled_on_macos" || reason === "codex_missing") return reason;
  if (String(connector?.state || "").toLowerCase() === "not_connected" && reason.includes("disabled")) return "codex_disabled_on_macos";
  return "";
}

export function codexCommandAvailable(connector: ConnectorStatus | null | undefined): boolean {
  if (!connector) return false;
  const details = connector.details || {};
  if (details["disabled"] === true) return false;
  if (codexUnavailableReason(connector)) return false;
  const detail = (key: string) => (details[key] === null || details[key] === undefined ? "" : String(details[key]));
  return Boolean(detail("command") || detail("version") || connector.state === "connected" || connector.state === "partial");
}

export function codexCommandUnavailableHint(connector: ConnectorStatus | null | undefined): string {
  if (codexCommandAvailable(connector)) return "";
  const summary = String(connector?.summary || "").trim();
  const reason = codexUnavailableReason(connector);
  if (reason === "codex_disabled_on_macos") {
    return summary || "Codex host binary is disabled for this macOS local install. Verify Codex manually, then rerun the installer with ORKESTR_ENABLE_HOST_CODEX=1.";
  }
  if (reason === "codex_missing") {
    return summary || "Codex Agent runtime is missing. Install Codex in the Orkestr runtime, then refresh this page.";
  }
  return summary || "Codex command is not available yet. Refresh after the runtime is installed.";
}

export function codexStateLabel(connector: ConnectorStatus | null | undefined): string {
  const state = String(connector?.state || "checking").toLowerCase();
  const reason = String(connector?.details?.["reason"] || "").toLowerCase();
  if (state === "connected") return "connected";
  if (state === "partial") return "sign-in required";
  if (state === "not_connected" && reason === "codex_missing") return "runtime missing";
  if (state === "not_connected" && reason.includes("disabled")) return "disabled";
  if (state === "not_connected") return "runtime unavailable";
  return state.replace(/_/g, " ");
}
