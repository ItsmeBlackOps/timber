// Server-side project registry (SQL port of src/projects.js). A project groups
// services (the per-key `app`). `slug` is the stable public id; `name_lower`
// enforces case-insensitive name uniqueness. Validation is ported verbatim.
import { db } from './db.js';

const NAME_MAX = 80;
const APPS_MAX = 200;
const APP_MAX_CHARS = 128;

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const invalid = (error) => ({ ok: false, error });

export function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, NAME_MAX);
}

export function validateProjectInput(raw, { partial = false } = {}) {
  if (!isPlainObject(raw)) return invalid('project body must be a JSON object');
  for (const key of Object.keys(raw)) {
    if (key !== 'name' && key !== 'apps') return invalid(`unknown key "${key}"`);
  }
  const value = {};
  if (raw.name !== undefined) {
    if (typeof raw.name !== 'string') return invalid('name must be a string');
    const name = raw.name.trim();
    if (name.length === 0) return invalid('name must be a non-empty string');
    if (name.length > NAME_MAX) return invalid(`name exceeds ${NAME_MAX} chars`);
    value.name = name;
  } else if (!partial) {
    return invalid('name is required');
  }
  if (raw.apps !== undefined) {
    if (!Array.isArray(raw.apps)) return invalid('apps must be an array of strings');
    if (raw.apps.length > APPS_MAX) return invalid(`apps exceeds ${APPS_MAX} entries`);
    const apps = [];
    for (const a of raw.apps) {
      if (typeof a !== 'string' || a.length === 0) return invalid('each app must be a non-empty string');
      if (a.length > APP_MAX_CHARS) return invalid(`app name exceeds ${APP_MAX_CHARS} chars`);
      if (!apps.includes(a)) apps.push(a);
    }
    value.apps = apps;
  } else if (!partial) {
    value.apps = [];
  }
  return { ok: true, value };
}

const toView = (r) => ({ slug: r.slug, name: r.name, apps: r.apps ?? [] });

export async function listProjects() {
  const sql = db();
  const rows = await sql`SELECT slug, name, apps FROM projects ORDER BY name_lower ASC`;
  return rows.map(toView);
}

async function uniqueSlug(sql, base) {
  const root = base || 'project';
  let slug = root;
  for (let n = 2; ; n++) {
    const clash = await sql`SELECT 1 FROM projects WHERE slug = ${slug}`;
    if (clash.length === 0) return slug;
    slug = `${root}-${n}`;
  }
}

export async function createProject(input, { now }) {
  const sql = db();
  const nowIso = now().toISOString();
  const apps = input.apps ?? [];
  // Two concurrent creates whose names slugify to the same base can both probe a
  // free slug and then collide on the slug PK (which ON CONFLICT name_lower does
  // not cover). That collision is transient, so recompute the slug and retry; a
  // genuine duplicate name still resolves to conflict via ON CONFLICT name_lower.
  for (let attempt = 0; attempt < 5; attempt++) {
    const slug = await uniqueSlug(sql, slugify(input.name));
    try {
      const rows = await sql`
        INSERT INTO projects (slug, name, name_lower, apps, created_at, updated_at)
        VALUES (${slug}, ${input.name}, ${input.name.toLowerCase()}, ${apps}, ${nowIso}, ${nowIso})
        ON CONFLICT (name_lower) DO NOTHING
        RETURNING slug, name, apps`;
      if (rows.length === 0) return { ok: false, conflict: true };
      return { ok: true, value: toView(rows[0]) };
    } catch (err) {
      if (err && err.code === '23505') continue; // slug race: recompute + retry
      throw err;
    }
  }
  return { ok: false, conflict: true };
}

export async function updateProject(slug, patch, { now }) {
  const sql = db();
  const nowIso = now().toISOString();
  const name = patch.name ?? null;
  const nameLower = name === null ? null : name.toLowerCase();
  const apps = patch.apps ?? null;
  try {
    const rows = await sql`
      UPDATE projects SET
        name = COALESCE(${name}, name),
        name_lower = COALESCE(${nameLower}, name_lower),
        apps = COALESCE(${apps}, apps),
        updated_at = ${nowIso}
      WHERE slug = ${slug}
      RETURNING slug, name, apps`;
    if (rows.length === 0) return { ok: false, notFound: true };
    return { ok: true, value: toView(rows[0]) };
  } catch (err) {
    if (err && err.code === '23505') return { ok: false, conflict: true };
    throw err;
  }
}

export async function deleteProject(slug) {
  const sql = db();
  const rows = await sql`DELETE FROM projects WHERE slug = ${slug} RETURNING slug`;
  return rows.length > 0;
}

// Resolve a slug to its member apps for query scoping; null when unknown.
export async function resolveProjectApps(slug) {
  const sql = db();
  const rows = await sql`SELECT apps FROM projects WHERE slug = ${slug}`;
  if (rows.length === 0) return null;
  return rows[0].apps ?? [];
}

// Read handler helper: pop `project` from the query params and resolve it to an
// app scope. Returns undefined when no project is given (no constraint), or an
// app array ([] when the slug is unknown => matches nothing, mirroring Mongo).
export async function resolveScope(sp) {
  if (!sp.has('project')) return undefined;
  const slug = sp.get('project');
  sp.delete('project');
  const apps = await resolveProjectApps(slug);
  return apps === null ? [] : apps;
}
