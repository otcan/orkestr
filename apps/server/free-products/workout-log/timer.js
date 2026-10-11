// Rest timer based on an absolute end time, so it stays correct when the tab
// is throttled in the background.
import { LIMITS } from "./progression.js";

export function createRestTimer({ onTick, onDone, now = () => Date.now(), schedule = globalThis.setInterval, cancel = globalThis.clearInterval } = {}) {
  let endsAt = 0;
  let handle = null;

  function remaining() {
    return endsAt ? Math.max(0, (endsAt - now()) / 1000) : 0;
  }

  function stopTicking() {
    if (handle !== null) cancel(handle);
    handle = null;
  }

  function tick() {
    const left = remaining();
    onTick?.(left, Boolean(endsAt));
    if (endsAt && left <= 0) {
      endsAt = 0;
      stopTicking();
      onDone?.();
    }
  }

  return {
    get running() {
      return Boolean(endsAt);
    },
    remaining,
    start(seconds) {
      endsAt = now() + Math.max(1, Number(seconds) || 0) * 1000;
      stopTicking();
      handle = schedule(tick, 250);
      tick();
    },
    add(seconds) {
      if (!endsAt) return;
      endsAt = Math.min(endsAt + seconds * 1000, now() + LIMITS.maxRest * 1000);
      tick();
    },
    stop() {
      endsAt = 0;
      stopTicking();
      onTick?.(0, false);
    },
    tick,
  };
}
