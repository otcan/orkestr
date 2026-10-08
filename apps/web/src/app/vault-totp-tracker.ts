import type { VaultTotpCode } from "./vault-api.service";

export interface VaultCodeState {
  code: string;
  digits: number;
  period: number;
  expiresAt: number;
}

const retryAfterFailureMs = 15_000;

// Keeps live authenticator codes for the rows the user can actually see.
// Codes are fetched only for visible rows and only while the page is visible.
export class VaultTotpTracker {
  readonly codes = new Map<string, VaultCodeState>();
  private readonly inflight = new Set<string>();
  private readonly retryAt = new Map<string, number>();

  constructor(
    private readonly fetchCode: (id: string) => Promise<VaultTotpCode>,
    private readonly now: () => number = () => Date.now(),
    private readonly pageVisible: () => boolean = () => globalThis.document?.visibilityState !== "hidden",
  ) {}

  async refresh(visibleIds: Iterable<string>): Promise<void> {
    if (!this.pageVisible()) return;
    const now = this.now();
    const pending: Array<Promise<void>> = [];
    for (const id of visibleIds) {
      if (this.inflight.has(id)) continue;
      const current = this.codes.get(id);
      if (current && current.expiresAt > now) continue;
      if ((this.retryAt.get(id) || 0) > now) continue;
      pending.push(this.load(id));
    }
    await Promise.all(pending);
  }

  private async load(id: string): Promise<void> {
    this.inflight.add(id);
    try {
      const result = await this.fetchCode(id);
      const seconds = Math.max(1, Number(result.expiresInSeconds) || 1);
      this.codes.set(id, {
        code: String(result.code || ""),
        digits: Number(result.digits) || String(result.code || "").length,
        period: Math.max(seconds, Number(result.period) || 30),
        expiresAt: this.now() + seconds * 1000,
      });
      this.retryAt.delete(id);
    } catch {
      this.codes.delete(id);
      this.retryAt.set(id, this.now() + retryAfterFailureMs);
    } finally {
      this.inflight.delete(id);
    }
  }

  code(id: string): VaultCodeState | null {
    const current = this.codes.get(id);
    return current && current.expiresAt > this.now() ? current : null;
  }

  secondsLeft(id: string): number {
    const current = this.code(id);
    return current ? Math.max(0, Math.ceil((current.expiresAt - this.now()) / 1000)) : 0;
  }

  // Fraction of the period still remaining, 0..1.
  fractionLeft(id: string): number {
    const current = this.code(id);
    if (!current) return 0;
    return Math.min(1, Math.max(0, (current.expiresAt - this.now()) / (current.period * 1000)));
  }

  forget(id: string): void {
    this.codes.delete(id);
    this.retryAt.delete(id);
  }

  clear(): void {
    this.codes.clear();
    this.retryAt.clear();
  }
}

export function formatTotpCode(code: string): string {
  if (code.length === 6) return `${code.slice(0, 3)} ${code.slice(3)}`;
  if (code.length === 8) return `${code.slice(0, 4)} ${code.slice(4)}`;
  return code;
}
