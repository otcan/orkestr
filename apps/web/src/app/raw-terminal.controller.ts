import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";

type RawState = "idle" | "connecting" | "connected" | "disconnected" | "error";

interface RawTerminalControllerOptions {
  host: () => HTMLElement | null;
  isActive: () => boolean;
  onStatus?: (state: RawState, detail: string) => void;
}

export class RawTerminalController {
  private socket?: WebSocket;
  private socketThreadId = "";
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private inputReadyTimer?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private inputReady = false;
  private terminal?: Terminal;
  private fitAddon?: FitAddon;
  private resizeObserver?: ResizeObserver;

  constructor(private readonly options: RawTerminalControllerOptions) {}

  open(threadId: string, attempt = 0): void {
    if (!this.options.isActive()) return;
    if (!this.options.host()) {
      if (attempt < 20) setTimeout(() => this.open(threadId, attempt + 1), 50);
      return;
    }
    if (!this.ensureTerminal()) return;
    if (this.socket && this.socketThreadId === threadId && this.socket.readyState <= WebSocket.OPEN) {
      this.focus();
      return;
    }

    this.close(false);
    this.socketThreadId = threadId;
    this.inputReady = false;
    this.setStatus("connecting", "");
    this.terminal?.reset();
    this.terminal?.writeln("Connecting...");
    this.fit();

    const generation = ++this.generation;
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    const url = new URL(`${protocol}://${location.host}/api/threads/${encodeURIComponent(threadId)}/stream`);
    if (this.terminal) {
      url.searchParams.set("cols", String(this.terminal.cols));
      url.searchParams.set("rows", String(this.terminal.rows));
    }

    const socket = new WebSocket(url.toString());
    this.socket = socket;
    socket.addEventListener("open", () => {
      this.setStatus("connected", "");
      this.armInputReadyWatchdog(threadId, generation);
      this.scheduleFits(true);
      this.focus();
    });
    socket.addEventListener("message", (event) => {
      this.handlePayload(JSON.parse(String(event.data || "{}")));
    });
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.inputReady = false;
      this.socket = undefined;
      this.setStatus("disconnected", "");
      this.scheduleReconnect(threadId, generation);
    });
    socket.addEventListener("error", () => {
      if (this.socket !== socket) return;
      this.inputReady = false;
      this.setStatus("disconnected", "");
    });
  }

  close(clearTerminal = true): void {
    this.clearTimers();
    this.generation += 1;
    if (this.socket) {
      this.socket.close();
      this.socket = undefined;
    }
    this.socketThreadId = "";
    this.inputReady = false;
    this.setStatus("idle", "");
    if (clearTerminal) this.disposeTerminal();
  }

  dispose(): void {
    this.close(true);
  }

  focus(): void {
    this.terminal?.focus();
    this.fit();
  }

  reconnect(threadId: string): void {
    this.close(false);
    this.open(threadId);
  }

  private ensureTerminal(): boolean {
    const host = this.options.host();
    if (!host) return false;
    if (!this.terminal) {
      this.terminal = new Terminal({
        convertEol: true,
        cursorBlink: true,
        cursorStyle: "block",
        fontFamily: '"IBM Plex Mono", "JetBrains Mono", "SFMono-Regular", Consolas, monospace',
        fontSize: 13,
        scrollback: 100000,
        theme: {
          background: "#020602",
          foreground: "#d9fbd8",
          cursor: "#b6ff63",
          selectionBackground: "rgba(126, 255, 142, 0.28)",
        },
      });
      this.fitAddon = new FitAddon();
      this.terminal.loadAddon(this.fitAddon);
      this.terminal.loadAddon(new WebLinksAddon());
      this.terminal.open(host);
      this.terminal.onData((data) => {
        if (this.inputReady) this.sendInput(data);
      });
    }
    this.observeHost(host);
    this.scheduleFits(true);
    return true;
  }

  private observeHost(host: HTMLElement): void {
    if (this.resizeObserver) return;
    this.resizeObserver = new ResizeObserver(() => this.fit(true));
    this.resizeObserver.observe(host);
  }

  private disposeTerminal(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
    this.terminal?.dispose();
    this.terminal = undefined;
    this.fitAddon = undefined;
  }

  private fit(sendResize = false): void {
    if (!this.terminal || !this.fitAddon) return;
    try {
      this.fitAddon.fit();
      if (sendResize && this.socket?.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify({ type: "resize", cols: this.terminal.cols, rows: this.terminal.rows }));
      }
    } catch {
      // Angular can detach the host briefly while switching panels.
    }
  }

  private scheduleFits(sendResize = false): void {
    this.fit(sendResize);
    requestAnimationFrame(() => this.fit(sendResize));
    setTimeout(() => this.fit(sendResize), 80);
    setTimeout(() => this.fit(sendResize), 240);
  }

  private handlePayload(payload: Record<string, unknown>): void {
    const type = String(payload["type"] || "");
    if (type === "input_ready") {
      this.inputReady = true;
      if (this.inputReadyTimer) {
        clearTimeout(this.inputReadyTimer);
        this.inputReadyTimer = undefined;
      }
      return;
    }
    if (type === "heartbeat" && payload["sessionAlive"] === false && this.socketThreadId) {
      this.scheduleReconnect(this.socketThreadId, this.generation);
      return;
    }
    if (type === "visible_screen") {
      this.terminal?.reset();
      this.terminal?.write(this.normalizeSnapshot(payload["data"]));
      this.setStatus("connected", "");
      return;
    }
    if (type === "output") {
      this.terminal?.write(String(payload["data"] || ""));
      return;
    }
    if (type === "transport_ready") {
      this.setStatus("connected", "");
      return;
    }
    if (type === "error") {
      this.setStatus("error", "");
      this.terminal?.writeln("");
      this.terminal?.writeln(String(payload["data"] || "terminal error"));
    }
  }

  private sendInput(data: string): void {
    if (!data || this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({ type: "input", data }));
  }

  private normalizeSnapshot(data: unknown): string {
    return String(data || "").replace(/\r?\n/g, "\r\n");
  }

  private armInputReadyWatchdog(threadId: string, generation: number): void {
    if (this.inputReadyTimer) clearTimeout(this.inputReadyTimer);
    this.inputReadyTimer = setTimeout(() => {
      if (!this.options.isActive() || this.socketThreadId !== threadId || this.generation !== generation || this.inputReady) {
        return;
      }
      this.socket?.close();
      this.socket = undefined;
      this.open(threadId);
    }, 7000);
  }

  private scheduleReconnect(threadId: string, generation: number): void {
    if (this.reconnectTimer || !this.options.isActive() || this.socketThreadId !== threadId) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.options.isActive() && this.socketThreadId === threadId && this.generation === generation) this.open(threadId);
    }, 1500);
  }

  private clearTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.inputReadyTimer) {
      clearTimeout(this.inputReadyTimer);
      this.inputReadyTimer = undefined;
    }
  }

  private setStatus(state: RawState, detail: string): void {
    this.options.onStatus?.(state, detail);
  }
}
