/**
 * Cancel a pending JavaScript dialog without accepting a destructive navigation
 * or supplying prompt text. The caller must already hold its managed desktop
 * lease and select one explicit page target before calling this function.
 *
 * This deliberately needs no Runtime.evaluate or Page.enable: those calls can
 * remain blocked behind an already-open beforeunload dialog.
 */
export async function cancelPageDialog(send) {
  if (typeof send !== "function") throw new TypeError("dialog_send_required");
  try {
    await send("Page.handleJavaScriptDialog", { accept: false });
    return { cancelled: true };
  } catch (error) {
    // CDP error text is deliberately not returned: it can contain page data.
    if (error?.code === -32602 && /no dialog is showing/i.test(error.message || "")) {
      return { cancelled: false, reason: "no_dialog" };
    }
    throw error;
  }
}
