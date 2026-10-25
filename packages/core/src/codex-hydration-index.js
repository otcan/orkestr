import { clean } from "./codex-app-server-common.js";

// Lookups for one history hydration pass over a thread's messages.
//
// Hydration visits every item of a Codex thread and, per item, used to scan the
// whole message list several times (O(items x messages) on long threads). Each
// lookup here returns a subset of `messages` in array order that contains every
// message the original predicate can match, so callers keep applying their
// exact predicates and first-match order to the subset.
//
// The index only stays valid while the caller reports every change to the
// array: `appended` after a push, `invalidate` after an in-place replacement or
// a reload. Message objects are never mutated in place by hydration.

const generation = (row) => clean(row?.codexThreadId || row?.executorThreadId);
const turn = (row) => clean(row?.codexTurnId || row?.executorTurnId);
const key = (left, right) => `${left}\u0000${right}`;

function add(map, mapKey, message) {
  const bucket = map.get(mapKey);
  if (bucket) bucket.push(message);
  else map.set(mapKey, [message]);
}

export function createCodexHydrationIndex(messages = []) {
  let built = false;
  let seenLoads = null;
  // clean(codexThreadId), clean(codexTurnId): superset of strict or cleaned
  // equality on those two fields.
  const byCodexTurn = new Map();
  // generation(row), turn(row): the scope of codex-input-identity helpers.
  const byIdentityTurn = new Map();
  // clean(eventId)
  const byEventId = new Map();

  function index(message) {
    add(byCodexTurn, key(clean(message?.codexThreadId), clean(message?.codexTurnId)), message);
    add(byIdentityTurn, key(generation(message), turn(message)), message);
    add(byEventId, clean(message?.eventId), message);
  }

  function ensure() {
    if (built) return;
    byCodexTurn.clear();
    byIdentityTurn.clear();
    byEventId.clear();
    for (const message of messages) index(message);
    built = true;
  }

  return {
    // Messages whose clean(codexThreadId) and clean(codexTurnId) equal the cleaned arguments.
    codexTurn(codexThreadId, codexTurnId) {
      ensure();
      return byCodexTurn.get(key(clean(codexThreadId), clean(codexTurnId))) || [];
    },
    // Messages whose generation and turn (codex or executor ids) equal the cleaned arguments.
    identityTurn(codexThreadId, codexTurnId) {
      ensure();
      return byIdentityTurn.get(key(clean(codexThreadId), clean(codexTurnId))) || [];
    },
    // Superset of the rows sameInputScope(row, input) accepts, i.e. matchCanonicalInput's scope.
    identityScopeOf(input) {
      return this.identityTurn(generation(input), turn(input));
    },
    // Messages whose clean(eventId) equals the cleaned argument.
    eventId(eventId) {
      ensure();
      return byEventId.get(clean(eventId)) || [];
    },
    appended(message) {
      if (built) index(message);
    },
    invalidate() {
      built = false;
    },
    // Rebuild after the owning snapshot reloaded `messages` (its `loads` moved).
    sync(loads) {
      if (loads === seenLoads) return;
      seenLoads = loads;
      built = false;
    },
  };
}
