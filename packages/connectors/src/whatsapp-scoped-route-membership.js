// Multi-thread activation is explicit: every configured destination must belong
// to the same operator-controlled delivery fence. Legacy single-thread scopes
// retain their original shape; an omitted list never broadens their scope.
export function scopedRouteMembership(config) {
  const control = config.routeControl;
  if (!control) return null;
  if (control.threadIds === undefined) return new Set([control.threadId]);
  const ids = control.threadIds;
  const groups = config.groups || [];
  if (control.threadId !== undefined || !Array.isArray(ids) || !ids.length
      || ids.some(id => typeof id !== 'string' || !id)
      || new Set(ids).size !== ids.length || ids.length !== groups.length
      || new Set(groups.map(g => g.threadId)).size !== groups.length
      || groups.some(g => !ids.includes(g.threadId)))
    throw new Error('scoped_worker_configuration_invalid');
  return new Set(ids);
}
