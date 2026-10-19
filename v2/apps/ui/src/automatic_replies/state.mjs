// Consumer of Core d8b86f5e2. This module grants no transport authority.
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value) && value !== '00000000-0000-0000-0000-000000000000';
const integer = value => Number.isSafeInteger(value) && value >= 0;
const fields = (value, names) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join() === [...names].sort().join();
export const permissionLabel = enabled => enabled ? 'Automatic replies allowed' : 'Automatic replies paused';
export const connectionNotice = 'This permission does not indicate an active connection.';
export class PermissionState {
 #generation = 0; #order = 0; #applied = 0; #conversation; #history = new Map(); #pending;
 select(conversation) {
  if (conversation !== undefined && !uuid(conversation)) throw new Error('Invalid conversation');
  this.#conversation = conversation; this.#generation++; this.#order = 0; this.#applied = 0;
  this.#history.clear(); this.#pending = undefined;
 }
 request(after = null) {
  if (!this.#conversation || (after !== null && !uuid(after))) throw new Error('Invalid permission selection');
  return Object.freeze({conversation: this.#conversation, generation: this.#generation, order: ++this.#order, after});
 }
 current(ticket) { return ticket.generation === this.#generation && ticket.conversation === this.#conversation; }
 apply(ticket, page) {
  if (!this.current(ticket) || ticket.order <= this.#applied) return false;
  if (!fields(page, ['conversation_id','observed_at_ms','routes','next_after']) || page.conversation_id !== ticket.conversation || !integer(page.observed_at_ms) || !Array.isArray(page.routes) || page.routes.length > 32) throw new Error('Invalid permission page');
  let previous = ticket.after; const staged = new Map(this.#history);
  for (const route of page.routes) {
   if (!fields(route, ['route_id','route_generation','permission_revision','enabled']) || !uuid(route.route_id) || !integer(route.route_generation) || route.route_generation === 0 || !integer(route.permission_revision) || typeof route.enabled !== 'boolean' || (previous !== null && route.route_id <= previous)) throw new Error('Invalid permission route');
   previous = route.route_id;
   const old = staged.get(route.route_id);
   if (old && (route.route_generation < old.route_generation || (route.route_generation === old.route_generation && route.permission_revision < old.permission_revision))) throw new Error('Obsolete permission state');
   if (old && route.route_generation === old.route_generation && route.permission_revision === old.permission_revision && route.enabled !== old.enabled) throw new Error('Conflicting permission state');
   staged.set(route.route_id, Object.freeze({...route}));
  }
  if (page.next_after !== null && (!uuid(page.next_after) || page.routes.length === 0 || page.next_after !== previous)) throw new Error('Invalid permission cursor');
  this.#history = staged; this.#applied = ticket.order;
  return true;
 }
 prepare(routeId, enabled, requestKey) {
  if (this.#pending) return this.#pending;
  const route = this.#history.get(routeId);
  if (!route || typeof enabled !== 'boolean' || typeof requestKey !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(requestKey)) throw new Error('Refresh permission before changing it');
  this.#pending = Object.freeze({route_id:routeId, expected_route_generation:route.route_generation, expected_permission_revision:route.permission_revision, request_key:requestKey, enabled});
  return this.#pending;
 }
 // An uncertain response retains the exact tuple. Definitive refusal/receipt
 // ends the attempt; callers must read current status before another decision.
 finish(ticket, definitive) {
  if (!this.current(ticket)) return false;
  if (definitive) { this.#pending = undefined; this.#history.clear(); }
  return true;
 }
 pending() { return this.#pending; }
}
