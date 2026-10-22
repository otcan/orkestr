// One-time first-run handoff from the desktop app. The app injects the
// owner-setup token into its own webview before the page loads, so the token
// never appears in a URL, browser history or a server log. Ordinary browsers
// have no handoff and keep the manual "First-time setup" form.
export const HANDOFF = "__ORKESTR_LOCAL_SETUP__";

export function takeLocalSetup(scope) {
    const handoff = scope[HANDOFF];
    try { delete scope[HANDOFF]; } catch { scope[HANDOFF] = undefined; }
    const token = handoff?.bootstrap;
    if (typeof token !== "string" || token.length < 32 || token.length > 256) return null;
    return /^[A-Za-z0-9_-]+$/.test(token) ? token : null;
}
