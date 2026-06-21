# Timber Projects, Console Implementation Plan (Plan 2 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes. Mirror the named existing files for style; the controller pastes interfaces + novel code + exact test assertions so you rarely need to read the plan file.

**Goal:** Build the Console UI for Projects: a ProjectSwitcher, a Manage Projects dialog (CRUD), a per-project Overview dashboard (the six lenses at a glance), and a Jobs dashboard, all scoping to the selected project.

**Architecture:** The project slug lives in the URL (`project=<slug>`), the single source of truth, exactly like the existing `app` dimension. It threads into the query hooks; the six lenses already exist in `web/src/lib/views.ts` and become project-aware for free once `project` is in `Filters`. Projects CRUD uses the first `useMutation` in the repo. Reuses TanStack Router (code-based, `useSearch({strict:false})`), TanStack Query v5, MSW v2 tests.

**Tech Stack:** React 19, TypeScript strict (`verbatimModuleSyntax` so `import type`; `erasableSyntaxOnly` so no TS parameter-properties), `@/` = `web/src/`, Vite, Vitest + Testing Library + MSW v2. Spec section 8: `docs/superpowers/specs/2026-06-21-timber-projects-design.md`.

**ACTUAL backend contract (target this, not the spec's `:id` wording):**
- `Project = { slug: string; name: string; apps: string[] }`
- `GET /v1/projects` → `{ projects: Project[] }`
- `POST /v1/projects` body `{ name, apps }` → `201 Project`
- `PATCH /v1/projects` body `{ slug, name?, apps? }` → `200 Project` (409 dup name, 404 unknown)
- `DELETE /v1/projects?slug=<slug>` → `204`
- `project=<slug>` query param on `/v1/logs|stats|events|facets|groupby|jobs`
- `GET /v1/jobs?from&to&app&project` → `{ jobs: JobRow[], window:{from,to} }`, `JobRow = { name, lastRunAt, lastStatus:'ok'|'failed', runs, failures, successRate:number|null, p50Ms:number|null, p95Ms:number|null }`

**Conventions:** run from `web/`. Test: `npm test` (`vitest run`); one file `npx vitest run <path>`. Typecheck: `npm run typecheck` (`tsc -b`). Lint: `npm run lint`. Commit messages: plain subject, NO AI-attribution trailers, NO em/en dashes. After each task: typecheck + the task's tests green, then commit.

---

## File Structure

**Create:** `web/src/components/ProjectSwitcher.tsx`, `web/src/components/ManageProjectsDialog.tsx`, `web/src/hooks/useProjects.ts`, `web/src/hooks/useJobs.ts`, `web/src/routes/overview.tsx`, `web/src/routes/jobs.tsx` (+ a `.test.tsx`/`.test.ts` beside each new unit).

**Modify:** `web/src/lib/types.ts` (Project/JobRow/JobsResponse), `web/src/lib/api.ts` (`apiSend` + endpoint fns), `web/src/lib/filters.ts` (`project` in Filters + both mappers), `web/src/hooks/{useStats,useFacets,useEvents}.ts` (+ `project` param), `web/src/hooks/index.ts` (exports), `web/src/router.tsx` (routes), `web/src/routes/__root.tsx` (ProjectSwitcher + Manage dialog + nav), `web/test/fixtures.ts` + `web/test/handlers.ts` (PROJECTS/JOBS fixtures + default handlers).

---

## Task 1: Types, API client, test fixtures/handlers

**Files:** Modify `web/src/lib/types.ts`, `web/src/lib/api.ts`, `web/test/fixtures.ts`, `web/test/handlers.ts`; Test `web/src/lib/api.test.ts`.

- [ ] **Step 1: Add types** to `web/src/lib/types.ts` (explicit fields, no parameter-properties):
```ts
export interface Project {
  slug: string;
  name: string;
  apps: string[];
}

export interface ProjectsResponse {
  projects: Project[];
}

export interface JobRow {
  name: string;
  lastRunAt: string;
  lastStatus: 'ok' | 'failed';
  runs: number;
  failures: number;
  successRate: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
}

export interface JobsResponse {
  jobs: JobRow[];
  window: { from: string; to: string };
}
```

- [ ] **Step 2: Add a write helper + endpoint fns** to `web/src/lib/api.ts`. `apiGet`, `isSameOrigin`, `readBody`, `ApiError` already exist; reuse them. Add after the existing endpoint fns:
```ts
// Mutating requests (projects CRUD). Mirrors apiGet's same-origin Bearer gate and
// ApiError-on-non-2xx; returns null for 204 (DELETE).
async function apiSend<T>(method: 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T | null> {
  const { apiBaseUrl, readKey } = loadSettings()
  const url = (apiBaseUrl || '') + path
  const headers: Record<string, string> = { accept: 'application/json' }
  if (readKey && isSameOrigin(url)) headers.authorization = `Bearer ${readKey}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  const res = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined })
  if (!res.ok) throw new ApiError(res.status, await readBody(res))
  if (res.status === 204) return null
  return (await res.json()) as T
}

