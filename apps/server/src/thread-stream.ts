import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Server } from "node:http";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { approvePairingChallenge, authorizeHttpRequest } from "../../../packages/core/src/security.js";
import { runtimeStatus, wakeThread } from "../../../packages/core/src/runtime-leases.js";
import { getThreadForPrincipal } from "../../../packages/core/src/threads.js";
import { isAdminPrincipal } from "../../../packages/core/src/policy.js";
import { codexThreadId, threadUsesCodexAppServer } from "../../../packages/core/src/codex-app-server-common.js";
import { recordCodexRuntimeAuthInvalidSignal } from "../../../packages/core/src/codex-auth-health.js";
import { codexResumeCommand } from "../../../packages/core/src/codex-attach-command.js";
import { shellQuote } from "../../../packages/core/src/native-terminal.js";
import { paneProgressFromText } from "../../../packages/core/src/pane-progress.js";
import { rawControlCommandMayMatch, rawSecurityApproveChallengeId } from "../../../packages/core/src/raw-terminal-commands.js";
import { killTmuxSession } from "../../../packages/core/src/tmux-runtime.js";
import { threadSummaryPayload } from "./thread-summary.js";

const execFileAsync = promisify(execFile);
const attachedServers = new WeakSet<Server>();
const browserAttachSessions = new Map<string, { clients: number; killTimer: NodeJS.Timeout | null }>();

type SummaryClient = {
  principal: Record<string, unknown>;
  lastSummaryBody: string;
};

function wsSend(ws: WebSocket, payload: Record<string, unknown>): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

async function capturePane(paneId: string, lines = 240): Promise<string> {
  const { stdout } = await execFileAsync("tmux", [
    "capture-pane",
    "-t",
    paneId,
    "-p",
    "-S",
    `-${Math.max(40, lines)}`,
  ]);
  return String(stdout || "").replace(/\s+$/g, "");
}

async function tmuxSendLiteral(paneId: string, text: string): Promise<void> {
  if (!text) return;
  await execFileAsync("tmux", ["send-keys", "-t", paneId, "-l", text]);
}

async function tmuxSendKey(paneId: string, key: string): Promise<void> {
  await execFileAsync("tmux", ["send-keys", "-t", paneId, key]);
}

const RAW_ESCAPE_KEY_MAP: Record<string, string | null> = {
  "\x1b[A": "Up",
  "\x1b[B": "Down",
  "\x1b[C": "Right",
  "\x1b[D": "Left",
  "\x1b[H": "Home",
  "\x1b[F": "End",
  "\x1bOA": "Up",
  "\x1bOB": "Down",
  "\x1bOC": "Right",
  "\x1bOD": "Left",
  "\x1bOH": "Home",
  "\x1bOF": "End",
  "\x1b[Z": "BTab",
  "\x1b[1~": "Home",
  "\x1b[2~": "IC",
  "\x1b[3~": "DC",
  "\x1b[4~": "End",
  "\x1b[5~": "PPage",
  "\x1b[6~": "NPage",
  "\x1b[7~": "Home",
  "\x1b[8~": "End",
  "\x1b[200~": null,
  "\x1b[201~": null,
};

