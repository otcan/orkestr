// Reconnect backoff: resolves after the wait, or as soon as the tab is shown,
// the window regains focus, the network returns or the owner presses Retry.
const wait = __WAIT_MS__;
await new Promise(resolve => {
    let timer;
    const done = () => {
        clearTimeout(timer);
        document.removeEventListener("visibilitychange", visible);
        window.removeEventListener("focus", done);
        window.removeEventListener("online", done);
        window.removeEventListener("orkestr-stream-retry", done);
        resolve();
    };
    const visible = () => { if (document.visibilityState === "visible") done(); };
    timer = setTimeout(done, Math.round(wait * (0.8 + Math.random() * 0.4)));
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("focus", done);
    window.addEventListener("online", done);
    window.addEventListener("orkestr-stream-retry", done);
});
return null;
