// SQL form of src/query/scope.js appScope. Emits the single `app` constraint and
// pushes its parameter(s) onto the shared params array so placeholder numbering
// stays correct when composed after the other WHERE clauses.
//
//   appScopeSql(undefined, undefined, p) -> null                 no constraint
//   appScopeSql('web',     undefined, p) -> 'app = $n'           single service
//   appScopeSql(undefined, ['a','b'], p) -> 'app = ANY($n)'      project scope
//   appScopeSql(undefined, [],        p) -> 'false'              empty project: nothing
//   appScopeSql('web', ['web','api'], p) -> 'app = $n'           member drill-down
//   appScopeSql('x',   ['web','api'], p) -> 'false'              non-member: nothing
export function appScopeSql(app, apps, params) {
  const hasApp = typeof app === 'string' && app.length > 0;
  if (Array.isArray(apps)) {
    if (hasApp) {
      if (!apps.includes(app)) return 'false';
      params.push(app);
      return `app = $${params.length}`;
    }
    if (apps.length === 0) return 'false';
    params.push(apps);
    return `app = ANY($${params.length})`;
  }
  if (hasApp) {
    params.push(app);
    return `app = $${params.length}`;
  }
  return null;
}
