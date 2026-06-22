// /v1/projects — CRUD over the projects table. GET needs a read key; mutations
// need a write key. Mirrors the Console's api.ts contract: POST body {name,apps};
// PATCH body {slug,name?,apps?} (slug in the body); DELETE ?slug=... (query).
import { json, badRequest, methodNotAllowed, readJson } from '../_lib/respond.js';
import { requireRead, requireWrite } from '../_lib/auth.js';
import {
  listProjects,
  createProject,
  updateProject,
  deleteProject,
  validateProjectInput,
} from '../_lib/projects.js';

const now = () => new Date();
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

async function list(req, res) {
  if (!requireRead(req, res)) return;
  return json(res, 200, { projects: await listProjects() });
}

async function create(req, res) {
  if (!requireWrite(req, res)) return;
  const body = await readJson(req);
  if (!body.ok) return badRequest(res, 'invalid or empty JSON body');
  const v = validateProjectInput(body.value, { partial: false });
  if (!v.ok) return badRequest(res, v.error);
  const r = await createProject(v.value, { now });
  if (!r.ok) return json(res, 409, { error: 'a project with that name already exists' });
  return json(res, 201, r.value);
}

async function patch(req, res) {
  if (!requireWrite(req, res)) return;
  const body = await readJson(req);
  if (!body.ok) return badRequest(res, 'invalid or empty JSON body');
  if (!isObject(body.value)) return badRequest(res, 'project body must be a JSON object');
  const { slug, ...rest } = body.value;
  if (typeof slug !== 'string' || slug.length === 0) return badRequest(res, 'slug is required');
  const v = validateProjectInput(rest, { partial: true });
  if (!v.ok) return badRequest(res, v.error);
  const r = await updateProject(slug, v.value, { now });
  if (r.notFound) return json(res, 404, { error: 'project not found' });
  if (r.conflict) return json(res, 409, { error: 'a project with that name already exists' });
  return json(res, 200, r.value);
}

async function remove(req, res) {
  if (!requireWrite(req, res)) return;
  const slug = new URL(req.url, 'http://localhost').searchParams.get('slug');
  if (!slug) return badRequest(res, 'slug is required');
  const ok = await deleteProject(slug);
  if (!ok) return json(res, 404, { error: 'project not found' });
  res.statusCode = 204;
  return res.end();
}

export default async function handler(req, res) {
  switch (req.method) {
    case 'GET':
      return list(req, res);
    case 'POST':
      return create(req, res);
    case 'PATCH':
      return patch(req, res);
    case 'DELETE':
      return remove(req, res);
    default:
      return methodNotAllowed(res, 'GET, POST, PATCH, DELETE');
  }
}
