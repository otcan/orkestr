import { firstValueFrom, timeout } from "rxjs";
import { ApiService, TimerRecord, VersionResponse, WhatsAppStatusResponse } from "./api.service";

// These panels enrich the shell but must never hold up conversations. Apply
// each result separately, even when another connector is slow or unavailable.
export function refreshAppExtras(api: ApiService, target: {
  system(value: Record<string, unknown>): void;
  timers(value: TimerRecord[]): void;
  whatsapp(value: WhatsAppStatusResponse): void;
  version(value: VersionResponse): void;
}): Promise<void> {
  return Promise.allSettled([
    firstValueFrom(api.systemSummary().pipe(timeout(10_000))).then(target.system),
    firstValueFrom(api.timers().pipe(timeout(10_000))).then(value => target.timers(value.timers || [])),
    firstValueFrom(api.whatsappStatus().pipe(timeout(10_000))).then(target.whatsapp),
    firstValueFrom(api.version().pipe(timeout(10_000))).then(target.version),
  ]).then(() => undefined);
}
