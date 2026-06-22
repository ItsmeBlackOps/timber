// Server-side project registry. A project groups services (the per-key `app`).
// `slug` is the stable, public identifier; the Mongo `_id` (ObjectId) stays
// internal and is never returned. Validation mirrors src/validate.js style.
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

// Validate a create (partial:false) or patch (partial:true) body. Allowed keys
// are exactly { name, apps }. Returns { ok, value } | { ok:false, error }.
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

const toView = (doc) => ({ slug: doc.slug, name: doc.name, apps: doc.apps ?? [] });

export async function ensureProjectIndexes(collection) {
  await collection.createIndexes([
    { key: { slug: 1 }, unique: true },
    { key: { nameLower: 1 }, unique: true },
  ]);
}

export async function listProjects(collection, { maxTimeMS } = {}) {
  let cursor = collection.find({}).sort({ nameLower: 1 });
  if (Number.isFinite(maxTimeMS) && maxTimeMS > 0) cursor = cursor.maxTimeMS(maxTimeMS);
  return (await cursor.toArray()).map(toView);
}

async function uniqueSlug(collection, base) {
  const root = base || 'project';
  let slug = root;
  for (let n = 2; ; n++) {
    const clash = await collection.findOne({ slug }, { projection: { _id: 1 } });
    if (!clash) return slug;
    slug = `${root}-${n}`;
  }
}

export async function createProject(collection, input, { now }) {
  const slug = await uniqueSlug(collection, slugify(input.name));
  const nowIso = now().toISOString();
  const doc = {
    slug,
    name: input.name,
    nameLower: input.name.toLowerCase(),
    apps: input.apps ?? [],
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  try {
    await collection.insertOne(doc);
  } catch (err) {
    if (err && err.code === 11000) return { ok: false, conflict: true };
    throw err;
  }
  return { ok: true, value: toView(doc) };
}

export async function updateProject(collection, slug, patch, { now }) {
  const existing = await collection.findOne({ slug });
  if (!existing) return { ok: false, notFound: true };
  const set = { updatedAt: now().toISOString() };
  if (patch.name !== undefined) {
    set.name = patch.name;
    set.nameLower = patch.name.toLowerCase();
  }
  if (patch.apps !== undefined) set.apps = patch.apps;
  let res;
  try {
    res = await collection.updateOne({ slug }, { $set: set });
  } catch (err) {
    if (err && err.code === 11000) return { ok: false, conflict: true };
    throw err;
  }
  // The doc may have been deleted between the findOne and the updateOne (race); a
  // zero match means not-found, so do not return stale merged data.
  if (res.matchedCount === 0) return { ok: false, notFound: true };
  return { ok: true, value: toView({ ...existing, ...set }) };
}

export async function deleteProject(collection, slug) {
  const res = await collection.deleteOne({ slug });
  return res.deletedCount > 0;
}

// Resolve a slug to its member apps for query scoping. Returns the apps array
// (possibly empty) or null when the slug is unknown.
export async function resolveProjectApps(collection, slug, { maxTimeMS } = {}) {
  const opts = { projection: { apps: 1 } };
  if (Number.isFinite(maxTimeMS) && maxTimeMS > 0) opts.maxTimeMS = maxTimeMS;
  const doc = await collection.findOne({ slug }, opts);
  if (!doc) return null;
  return doc.apps ?? [];
}
