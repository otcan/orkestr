// Fast refresh for the open conversation while it is busy (a message was just
// sent, or replies are arriving). The summary stream only pushes every few
// seconds, which made replies feel slow to appear.
export class ActiveThreadRefresh {
  private timer?: ReturnType<typeof setInterval>;
  private inFlight = false;

  constructor(
    private readonly refresh: () => Promise<void>,
    private readonly shouldRefresh: () => boolean,
    private readonly intervalMs = 1500,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async tick(): Promise<void> {
    if (this.inFlight || globalThis.document?.visibilityState === "hidden" || !this.shouldRefresh()) return;
    this.inFlight = true;
    try {
      await this.refresh();
    } catch {
      // The summary stream and the next tick recover; never surface poll errors.
    } finally {
      this.inFlight = false;
    }
  }
}