export const getProjects = () => apiGet<ProjectsResponse>('/v1/projects')
export const createProject = (body: { name: string; apps: string[] }) =>
  apiSend<Project>('POST', '/v1/projects', body)
export const updateProject = (body: { slug: string; name?: string; apps?: string[] }) =>
  apiSend<Project>('PATCH', '/v1/projects', body)
export const deleteProject = (slug: string) =>
  apiSend<null>('DELETE', `/v1/projects?slug=${encodeURIComponent(slug)}`)
export const getJobs = (p?: URLSearchParams) => apiGet<JobsResponse>('/v1/jobs', p)
```
Add the new types to the existing `import type { ... } from '@/lib/types'` line: `Project, ProjectsResponse, JobsResponse`.

- [ ] **Step 3: Add fixtures** to `web/test/fixtures.ts` (typed):
```ts
export const PROJECTS_RESPONSE: ProjectsResponse = {
  projects: [
    { slug: 'acme', name: 'Acme', apps: ['api', 'worker'] },
    { slug: 'web-co', name: 'Web Co', apps: ['scheduler'] },
  ],
}

export const JOBS_RESPONSE: JobsResponse = {
  jobs: [
    { name: 'cron.report', lastRunAt: '2026-06-20T03:00:00.000Z', lastStatus: 'ok', runs: 12, failures: 0, successRate: 1, p50Ms: 1200, p95Ms: 3400 },
    { name: 'cron.sync', lastRunAt: '2026-06-20T02:00:00.000Z', lastStatus: 'failed', runs: 8, failures: 3, successRate: 0.625, p50Ms: null, p95Ms: null },
  ],
  window: { from: '2026-06-19T00:00:00.000Z', to: '2026-06-20T00:00:00.000Z' },
}
```
Add `Project, ProjectsResponse, JobsResponse` to the `import type` from `@/lib/types`.

- [ ] **Step 4: Add default MSW handlers** in `web/test/handlers.ts` so every view mounting a ProjectSwitcher gets data:
```ts
http.get('/v1/projects', () => HttpResponse.json(PROJECTS_RESPONSE)),
http.get('/v1/jobs', () => HttpResponse.json(JOBS_RESPONSE)),
```
(import `PROJECTS_RESPONSE, JOBS_RESPONSE` from `./fixtures`).

- [ ] **Step 5: Write tests** `web/src/lib/api.test.ts` (mirror the existing api.test.ts setup; settings mocked so `readKey` is set and same-origin). Cover:
```ts
// getProjects parses the list
test('getProjects returns projects', async () => {
  server.use(http.get('/v1/projects', () => HttpResponse.json(PROJECTS_RESPONSE)))
  const r = await getProjects()
  expect(r.projects.map((p) => p.slug)).toEqual(['acme', 'web-co'])
})
// createProject POSTs the body and returns the created project
test('createProject posts name+apps', async () => {
  let seen: unknown
  server.use(http.post('/v1/projects', async ({ request }) => {
    seen = await request.json()
    return HttpResponse.json({ slug: 'x', name: 'X', apps: [] }, { status: 201 })
  }))
  const p = await createProject({ name: 'X', apps: [] })
  expect(seen).toEqual({ name: 'X', apps: [] })
  expect(p?.slug).toBe('x')
})
// deleteProject hits DELETE with the slug and tolerates 204
test('deleteProject sends slug and returns null on 204', async () => {
  let url = ''
  server.use(http.delete('/v1/projects', ({ request }) => { url = request.url; return new HttpResponse(null, { status: 204 }) }))
  const r = await deleteProject('acme')
  expect(url).toContain('slug=acme')
  expect(r).toBeNull()
})
// non-2xx throws ApiError with status + body
test('apiSend throws ApiError on 409', async () => {
  server.use(http.post('/v1/projects', () => HttpResponse.json({ error: 'dup' }, { status: 409 })))
  await expect(createProject({ name: 'X', apps: [] })).rejects.toMatchObject({ status: 409 })
})
```
Run `npx vitest run src/lib/api.test.ts` (PASS), then `npm run typecheck`.

- [ ] **Step 6: Commit**
```bash
git add src/lib/types.ts src/lib/api.ts src/lib/api.test.ts test/fixtures.ts test/handlers.ts
git commit -m "feat(console): projects + jobs types, API client, test fixtures"
```

---

## Task 2: `project` in Filters + URL

**Files:** Modify `web/src/lib/filters.ts`; Test `web/src/lib/filters.test.ts`.

- [ ] **Step 1: Failing test** append to `web/src/lib/filters.test.ts`:
```ts
test('project round-trips through params', () => {
  const f = paramsToFilters(new URLSearchParams('project=acme&app=api'))
  expect(f.project).toBe('acme')
  expect(filtersToParams(f).get('project')).toBe('acme')
})
test('no project -> param omitted', () => {
  expect(filtersToParams(paramsToFilters(new URLSearchParams(''))).has('project')).toBe(false)
})
```
Run `npx vitest run src/lib/filters.test.ts` (FAIL: `project` undefined).

- [ ] **Step 2: Implement** in `web/src/lib/filters.ts`:
  - Add `project?: string` to the `Filters` interface (next to `app?: string`).
  - In `filtersToParams`, beside the app/env lines, add: `appendScalar(p, 'project', f.project)`.
  - In `paramsToFilters`'s `if/else if` name chain, add: `else if (name === 'project') f.project = value`.

- [ ] **Step 3:** Run `npx vitest run src/lib/filters.test.ts` (PASS) + `npm run typecheck`.

- [ ] **Step 4: Commit**
```bash
git add src/lib/filters.ts src/lib/filters.test.ts
git commit -m "feat(console): thread project slug through Filters and URL"
```

---

## Task 3: Hooks, useProjects + useJobs + thread project

**Files:** Create `web/src/hooks/useProjects.ts`, `web/src/hooks/useJobs.ts`; Modify `web/src/hooks/{useStats,useFacets,useEvents}.ts`, `web/src/hooks/index.ts`; Test `web/src/hooks/projects.test.tsx`.

- [ ] **Step 1: Create `web/src/hooks/useProjects.ts`** (first useMutation in the repo; TanStack Query v5):
```ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getProjects, createProject, updateProject, deleteProject } from '@/lib/api'
import type { ProjectsResponse } from '@/lib/types'
import { useHasReadKey } from './_shared'

