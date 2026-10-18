import { Observable, Subscription, take, timeout } from "rxjs";

// Setup includes slow connector probes. It must not gate an authenticated
// conversation response; cancellation also prevents late refreshes replacing it.
export function startAppSetupRefresh<T>(source: Observable<T>, target: {
  apply(value: T, current: () => boolean): Promise<void>;
  failed(error: unknown): void;
}, timeoutMs = 10_000): () => void {
  let cancelled = false;
  const current = () => !cancelled;
  const failed = (error: unknown) => { if (current()) target.failed(error); };
  const subscription: Subscription = source.pipe(take(1), timeout(timeoutMs)).subscribe({
    next: value => { void target.apply(value, current).catch(failed); },
    error: failed,
  });
  return () => { cancelled = true; subscription.unsubscribe(); };
}
