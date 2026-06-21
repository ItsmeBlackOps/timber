// Build the Mongo `app` match clause from an optional single app and an optional
// resolved project app-set. Spread the result into a $match / find filter.
//
//   appScope(undefined, undefined) -> {}                      no constraint
//   appScope('web',     undefined) -> { app: 'web' }          single service
//   appScope(undefined, ['a','b']) -> { app: { $in: ['a','b'] } }   project scope
//   appScope(undefined, [])        -> { app: { $in: [] } }    empty project: nothing
//   appScope('web', ['web','api']) -> { app: 'web' }          member drill-down
//   appScope('x',   ['web','api']) -> { app: { $in: [] } }    non-member: nothing
export function appScope(app, apps) {
  const hasApp = typeof app === 'string' && app.length > 0;
  if (Array.isArray(apps)) {
    if (hasApp) return apps.includes(app) ? { app } : { app: { $in: [] } };
    return { app: { $in: apps } };
  }
  return hasApp ? { app } : {};
}
