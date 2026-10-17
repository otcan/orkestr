import { requestWhatsAppWorker } from "./whatsapp-worker-client.js";
import { getLocalWhatsAppQrSvg, localWhatsAppBridgeBasePath, logoutLocalWhatsAppAccount, startLocalWhatsAppAccount } from "./whatsapp-local-bridge.js";

// The UI owns account authorization; lifecycle operations must reach the same
// runtime that supplied its status, never create a second local browser.
export async function runWhatsAppAccountLifecycle(status, accountId, action, options = {}, env = process.env) {
  if (status.mode === "worker") {
    const id = encodeURIComponent(accountId);
    if (action === "qr") {
      return requestWhatsAppWorker(`/qr.svg?accountId=${id}`, { responseType: "text" }, env)
        .catch(error => { if (error.statusCode === 404) return ""; throw error; });
    }
    const endpoint = action === "logout" ? "logout" : "start";
    const result = await requestWhatsAppWorker(`/accounts/${id}/${endpoint}`, {
      method: "POST", body: { ...options, resetRuntime: action === "reconnect" },
    }, env);
    return result.account;
  }
  if (status.mode !== "local" && status.bridgeUrl !== localWhatsAppBridgeBasePath) {
    throw Object.assign(new Error("wa_account_operation_not_supported_for_external_bridge"), { statusCode: 400 });
  }
  if (action === "qr") return getLocalWhatsAppQrSvg(accountId, env);
  if (action === "logout") return logoutLocalWhatsAppAccount(accountId, env);
  return startLocalWhatsAppAccount(accountId, env, { ...options, resetRuntime: action === "reconnect" });
}
