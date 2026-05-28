function safeDesktopSlug(value: string): string {
  return encodeURIComponent(String(value || "").trim());
}

export function isMobileDesktopRoute(rawUrl: string | undefined): { slug: string } | null {
  const parsed = new URL(String(rawUrl || "/"), "http://orkestr.local");
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts[0] !== "desktop" || !parts[1] || parts[2] !== "mobile") return null;
  const slug = decodeURIComponent(parts[1]);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(slug)) return null;
  return { slug };
}

export function serveMobileDesktopShell(response: any, slug: string): void {
  const encodedSlug = safeDesktopSlug(slug);
  response
    .status(200)
    .header("cache-control", "no-store")
    .type("text/html; charset=utf-8")
    .send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover">
  <title>Orkestr Mobile Desktop</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
    html, body { height: 100%; }
    body { margin: 0; overflow: hidden; background: #080b0f; color: #f8fafc; touch-action: none; }
    .shell { min-height: 100dvh; display: grid; grid-template-rows: auto 1fr auto; padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left); }
    header, footer { z-index: 3; display: flex; align-items: center; gap: 8px; padding: 8px; background: rgba(8, 11, 15, 0.92); border-color: rgba(148, 163, 184, 0.2); }
    header { border-bottom: 1px solid rgba(148, 163, 184, 0.2); }
    footer { border-top: 1px solid rgba(148, 163, 184, 0.2); overflow-x: auto; scrollbar-width: none; }
    footer::-webkit-scrollbar { display: none; }
    strong { font-size: 0.92rem; font-weight: 700; white-space: nowrap; }
    .status { min-width: 0; flex: 1; color: #9ca3af; font-size: 0.78rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .viewport { position: relative; min-width: 0; min-height: 0; background: #111827; overflow: hidden; }
    #screen { width: 100%; height: 100%; display: grid; place-items: center; overflow: hidden; background: #111827; }
    #screen canvas { outline: none; }
    #touchLayer { position: absolute; inset: 0; z-index: 2; display: none; cursor: none; touch-action: none; }
    .touchpad #touchLayer { display: block; }
    #cursorDot { position: absolute; width: 18px; height: 18px; margin: -9px 0 0 -9px; border: 2px solid #f8fafc; border-radius: 999px; background: rgba(34, 197, 94, 0.45); box-shadow: 0 0 0 2px rgba(0, 0, 0, 0.55); pointer-events: none; transform: translate(-80px, -80px); }
    button { border: 1px solid rgba(148, 163, 184, 0.28); border-radius: 7px; min-width: 42px; min-height: 38px; padding: 0 11px; color: #f8fafc; background: #18212d; font: inherit; font-size: 0.84rem; font-weight: 700; white-space: nowrap; }
    button.active { border-color: rgba(52, 211, 153, 0.78); background: #064e3b; color: #d1fae5; }
    button.danger { border-color: rgba(248, 113, 113, 0.5); color: #fecaca; }
    .hiddenInput { position: fixed; left: -1000px; top: 0; width: 1px; height: 1px; opacity: 0.01; }
  </style>
</head>
<body>
  <div class="shell touchpad" id="shell">
    <header>
      <strong>${encodedSlug}</strong>
      <span class="status" id="status">Connecting</span>
      <button type="button" id="reconnect">Reconnect</button>
    </header>
    <main class="viewport">
      <div id="screen"></div>
      <div id="touchLayer"><div id="cursorDot"></div></div>
    </main>
    <footer>
      <button type="button" class="active" id="touchpad">Touchpad</button>
      <button type="button" id="direct">Tap</button>
      <button type="button" class="active" id="fit">Fit</button>
      <button type="button" id="keyboard">Keyboard</button>
      <button type="button" id="paste">Paste</button>
      <button type="button" data-key="Enter">Enter</button>
      <button type="button" data-key="Tab">Tab</button>
      <button type="button" data-key="Escape">Esc</button>
      <button type="button" data-key="Backspace">Back</button>
      <button type="button" id="ctrlV">Ctrl+V</button>
      <button type="button" class="danger" id="disconnect">Close</button>
    </footer>
  </div>
  <textarea id="keyboardInput" class="hiddenInput" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false"></textarea>
  <script type="module">
    import RFB from "/desktop/${encodedSlug}/core/rfb.js";
    import KeyTable from "/desktop/${encodedSlug}/core/input/keysym.js";
    import keysyms from "/desktop/${encodedSlug}/core/input/keysymdef.js";

    const slug = ${JSON.stringify(slug)};
    const screen = document.getElementById("screen");
    const shell = document.getElementById("shell");
    const touchLayer = document.getElementById("touchLayer");
    const cursorDot = document.getElementById("cursorDot");
    const status = document.getElementById("status");
    const keyboardInput = document.getElementById("keyboardInput");
    const touchpadButton = document.getElementById("touchpad");
    const directButton = document.getElementById("direct");
    const fitButton = document.getElementById("fit");
    let rfb = null;
    let mode = "touchpad";
    let fit = true;
    let pointer = { x: 0, y: 0 };
    let activeTouch = null;
    let lastTouch = null;
    let lastTap = 0;
    let longPressTimer = null;

    function websocketUrl() {
      const scheme = location.protocol === "https:" ? "wss" : "ws";
      return scheme + "://" + location.host + "/desktop/" + encodeURIComponent(slug) + "/websockify";
    }

    function setStatus(value) {
      status.textContent = value;
    }

    function setMode(value) {
      mode = value;
      shell.classList.toggle("touchpad", mode === "touchpad");
      touchpadButton.classList.toggle("active", mode === "touchpad");
      directButton.classList.toggle("active", mode === "direct");
      if (rfb) rfb.dragViewport = mode !== "direct" && !fit;
      positionCursor(pointer.x, pointer.y);
    }

    function setFit(value) {
      fit = value;
      fitButton.classList.toggle("active", fit);
      fitButton.textContent = fit ? "Fit" : "1:1";
      if (!rfb) return;
      rfb.scaleViewport = fit;
      rfb.clipViewport = !fit;
      rfb.dragViewport = mode !== "direct" && !fit;
      requestAnimationFrame(centerPointer);
    }

    function connect() {
      if (rfb) rfb.disconnect();
      screen.replaceChildren();
      setStatus("Connecting");
      rfb = new RFB(screen, websocketUrl(), { shared: true });
      rfb.background = "#111827";
      rfb.focusOnClick = true;
      rfb.qualityLevel = 6;
      rfb.compressionLevel = 4;
      rfb.showDotCursor = true;
      rfb.addEventListener("connect", () => {
        setStatus("Connected");
        setFit(fit);
        centerPointer();
        rfb.focus();
      });
      rfb.addEventListener("disconnect", (event) => {
        setStatus(event.detail.clean ? "Disconnected" : "Connection lost");
      });
      rfb.addEventListener("credentialsrequired", () => setStatus("VNC password required"));
    }

    function canvas() {
      return screen.querySelector("canvas");
    }

    function centerPointer() {
      const rect = (canvas() || screen).getBoundingClientRect();
      pointer = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      positionCursor(pointer.x, pointer.y);
    }

    function clampPointer(x, y) {
      const rect = (canvas() || screen).getBoundingClientRect();
      return {
        x: Math.min(rect.right - 1, Math.max(rect.left + 1, x)),
        y: Math.min(rect.bottom - 1, Math.max(rect.top + 1, y)),
      };
    }

    function positionCursor(x, y) {
      const rect = touchLayer.getBoundingClientRect();
      cursorDot.style.transform = "translate(" + (x - rect.left) + "px, " + (y - rect.top) + "px)";
      cursorDot.style.display = mode === "touchpad" ? "block" : "none";
    }

    function dispatchMouse(type, x, y, button = 0, buttons = 0) {
      const target = canvas();
      if (!target) return;
      target.dispatchEvent(new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        button,
        buttons,
      }));
    }

    function click(button = 0) {
      const mask = button === 2 ? 2 : 1;
      dispatchMouse("mousemove", pointer.x, pointer.y);
      dispatchMouse("mousedown", pointer.x, pointer.y, button, mask);
      dispatchMouse("mouseup", pointer.x, pointer.y, button, 0);
    }

    function wheel(deltaX, deltaY) {
      const target = canvas();
      if (!target) return;
      target.dispatchEvent(new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        clientX: pointer.x,
        clientY: pointer.y,
        deltaX,
        deltaY,
        deltaMode: 0,
      }));
    }

    function sendKey(name) {
      if (!rfb) return;
      const keys = {
        Enter: [KeyTable.XK_Return, "Enter"],
        Tab: [KeyTable.XK_Tab, "Tab"],
        Escape: [KeyTable.XK_Escape, "Escape"],
        Backspace: [KeyTable.XK_BackSpace, "Backspace"],
      };
      const pair = keys[name];
      if (pair) rfb.sendKey(pair[0], pair[1]);
      rfb.focus();
    }

    function sendText(value) {
      if (!rfb || !value) return;
      for (const char of Array.from(value)) {
        if (char === "\\n") {
          sendKey("Enter");
        } else {
          rfb.sendKey(keysyms.lookup(char.codePointAt(0)), "");
        }
      }
    }

    function sendCtrlV() {
      if (!rfb) return;
      rfb.sendKey(KeyTable.XK_Control_L, "ControlLeft", true);
      rfb.sendKey(keysyms.lookup("v".codePointAt(0)), "KeyV");
      rfb.sendKey(KeyTable.XK_Control_L, "ControlLeft", false);
      rfb.focus();
    }

    touchLayer.addEventListener("touchstart", (event) => {
      if (mode !== "touchpad") return;
      event.preventDefault();
      if (event.touches.length === 2) {
        activeTouch = "scroll";
        lastTouch = { x: event.touches[0].clientX, y: event.touches[0].clientY };
        return;
      }
      const touch = event.changedTouches[0];
      activeTouch = touch.identifier;
      lastTouch = { x: touch.clientX, y: touch.clientY };
      clearTimeout(longPressTimer);
      longPressTimer = setTimeout(() => click(2), 750);
    }, { passive: false });

    touchLayer.addEventListener("touchmove", (event) => {
      if (mode !== "touchpad" || !lastTouch) return;
      event.preventDefault();
      if (activeTouch === "scroll" && event.touches.length >= 2) {
        const touch = event.touches[0];
        wheel((lastTouch.x - touch.clientX) * 2, (lastTouch.y - touch.clientY) * 2);
        lastTouch = { x: touch.clientX, y: touch.clientY };
        return;
      }
      const touch = Array.from(event.changedTouches).find((item) => item.identifier === activeTouch);
      if (!touch) return;
      const next = clampPointer(pointer.x + (touch.clientX - lastTouch.x), pointer.y + (touch.clientY - lastTouch.y));
      pointer = next;
      lastTouch = { x: touch.clientX, y: touch.clientY };
      clearTimeout(longPressTimer);
      positionCursor(pointer.x, pointer.y);
      dispatchMouse("mousemove", pointer.x, pointer.y);
    }, { passive: false });

    touchLayer.addEventListener("touchend", (event) => {
      if (mode !== "touchpad") return;
      event.preventDefault();
      clearTimeout(longPressTimer);
      const now = Date.now();
      const isTap = lastTouch && now - lastTap > 80;
      if (isTap && event.changedTouches.length === 1) click(0);
      lastTap = now;
      activeTouch = null;
      lastTouch = null;
    }, { passive: false });

    document.querySelectorAll("[data-key]").forEach((button) => {
      button.addEventListener("click", () => sendKey(button.dataset.key || ""));
    });
    document.getElementById("keyboard").addEventListener("click", () => {
      keyboardInput.value = "";
      keyboardInput.focus();
    });
    keyboardInput.addEventListener("beforeinput", (event) => {
      if (event.inputType === "deleteContentBackward") {
        event.preventDefault();
        sendKey("Backspace");
      }
    });
    keyboardInput.addEventListener("input", () => {
      sendText(keyboardInput.value);
      keyboardInput.value = "";
    });
    document.getElementById("paste").addEventListener("click", async () => {
      const text = await navigator.clipboard.readText().catch(() => "");
      if (!text || !rfb) return;
      rfb.clipboardPasteFrom(text);
      setTimeout(sendCtrlV, 120);
    });
    document.getElementById("ctrlV").addEventListener("click", sendCtrlV);
    document.getElementById("reconnect").addEventListener("click", connect);
    document.getElementById("disconnect").addEventListener("click", () => rfb?.disconnect());
    touchpadButton.addEventListener("click", () => setMode("touchpad"));
    directButton.addEventListener("click", () => setMode("direct"));
    fitButton.addEventListener("click", () => setFit(!fit));
    window.addEventListener("resize", () => requestAnimationFrame(centerPointer));
    connect();
  </script>
</body>
</html>`);
}
