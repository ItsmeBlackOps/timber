// GET /v1/jobs — per-job rollups (runs, failures, success rate, latency p50/p95).
import { json, badRequest, methodNotAllowed } from '../_lib/respond.js';
import { requireRead } from '../_lib/auth.js';
import { parseJobsQuery, runJobs } from '../_lib/sql/jobs.js';
import { jobPrefixes } from '../_lib/env.js';
import { resolveScope } from '../_lib/projects.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
  if (!requireRead(req, res)) return;
  const sp = new URL(req.url, 'http://localhost').searchParams;
  const apps = await resolveScope(sp);
  const parsed = parseJobsQuery(sp);
  if (!parsed.ok) return badRequest(res, parsed.error);
  const result = await runJobs(parsed.value, jobPrefixes(), apps);
  return json(res, 200, result);
}
