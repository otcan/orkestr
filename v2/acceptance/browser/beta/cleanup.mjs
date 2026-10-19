import {errorChain, failure} from './diagnostics.mjs';

const NAMES = new Set(['owned_context', 'download_helper', 'browser_connection',
  'network_observer', 'private_gate', 'runtime_configuration', 'desktop_lease', 'synthetic_server', 'synthetic_home']);

// Only caller-owned handles belong here. The always-on beta service and shared
// browser process are deliberately not cleanup targets.
export class Cleanup {
  #steps = []; #started = false;
  add(name, action, timeoutMs = 6000) {
    if (this.#started || !NAMES.has(name) || this.#steps.some(item => item.name === name) ||
        typeof action !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) {
      throw failure('invalid_action');
    }
    this.#steps.push({name, action, timeoutMs});
  }
  async close() {
    if (this.#started) throw failure('invalid_action');
    this.#started = true;
    const results = [];
    for (const {name, action, timeoutMs} of this.#steps) {
      let timer;
      // Retain the promise even after the deadline. A timeout remains unknown;
      // later settlement never retroactively turns the receipt into success.
      const work = Promise.resolve().then(action);
      work.catch(() => {});
      try {
        const outcome = await Promise.race([work, new Promise((_, reject) => {
          timer = setTimeout(() => reject(failure('cleanup_unknown')), timeoutMs);
        })]);
        if (outcome !== true) throw failure('cleanup_unknown');
        results.push({name, state: 'closed'});
      } catch (error) {
        results.push({name, state: 'unknown', diagnostic: errorChain(error)});
      } finally { clearTimeout(timer); }
    }
    return {complete: results.every(item => item.state === 'closed'), results};
  }
}

// This is only for sessions created in the owned context. A successful context
// close can already detach them. Other detach failures must still be reported.
export async function detachOwned(session) {
  if (session.detached !== true) await session.detach();
  return true;
}