function readRawEscapeSequence(data: string, index: number): string | null {
  if (data[index] !== "\x1b") return null;
  const prefix = data.slice(index);
  if (prefix.startsWith("\x1b[")) {
    const match = prefix.match(/^\x1b\[[0-9;?]*[@-~]/);
    return match?.[0] || "\x1b";
  }
  if (prefix.startsWith("\x1bO") && prefix.length >= 3) return prefix.slice(0, 3);
  return "\x1b";
}

function rawEscapeSequenceKey(sequence: string): string | null | undefined {
  const mapped = RAW_ESCAPE_KEY_MAP[sequence];
  if (mapped !== undefined) return mapped;
  const csi = sequence.match(/^\x1b\[([0-9;?]*)([A-Za-z~])$/);
  if (!csi) return undefined;
  const params = csi[1].replace(/^\?/, "").split(";")[0];
  const final = csi[2];
  if (final === "A") return "Up";
  if (final === "B") return "Down";
  if (final === "C") return "Right";
  if (final === "D") return "Left";
  if (final === "H") return "Home";
  if (final === "F") return "End";
  if (final === "Z") return "BTab";
  if (final !== "~") return undefined;
  if (params === "1" || params === "7") return "Home";
  if (params === "2") return "IC";
  if (params === "3") return "DC";
  if (params === "4" || params === "8") return "End";
  if (params === "5") return "PPage";
  if (params === "6") return "NPage";
  if (params === "200" || params === "201") return null;
  return undefined;
}

async function resizePane(paneId: string, cols: unknown, rows: unknown): Promise<void> {
  const parsedWidth = Number(cols);
  const parsedHeight = Number(rows);
  if (!Number.isFinite(parsedWidth) || !Number.isFinite(parsedHeight)) return;
  const width = Math.max(40, Math.min(400, Math.floor(parsedWidth)));
  const height = Math.max(8, Math.min(120, Math.floor(parsedHeight)));
  await execFileAsync("tmux", ["resize-pane", "-t", paneId, "-x", String(width), "-y", String(height)]);
}

function safeTmuxName(value: unknown): string {
  return String(value || "thread").replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "thread";
}

function browserAttachSessionName(threadId: string): string {
  return `orkestr-browser-attach-${safeTmuxName(threadId).slice(0, 42)}`;
}

async function tmuxHasSession(sessionName: string): Promise<boolean> {
  try {
    await execFileAsync("tmux", ["has-session", "-t", sessionName]);
    return true;
  } catch {
    return false;
  }
}

async function tmuxPaneId(sessionName: string): Promise<string> {
  const { stdout } = await execFileAsync("tmux", ["list-panes", "-t", sessionName, "-F", "#{pane_id}"]);
  return String(stdout || "").trim().split(/\s+/).filter(Boolean)[0] || "";
}

function rawAttachIdleTtlMs(): number {
  const parsed = Number(process.env.ORKESTR_RAW_ATTACH_IDLE_TTL_MS || 30_000);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 30_000;
}

function cancelBrowserAttachKill(sessionName: string): void {
  const state = browserAttachSessions.get(sessionName);
  if (!state?.killTimer) return;
  clearTimeout(state.killTimer);
  state.killTimer = null;
}

function retainBrowserAttachSession(sessionName: string): void {
  if (!sessionName) return;
  const state = browserAttachSessions.get(sessionName) || { clients: 0, killTimer: null };
  if (state.killTimer) {
    clearTimeout(state.killTimer);
    state.killTimer = null;
  }
  state.clients += 1;
  browserAttachSessions.set(sessionName, state);
}

function releaseBrowserAttachSession(sessionName: string): void {
  if (!sessionName) return;
  const state = browserAttachSessions.get(sessionName);
  if (!state) return;
  state.clients = Math.max(0, state.clients - 1);
  if (state.clients > 0 || state.killTimer) return;
  const killSession = async () => {
    const current = browserAttachSessions.get(sessionName);
    if (!current || current.clients > 0) return;
    browserAttachSessions.delete(sessionName);
    await killTmuxSession(sessionName).catch(() => undefined);
  };
  const ttlMs = rawAttachIdleTtlMs();
  if (ttlMs <= 0) {
    void killSession();
    return;
  }
  state.killTimer = setTimeout(() => void killSession(), ttlMs);
  if (typeof state.killTimer.unref === "function") state.killTimer.unref();
}

async function ensureAppServerAttachPane(thread: Record<string, any>, cols: unknown, rows: unknown): Promise<Record<string, unknown> | null> {
  if (!threadUsesCodexAppServer(thread)) return null;
  const wakeResult: any = await wakeThread(String(thread.id), { reason: "browser_attach" }).catch(() => null);
  const currentThread = wakeResult?.thread || thread;
  const codexId = codexThreadId(currentThread);
  if (!codexId) return null;

  const cwd = String(currentThread.cwd || currentThread.workspace || currentThread.repoPath || currentThread.worktreePath || "/root");
  const sessionName = browserAttachSessionName(String(currentThread.id || thread.id));
  cancelBrowserAttachKill(sessionName);
  if (await tmuxHasSession(sessionName)) {
    // Browser Raw attach sessions are disposable; restart them so stale Codex resume screens are not replayed.
    await killTmuxSession(sessionName).catch(() => undefined);
  }
  const attachCommand = await codexResumeCommand({ cwd, codexThreadId: codexId });
  const script = [
    "clear",
    `printf ${shellQuote(`Attaching Orkestr thread ${currentThread.name || currentThread.id} to Codex...\\n\\n`)}`,
    attachCommand,
    `printf ${shellQuote("\\nCodex attach exited. Press Enter to close this browser terminal.\\n")}`,
    "read _",
  ].join("; ");
  await execFileAsync("tmux", ["new-session", "-d", "-s", sessionName, "-c", cwd, script]);

  const paneId = await tmuxPaneId(sessionName);
  if (!paneId) return null;
  await resizePane(paneId, cols, rows).catch(() => undefined);
  return {
    paneId,
    sessionName,
    state: "ready",
    runtimeKind: "codex-browser-attach",
  };
}

async function sendRawInput(paneId: string, data: string): Promise<void> {
  let literal = "";
  const input = String(data || "");
  const flushLiteral = async () => {
    if (!literal) return;
    const value = literal;
    literal = "";
    await tmuxSendLiteral(paneId, value);
  };

  for (let index = 0; index < input.length;) {
    const sequence = readRawEscapeSequence(input, index);
    if (sequence) {
      await flushLiteral();
      const key = rawEscapeSequenceKey(sequence);
      if (sequence === "\x1b") {
        await tmuxSendKey(paneId, "Escape");
      } else if (key) {
        await tmuxSendKey(paneId, key);
      }
      index += sequence.length;
      continue;
    }

    const char = input[index];
    index += 1;
    if (char === "\r" || char === "\n") {
      await flushLiteral();
      await tmuxSendKey(paneId, "C-m");
    } else if (char === "\t") {
      await flushLiteral();
      await tmuxSendKey(paneId, "Tab");
    } else if (char === "\x7f" || char === "\b") {
      await flushLiteral();
      await tmuxSendKey(paneId, "BSpace");
    } else if (char === "\x1b") {
      await flushLiteral();
      await tmuxSendKey(paneId, "Escape");
    } else if (char < " ") {
      await flushLiteral();
      const code = char.charCodeAt(0);
      if (code >= 1 && code <= 26) {
        await tmuxSendKey(paneId, `C-${String.fromCharCode(code + 96)}`);
      }
    } else {
      literal += char;
    }
  }
  await flushLiteral();
}

function rawTerminalNotice(message: string): string {
  return `\r\n[Orkestr] ${message}\r\n`;
}

async function approveRawPairingChallenge(ws: WebSocket, challengeId: string): Promise<void> {
  try {
    const result = await approvePairingChallenge(challengeId, { approvedBy: "raw-terminal" });
    wsSend(ws, {
      type: "output",
      data: rawTerminalNotice(`Approved pairing challenge ${result.challenge?.id || challengeId}.`),
    });
  } catch (error) {
    wsSend(ws, {
      type: "output",
      data: rawTerminalNotice(`Could not approve pairing challenge ${challengeId}: ${error instanceof Error ? error.message : String(error)}`),
    });
  }
}

async function sendRawInputWithControlInterception(
  paneId: string,
  data: string,
  state: { buffer: string },
  ws: WebSocket,
): Promise<void> {
  const input = String(data || "");
  const flushBuffer = async (submit = false) => {
    const buffered = state.buffer;
    state.buffer = "";
    if (buffered) await sendRawInput(paneId, buffered);
    if (submit) await sendRawInput(paneId, "\r");
  };

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (!state.buffer && !rawControlCommandMayMatch(char)) {
      await sendRawInput(paneId, input.slice(index));
      return;
    }
    if (!state.buffer) {
      state.buffer = char;
      continue;
    }

    if (char === "\r" || char === "\n") {
      const challengeId = rawSecurityApproveChallengeId(state.buffer);
      if (challengeId) {
        state.buffer = "";
        await approveRawPairingChallenge(ws, challengeId);
      } else {
        await flushBuffer(true);
      }
      continue;
    }

    if (char === "\x7f" || char === "\b") {
      state.buffer = state.buffer.slice(0, -1);
      continue;
    }

    if (char < " " || char === "\x1b") {
      await flushBuffer(false);
      await sendRawInput(paneId, input.slice(index));
      return;
    }

    state.buffer += char;
    if (!rawControlCommandMayMatch(state.buffer)) {
      await flushBuffer(false);
      if (index + 1 < input.length) await sendRawInput(paneId, input.slice(index + 1));
      return;
    }
  }
}

function upgradePath(url: string | undefined): { threadId: string; cols: string | null; rows: string | null } | null {
  const parsed = new URL(url || "/", "http://localhost");
  const match = parsed.pathname.match(/^\/api\/threads\/([^/]+)\/stream$/);
  if (!match?.[1]) return null;
  return {
    threadId: decodeURIComponent(match[1]),
    cols: parsed.searchParams.get("cols"),
    rows: parsed.searchParams.get("rows"),
  };
}

function summaryStreamPath(url: string | undefined): boolean {
  const parsed = new URL(url || "/", "http://localhost");
  return parsed.pathname === "/api/threads/summary/stream";
}

function summaryStreamIntervalMs(): number {
  const parsed = Number(process.env.ORKESTR_SUMMARY_STREAM_INTERVAL_MS || 10_000);
  return Number.isFinite(parsed) ? Math.max(5000, parsed) : 10_000;
}

function rawSnapshotActiveIntervalMs(): number {
  const parsed = Number(process.env.ORKESTR_RAW_STREAM_ACTIVE_INTERVAL_MS || 750);
  return Number.isFinite(parsed) ? Math.max(250, parsed) : 750;
}

function rawSnapshotIdleIntervalMs(): number {
  const parsed = Number(process.env.ORKESTR_RAW_STREAM_IDLE_INTERVAL_MS || 3000);
  return Number.isFinite(parsed) ? Math.max(rawSnapshotActiveIntervalMs(), parsed) : 3000;
}

function stableRuntimeSummary(runtime: unknown): unknown {
  if (!runtime || typeof runtime !== "object") return runtime || null;
  const { heartbeatAt, updatedAt, progress, ...stable } = runtime as Record<string, unknown>;
  if (!progress || typeof progress !== "object") return stable;
  const { capturedAt, sampledAtMs, ...stableProgress } = progress as Record<string, unknown>;
  return { ...stable, progress: stableProgress };
}

function stableSummaryBody(payload: { threads?: Array<Record<string, unknown>> }): string {
  const threads = (payload.threads || []).map((thread) => {
    const { updatedAt, threadUpdatedAt, runtime, progress, progressCapturedAt, ...stable } = thread;
    if (!progress || typeof progress !== "object") return { ...stable, runtime: stableRuntimeSummary(runtime) };
    const { capturedAt, sampledAtMs, ...stableProgress } = progress as Record<string, unknown>;
    return { ...stable, progress: stableProgress, runtime: stableRuntimeSummary(runtime) };
  });
  return JSON.stringify(threads);
}

function writeUpgradeError(socket: Duplex, statusCode: number, error: string): void {
  const statusText = statusCode === 403 ? "Forbidden" : statusCode === 404 ? "Not Found" : "Unauthorized";
  const body = JSON.stringify({ ok: false, error });
  socket.write([
    `HTTP/1.1 ${statusCode} ${statusText}`,
    "content-type: application/json; charset=utf-8",
    `content-length: ${Buffer.byteLength(body)}`,
    "connection: close",
    "",
    body,
  ].join("\r\n"));
  socket.destroy();
}

async function authorizeUpgradeRequest(request: IncomingMessage, socket: Duplex): Promise<Record<string, any> | null> {
  const result: any = await authorizeHttpRequest(request).catch((error) => ({
    ok: false,
    statusCode: Number(error?.statusCode || 500) || 500,
    error: error?.message || "unauthorized",
  }));
  if (result.ok) return result.principal || {};
  writeUpgradeError(socket, Number(result.statusCode || 401) || 401, String(result.error || "browser_pairing_required"));
  return null;
}

export function attachThreadStreamUpgrade(server: Server): void {
  if (attachedServers.has(server)) return;
  attachedServers.add(server);

  const wss = new WebSocketServer({ noServer: true });
  const summaryClients = new Map<WebSocket, SummaryClient>();
  let summaryTimer: NodeJS.Timeout | null = null;
  let summaryInFlight = false;

  const pushThreadSummary = async (force = false) => {
    if (!summaryClients.size || summaryInFlight) return;
    summaryInFlight = true;
    try {
      for (const [client, state] of summaryClients.entries()) {
        const payload = await threadSummaryPayload({ principal: state.principal });
        const stableBody = stableSummaryBody(payload);
        if (!force && stableBody === state.lastSummaryBody) continue;
        state.lastSummaryBody = stableBody;
        wsSend(client, { type: "threads_summary", ...payload });
      }
    } catch (error) {
      const message = { type: "error", data: error instanceof Error ? error.message : String(error) };
      for (const client of summaryClients.keys()) wsSend(client, message);
    } finally {
      summaryInFlight = false;
    }
  };

  const ensureSummaryTimer = () => {
    if (summaryTimer) return;
    summaryTimer = setInterval(() => {
      void pushThreadSummary(false);
    }, summaryStreamIntervalMs());
    if (typeof summaryTimer.unref === "function") summaryTimer.unref();
  };

  const stopSummaryTimerIfIdle = () => {
    if (summaryClients.size || !summaryTimer) return;
    clearInterval(summaryTimer);
    summaryTimer = null;
  };

  server.on("upgrade", async (request, socket, head) => {
    if (summaryStreamPath(request.url)) {
      const principal = await authorizeUpgradeRequest(request, socket);
      if (!principal) return;
      wss.handleUpgrade(request, socket, head, (ws) => {
        summaryClients.set(ws, { principal, lastSummaryBody: "" });
        ensureSummaryTimer();
        wsSend(ws, {
          type: "transport_ready",
          transport: "threads-summary",
          intervalMs: summaryStreamIntervalMs(),
        });
        void pushThreadSummary(true);
        const heartbeatTimer = setInterval(() => {
          wsSend(ws, { type: "heartbeat", ts: Date.now(), clients: summaryClients.size });
        }, 30_000);
        if (typeof heartbeatTimer.unref === "function") heartbeatTimer.unref();
        const close = () => {
          summaryClients.delete(ws);
          clearInterval(heartbeatTimer);
          stopSummaryTimerIfIdle();
        };
        ws.on("close", close);
        ws.on("error", close);
      });
      return;
    }

    const target = upgradePath(request.url);
    if (!target) return;

    const principal = await authorizeUpgradeRequest(request, socket);
    if (!principal) return;
    if (!isAdminPrincipal(principal)) {
      writeUpgradeError(socket, 403, "raw_terminal_admin_required");
      return;
    }

    const thread = await getThreadForPrincipal(target.threadId, principal).catch(() => null);
    if (!thread) {
      writeUpgradeError(socket, 404, "thread_not_found");
      return;
    }

    let status: Record<string, any> | null = await runtimeStatus(thread.id).catch(() => null);
    let paneId = String(status?.paneId || "").trim();
    if (!paneId && threadUsesCodexAppServer(thread)) {
      const attachStatus = await ensureAppServerAttachPane(thread as Record<string, any>, target.cols, target.rows).catch(() => null);
      if (attachStatus) {
        status = { ...(status || {}), ...attachStatus };
        paneId = String(attachStatus.paneId || "").trim();
      }
    }
    if (!paneId) {
      socket.destroy();
      return;
    }
    await resizePane(paneId, target.cols, target.rows).catch(() => undefined);
    const browserAttachSessionNameForStream = status?.runtimeKind === "codex-browser-attach"
      ? String(status.sessionName || "").trim()
      : "";

    wss.handleUpgrade(request, socket, head, (ws) => {
      let lastScreen = "";
      let closed = false;
      let inputQueue = Promise.resolve();
      let snapshotTimer: NodeJS.Timeout | null = null;
      let snapshotInFlight = false;
      let nextSnapshotIntervalMs = rawSnapshotActiveIntervalMs();
      const rawControlState = { buffer: "" };
      if (browserAttachSessionNameForStream) retainBrowserAttachSession(browserAttachSessionNameForStream);

      const scheduleSnapshot = (delayMs = nextSnapshotIntervalMs) => {
        if (closed) return;
        if (snapshotTimer) clearTimeout(snapshotTimer);
        snapshotTimer = setTimeout(() => {
          snapshotTimer = null;
          void pushSnapshot();
        }, Math.max(250, delayMs));
        if (typeof snapshotTimer.unref === "function") snapshotTimer.unref();
      };

      const pushSnapshot = async () => {
        if (closed || ws.readyState !== ws.OPEN) return;
        if (snapshotInFlight) {
          scheduleSnapshot(rawSnapshotActiveIntervalMs());
          return;
        }
        snapshotInFlight = true;
        try {
          const screen = await capturePane(paneId);
          if (screen !== lastScreen) {
            lastScreen = screen;
            const progress = {
              ...paneProgressFromText(screen, { tailLines: 20 }),
              paneId,
              sessionName: status?.sessionName || null,
            };
            if (progress.codexAuthInvalid) {
              await recordCodexRuntimeAuthInvalidSignal({ thread, progress }).catch(() => undefined);
            }
            nextSnapshotIntervalMs = rawSnapshotActiveIntervalMs();
            wsSend(ws, { type: "visible_screen", data: screen });
          } else {
            nextSnapshotIntervalMs = rawSnapshotIdleIntervalMs();
          }
        } catch (error) {
          wsSend(ws, { type: "error", data: error instanceof Error ? error.message : String(error) });
        } finally {
          snapshotInFlight = false;
          scheduleSnapshot();
        }
      };

      wsSend(ws, {
        type: "transport_ready",
        transport: "tmux-snapshot",
        paneId,
        sessionName: status?.sessionName || null,
        state: status?.state || null,
      });
      wsSend(ws, { type: "input_ready" });
      void pushSnapshot();
      const heartbeatTimer = setInterval(() => {
        wsSend(ws, { type: "heartbeat", ts: Date.now(), sessionAlive: true });
      }, 5000);

      ws.on("message", (raw) => {
        inputQueue = inputQueue
          .then(async () => {
            const payload = JSON.parse(raw.toString("utf8"));
            if (payload?.type === "input" && typeof payload.data === "string") {
              await sendRawInputWithControlInterception(paneId, payload.data, rawControlState, ws);
              nextSnapshotIntervalMs = rawSnapshotActiveIntervalMs();
              await pushSnapshot();
            } else if (payload?.type === "resize") {
              await resizePane(paneId, payload.cols, payload.rows).catch(() => undefined);
              nextSnapshotIntervalMs = rawSnapshotActiveIntervalMs();
              await pushSnapshot();
            }
          })
          .catch((error) => {
            wsSend(ws, { type: "error", data: error instanceof Error ? error.message : String(error) });
          });
      });
      const closeRawStream = () => {
        if (closed) return;
        closed = true;
        if (snapshotTimer) clearTimeout(snapshotTimer);
        clearInterval(heartbeatTimer);
        if (browserAttachSessionNameForStream) releaseBrowserAttachSession(browserAttachSessionNameForStream);
      };
      ws.on("close", closeRawStream);
      ws.on("error", closeRawStream);
    });
  });
}