export function useProjects() {
  const qc = useQueryClient()
  const query = useQuery<ProjectsResponse>({
    queryKey: ['projects'],
    queryFn: () => getProjects(),
    enabled: useHasReadKey(),
  })
  const invalidate = () => qc.invalidateQueries({ queryKey: ['projects'] })
  const create = useMutation({ mutationFn: createProject, onSuccess: invalidate })
  const update = useMutation({ mutationFn: updateProject, onSuccess: invalidate })
  const remove = useMutation({ mutationFn: deleteProject, onSuccess: invalidate })
  return { query, create, update, remove }
}
```

- [ ] **Step 2: Create `web/src/hooks/useJobs.ts`:**
```ts
import { useQuery } from '@tanstack/react-query'
import { getJobs } from '@/lib/api'
import type { JobsResponse } from '@/lib/types'
import type { TimeRange } from './useStats'
import { useHasReadKey } from './_shared'

export function useJobs(range: TimeRange, project?: string, app?: string) {
  return useQuery<JobsResponse>({
    queryKey: ['jobs', range.from, range.to, project ?? null, app ?? null],
    queryFn: () => {
      const p = new URLSearchParams()
      p.set('from', range.from)
      p.set('to', range.to)
      if (project) p.set('project', project)
      if (app) p.set('app', app)
      return getJobs(p)
    },
    enabled: useHasReadKey(),
  })
}
```

- [ ] **Step 3: Thread `project` into the three explicit-param hooks** (useLogs/useGroupBy already carry it via `filters`). For each, add a trailing optional `project?: string`, add it to the queryKey (`..., project ?? null`), and `if (project) params.set('project', project)` in the queryFn:
  - `useStats(range, group, app?, event?, project?)`
  - `useFacets(app?, range, project?)` (keep existing arg order; add `project?` last)
  - `useEvents(project?)`
  (Mirror the existing body of each; only add the param + key entry + `params.set`.)

- [ ] **Step 4: Export** in `web/src/hooks/index.ts`:
```ts
export { useProjects } from './useProjects'
export { useJobs } from './useJobs'
```

- [ ] **Step 5: Tests** `web/src/hooks/projects.test.tsx` (mirror the settings-mock + QueryClient wrapper from `web/src/hooks/hooks.test.tsx`; render hooks with `renderHook` under a `QueryClientProvider`). Cover:
```ts
// useProjects lists from the API
test('useProjects.query lists projects', async () => {
  const { result } = renderHook(() => useProjects(), { wrapper })
  await waitFor(() => expect(result.current.query.isSuccess).toBe(true))
  expect(result.current.query.data?.projects).toHaveLength(2)
})
// create invalidates the list (refetch happens)
test('create mutation invalidates projects', async () => {
  let gets = 0
  server.use(
    http.get('/v1/projects', () => { gets++; return HttpResponse.json(PROJECTS_RESPONSE) }),
    http.post('/v1/projects', () => HttpResponse.json({ slug: 'n', name: 'N', apps: [] }, { status: 201 })),
  )
  const { result } = renderHook(() => useProjects(), { wrapper })
  await waitFor(() => expect(result.current.query.isSuccess).toBe(true))
  await act(async () => { await result.current.create.mutateAsync({ name: 'N', apps: [] }) })
  await waitFor(() => expect(gets).toBeGreaterThanOrEqual(2))
})
// useJobs sets project + window params
test('useJobs passes project', async () => {
  let seen: URLSearchParams | undefined
  server.use(http.get('/v1/jobs', ({ request }) => { seen = new URL(request.url).searchParams; return HttpResponse.json(JOBS_RESPONSE) }))
  const { result } = renderHook(() => useJobs({ from: 'A', to: 'B' }, 'acme'), { wrapper })
  await waitFor(() => expect(result.current.isSuccess).toBe(true))
  expect(seen?.get('project')).toBe('acme')
})
```
Run `npx vitest run src/hooks/projects.test.tsx` (PASS) + `npm run typecheck` (confirms the new useStats/useFacets/useEvents signatures compile with existing callers, which pass no `project` and still work).

- [ ] **Step 6: Commit**
```bash
git add src/hooks/
git commit -m "feat(console): useProjects (CRUD) + useJobs hooks; thread project into stats/facets/events"
```

---

## Task 4: ProjectSwitcher + shell wiring

**Files:** Create `web/src/components/ProjectSwitcher.tsx`; Modify `web/src/routes/__root.tsx`; Test `web/src/components/ProjectSwitcher.test.tsx`.

- [ ] **Step 1: Create `ProjectSwitcher.tsx`** (mirror `AppSwitcher.tsx`'s native-select style + the `ALL` sentinel; add a Manage button):
```tsx
import type { Project } from '@/lib/types'

export interface ProjectSwitcherProps {
  projects: Project[];
  value: string | undefined;        // selected slug, or undefined for "all"
  onChange: (slug: string | undefined) => void;
  onManage: () => void;
}

const ALL = '__all__';

export function ProjectSwitcher({ projects, value, onChange, onManage }: ProjectSwitcherProps) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <select
        aria-label="Project"
        value={value ?? ALL}
        onChange={(e) => { const v = e.target.value; onChange(v === ALL ? undefined : v); }}
        style={{ height: 32, padding: '0 8px', borderRadius: 6, border: '1px solid var(--tb-border)', background: 'var(--tb-surface)', color: 'var(--tb-text)', fontSize: 13, cursor: 'pointer' }}
      >
        <option value={ALL}>All projects</option>
        {projects.map((p) => (<option key={p.slug} value={p.slug}>{p.name}</option>))}
      </select>
      <button type="button" aria-label="Manage projects" title="Manage projects" onClick={onManage}
        style={{ height: 32, padding: '0 8px', borderRadius: 6, border: '1px solid var(--tb-border)', background: 'var(--tb-surface)', color: 'var(--tb-text)', fontSize: 13, cursor: 'pointer' }}>
        Manage
      </button>
    </span>
  )
}
```

- [ ] **Step 2: Wire into `__root.tsx`** (RootShell). Mirror the existing `setApp`/`currentApp` pattern:
  - Read current slug: `const currentProject = typeof search.project === 'string' && search.project !== '' ? search.project : undefined;`
  - Add `setProject(slug?: string)`: identical to `setApp` but for `project` (omit key when undefined; `navigate({ to: '.', search: (prev) => ..., replace: true })`). When CHANGING the project, also clear `app` (a service from the old project shouldn't persist). So in `setProject`, drop `app` too: when setting a project, return `{ ...rest-without-app, project: slug }`; when clearing, drop both.
  - `const projectsQuery = useProjects();` then `const projects = projectsQuery.query.data?.projects ?? [];`
  - Narrow the app list: `const selected = projects.find((p) => p.slug === currentProject); const apps = selected ? baseApps.filter((a) => selected.apps.includes(a)) : baseApps;` where `baseApps = Object.keys(eventsQuery.data?.apps ?? {})`.
  - Render `<ProjectSwitcher projects={projects} value={currentProject} onChange={setProject} onManage={() => setManageOpen(true)} />` immediately before `<AppSwitcher ...>` in the right-hand cluster.
  - Add `const [manageOpen, setManageOpen] = useState(false);` and render `<ManageProjectsDialog open={manageOpen} onClose={() => setManageOpen(false)} />` near the SettingsDialog (Task 5 creates it; import it).

- [ ] **Step 3: Add nav links** in `__root.tsx`'s `<nav aria-label="Primary">`, after the Explore link and before Stats, two `<Link>`s mirroring the existing ones:
```tsx
<Link to="/overview" style={navLinkBase} activeProps={{ style: { ...navLinkBase, color: 'var(--tb-text)', background: 'var(--tb-2)' } }}>Overview</Link>
<Link to="/jobs" style={navLinkBase} activeProps={{ style: { ...navLinkBase, color: 'var(--tb-text)', background: 'var(--tb-2)' } }}>Jobs</Link>
```

- [ ] **Step 4: Tests** `web/src/components/ProjectSwitcher.test.tsx` (pure component, no router):
```ts
test('renders All projects + one option per project', () => {
  render(<ProjectSwitcher projects={[{slug:'a',name:'A',apps:[]},{slug:'b',name:'B',apps:[]}]} value={undefined} onChange={() => {}} onManage={() => {}} />)
  expect(screen.getByRole('option', { name: 'All projects' })).toBeInTheDocument()
  expect(screen.getByRole('option', { name: 'A' })).toBeInTheDocument()
})
test('selecting a project emits its slug; selecting all emits undefined', async () => {
  const onChange = vi.fn()
  render(<ProjectSwitcher projects={[{slug:'a',name:'A',apps:[]}]} value={undefined} onChange={onChange} onManage={() => {}} />)
  await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Project' }), 'a')
  expect(onChange).toHaveBeenCalledWith('a')
})
test('Manage button fires onManage', async () => {
  const onManage = vi.fn()
  render(<ProjectSwitcher projects={[]} value={undefined} onChange={() => {}} onManage={onManage} />)
  await userEvent.click(screen.getByRole('button', { name: 'Manage projects' }))
  expect(onManage).toHaveBeenCalled()
})
```
Plus extend `web/src/routes/__root.test.tsx` with one case: when the URL has `?project=acme`, the App switcher only lists that project's apps. (Mirror the existing __root test harness; PROJECTS_RESPONSE.acme has apps `['api','worker']`, EVENTS_RESPONSE has `api`,`worker`,`scheduler`, so the app `<select>` should not contain `scheduler`.)
Run `npx vitest run src/components/ProjectSwitcher.test.tsx src/routes/__root.test.tsx` + `npm run typecheck`.

> NOTE: Task 4 imports `ManageProjectsDialog` (Task 5). Implement Task 5 in the same session OR temporarily stub the import; the controller runs Task 5 immediately after, so prefer doing 4 and 5 back to back and typechecking after 5.

- [ ] **Step 5: Commit**
```bash
git add src/components/ProjectSwitcher.tsx src/components/ProjectSwitcher.test.tsx src/routes/__root.tsx src/routes/__root.test.tsx
git commit -m "feat(console): ProjectSwitcher + shell wiring (URL project scope, narrowed app list, nav)"
```

---

## Task 5: Manage Projects dialog

**Files:** Create `web/src/components/ManageProjectsDialog.tsx`; Test `web/src/components/ManageProjectsDialog.test.tsx`.

Mirror `web/src/components/SettingsDialog.tsx` for the modal scaffold (props `{ open, onClose }`; `if (!open) return null`; overlay `role="presentation"` + panel `role="dialog" aria-modal="true" aria-labelledby`; Escape/Tab focus trap; `useId`). Content uses `useProjects()` + `useEvents()`.

- [ ] **Step 1: Implement** the dialog body:
  - `const { query, create, update, remove } = useProjects();` `const projects = query.data?.projects ?? [];`
  - `const knownApps = Object.keys(useEvents().data?.apps ?? {});`
  - **List** existing projects: each row shows `name`, its `apps` (comma-joined), an **Edit** affordance (inline: load name+apps into the form) and a **Delete** button (`onClick={() => remove.mutate(p.slug)}`, with a confirm via `window.confirm`).
  - **Create/Edit form**: a `name` text input and an apps multi-select. The apps selector: render a checkbox per `knownApps` entry plus a free-text input to add a service name not yet seen (push into local `apps` state). Submit:
    - create mode: `create.mutate({ name, apps })`
    - edit mode (an existing slug loaded): `update.mutate({ slug, name, apps })`
    - on success reset the form. Surface `create.error`/`update.error` (an `ApiError`) inline as a `role="alert"` (e.g. 409 → "A project with that name already exists.").
  - Use `labelStyle`/`fieldStyle`-style local consts like SettingsDialog. Buttons: Close (`onClose`). The dialog stays open after create/delete so the user can manage several.
  - Disable submit while `create.isPending || update.isPending`.

- [ ] **Step 2: Tests** `web/src/components/ManageProjectsDialog.test.tsx` (mirror SettingsDialog.test.tsx + settings mock; MSW serves PROJECTS_RESPONSE by default). Cover:
```ts
// lists existing projects
test('lists projects', async () => {
  render(<ManageProjectsDialog open onClose={() => {}} />, { wrapper })
  expect(await screen.findByText('Acme')).toBeInTheDocument()
})
// create posts and refetches
test('create submits name + apps', async () => {
  let body: unknown
  server.use(http.post('/v1/projects', async ({ request }) => { body = await request.json(); return HttpResponse.json({ slug: 'n', name: 'New', apps: ['api'] }, { status: 201 }) })) // plus a refetch handler
  render(<ManageProjectsDialog open onClose={() => {}} />, { wrapper })
  await userEvent.type(screen.getByLabelText(/name/i), 'New')
  await userEvent.click(screen.getByLabelText('api'))      // a known-app checkbox
  await userEvent.click(screen.getByRole('button', { name: /create|add project/i }))
  await waitFor(() => expect(body).toEqual({ name: 'New', apps: ['api'] }))
})
// delete calls DELETE with slug
test('delete removes a project', async () => {
  let deletedUrl = ''
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  server.use(http.delete('/v1/projects', ({ request }) => { deletedUrl = request.url; return new HttpResponse(null, { status: 204 }) }))
  render(<ManageProjectsDialog open onClose={() => {}} />, { wrapper })
  await userEvent.click((await screen.findAllByRole('button', { name: /delete/i }))[0])
  await waitFor(() => expect(deletedUrl).toContain('slug='))
})
// 409 shows an inline error
test('duplicate name shows an error', async () => {
  server.use(http.post('/v1/projects', () => HttpResponse.json({ error: 'dup' }, { status: 409 })))
  render(<ManageProjectsDialog open onClose={() => {}} />, { wrapper })
  await userEvent.type(screen.getByLabelText(/name/i), 'Acme')
  await userEvent.click(screen.getByRole('button', { name: /create|add project/i }))
  expect(await screen.findByRole('alert')).toHaveTextContent(/already exists/i)
})
```
Run `npx vitest run src/components/ManageProjectsDialog.test.tsx` + `npm run typecheck` (now Task 4's import resolves).

- [ ] **Step 3: Commit**
```bash
git add src/components/ManageProjectsDialog.tsx src/components/ManageProjectsDialog.test.tsx
git commit -m "feat(console): Manage Projects dialog (create/edit/delete services)"
```

---

## Task 6: Project Overview dashboard

**Files:** Create `web/src/routes/overview.tsx`; Modify `web/src/router.tsx`; Test `web/src/routes/overview.test.tsx`.

- [ ] **Step 1: Implement `overview.tsx`** (export `OverviewRoute`). Reads `useSearch({ strict:false })` for `project` (slug) + a stable `last24h()` range (copy `last24h` from explore.tsx or import if exported). Six cards in a `role="list"` grid, each scoped to the selected project (pass `project` into the hooks; when no project, show all):
  - **Errors and warnings**: `useStats(range,'hour',undefined,undefined,project)` → sum of `counts.warn+counts.error` across buckets, plus latest `errorRate`. Card links `to="/"` with `search={{ project, level: 'warn,error' }}`.
  - **AI usage**: from the same stats payload, total `costUsd`, `inputTokens+outputTokens`. Links `to="/stats"` with `search={{ project }}`.
  - **By user**: `useGroupBy(filters, { by: 'ids.userEmail' })` where `filters` includes `project` (build a `Filters` with just `{ project, levels: ALL_LEVELS, ids: [], data: [] }`). Show top 5 `{value,count}`. Link `to="/"` `search={{ project }}`.
  - **By service**: `useGroupBy(filters, { by: 'app' })`. Show the per-service counts. Link `to="/"`.
  - **Slow operations**: `useGroupBy` or a `useLogs` count with a `data` filter `latencyMs gte settings.slowMs`; simplest: build `Filters` with `data:[{path:'data.latencyMs',op:'gte',value:String(slowMs)}]` and use `useLogs(filters)` then show `items.length` (note: capped at limit; label as "recent"). Link `to="/"` with that filter + project.
  - **Cron and Jobs**: `useJobs(range, project)` → counts of ok vs failed jobs, total runs. Link `to="/jobs"` `search={{ project }}`.
  - Reuse `MetricCards`/`StatChart` where natural (e.g. a small volume `StatChart` from the stats buckets), but simple number cards are fine. Each card is a `data-testid="overview-<id>"`.
  - Loading/empty: while a query is `isPending` show a placeholder; if `!hasReadKey` show the same "enter a read key" hint pattern the other routes use.

- [ ] **Step 2: Register route** in `web/src/router.tsx`:
```ts
const overviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/overview',
  component: lazyRouteComponent(() => import('@/routes/overview'), 'OverviewRoute'),
})
```
and add `overviewRoute` to `rootRoute.addChildren([...])`.

- [ ] **Step 3: Tests** `web/src/routes/overview.test.tsx` (mirror stats.test.tsx harness: memory router at `/overview?project=acme`, QueryClient, settings mock with readKey, MSW defaults). Cover:
```ts
test('renders the six lens cards', async () => {
  renderOverview('/overview?project=acme')
  for (const id of ['errors','ai-usage','by-user','by-service','slow-ops','cron']) {
    expect(await screen.findByTestId(`overview-${id}`)).toBeInTheDocument()
  }
})
test('scopes queries to the project slug', async () => {
  const seen: Record<string,string|null> = {}
  server.use(
    http.get('/v1/stats', ({ request }) => { seen.stats = new URL(request.url).searchParams.get('project'); return HttpResponse.json(STATS_RESPONSE) }),
    http.get('/v1/jobs', ({ request }) => { seen.jobs = new URL(request.url).searchParams.get('project'); return HttpResponse.json(JOBS_RESPONSE) }),
  )
  renderOverview('/overview?project=acme')
  await waitFor(() => expect(seen.stats).toBe('acme'))
  await waitFor(() => expect(seen.jobs).toBe('acme'))
})
```
(If charts render, pass explicit `width` or stub ResizeObserver/matchMedia as stats.test.tsx/explore.test.tsx do.) Run `npx vitest run src/routes/overview.test.tsx` + `npm run typecheck`.

- [ ] **Step 4: Commit**
```bash
git add src/routes/overview.tsx src/routes/overview.test.tsx src/router.tsx
git commit -m "feat(console): per-project Overview dashboard (/overview, six lens cards)"
```

---

## Task 7: Jobs dashboard

**Files:** Create `web/src/routes/jobs.tsx`; Modify `web/src/router.tsx`; Test `web/src/routes/jobs.test.tsx`.

- [ ] **Step 1: Implement `jobs.tsx`** (export `JobsRoute`). Reads `useSearch({strict:false})` for `project` + stable `last24h()`. `const q = useJobs(range, project);` Render a table (`<table>` with a caption / `role`): columns Name, Last run (relative or ISO), Status (a badge: ok = neutral, failed = error color, with a text label so it is not color-only), Success rate (`successRate==null ? 'n/a' : Math.round(rate*100)+'%'`), p50/p95 (`==null ? 'n/a' : value+' ms'`), Runs (`runs` with `failures` shown). Each row's Name is a `<Link to="/" search={{ project, event: row.name }}>` so clicking drills into Explore filtered to that job's events. Loading/empty/no-key states like the other routes. `data-testid="jobs-table"`.

- [ ] **Step 2: Register route** in `web/src/router.tsx`:
```ts
const jobsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/jobs',
  component: lazyRouteComponent(() => import('@/routes/jobs'), 'JobsRoute'),
})
```
add `jobsRoute` to `addChildren([...])`.

- [ ] **Step 3: Tests** `web/src/routes/jobs.test.tsx` (mirror stats.test.tsx harness at `/jobs?project=acme`):
```ts
test('renders a row per job with status label', async () => {
  renderJobs('/jobs?project=acme')
  expect(await screen.findByText('cron.report')).toBeInTheDocument()
  expect(screen.getByText('cron.sync')).toBeInTheDocument()
  // failed job shows a text status, not color only
  expect(screen.getAllByText(/failed/i).length).toBeGreaterThanOrEqual(1)
})
test('passes project to /v1/jobs', async () => {
  let seen: string | null = null
  server.use(http.get('/v1/jobs', ({ request }) => { seen = new URL(request.url).searchParams.get('project'); return HttpResponse.json(JOBS_RESPONSE) }))
  renderJobs('/jobs?project=acme')
  await waitFor(() => expect(seen).toBe('acme'))
})
test('clicking a job links to Explore filtered to its event', async () => {
  const { router } = renderJobs('/jobs?project=acme')
  await userEvent.click(await screen.findByRole('link', { name: 'cron.report' }))
  await waitFor(() => expect(router.state.location.search).toContain('event=cron.report'))
})
```
Run `npx vitest run src/routes/jobs.test.tsx` + `npm run typecheck`.

- [ ] **Step 4: Commit**
```bash
git add src/routes/jobs.tsx src/routes/jobs.test.tsx src/router.tsx
git commit -m "feat(console): Jobs dashboard (/jobs) with per-job rollups and drill-in"
```

---

## Task 8: Full verify + build

- [ ] **Step 1:** `npm run typecheck` (clean).
- [ ] **Step 2:** `npm test` (entire Console suite green, including pre-existing tests).
- [ ] **Step 3:** `npm run lint` (clean; fix any new lint).
- [ ] **Step 4:** `npm run build` (production build succeeds; new routes code-split).
- [ ] **Step 5: Commit** any lint fixes:
```bash
git add -A web/src
git commit -m "chore(console): lint + typecheck clean for projects UI"
```

---

## Self-Review

**Spec section 8 coverage:** ProjectSwitcher + URL scope (T4) ✓ · Manage Projects dialog CRUD (T5) ✓ · project narrows AppSwitcher (T4) ✓ · six lenses project-scoped (T2 puts `project` in Filters so useLogs/useGroupBy scope; T3 threads stats/facets/events; Overview composes them T6) ✓ · Project Overview dashboard (T6) ✓ · Jobs dashboard (T7) ✓ · nav gains Overview + Jobs (T4) ✓ · edits via read key (api uses the read key; backend gates on canRead) ✓.

**Backend-contract consistency:** slug-keyed everywhere (`project=<slug>`, PATCH slug-in-body, DELETE `?slug=`), `{slug,name,apps}` shape, `JobRow` fields match `src/query/jobs.js` output. No `_id` used.

**Placeholder scan:** none; novel code is complete, boilerplate references a named mirror file with full interface + test assertions.

**Type/name consistency:** `Project`/`ProjectsResponse`/`JobRow`/`JobsResponse` defined in T1 used identically after; `useProjects()` returns `{ query, create, update, remove }` used in T4/T5; `useJobs(range, project?, app?)` used in T6/T7; `ProjectSwitcher` props match its mount; `project` param name consistent across filters, hooks, api.

**Ordering note:** Task 4 imports the Task 5 component; run T4 then T5 back-to-back and typecheck after T5.
