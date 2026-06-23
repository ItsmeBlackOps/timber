// Neon serverless HTTP client. The neon() tagged-template function is stateless
// per query (one HTTPS round trip), so there is no pool to manage in a Vercel
// function. Constructed lazily so importing this module from a pure builder unit
// test never requires DATABASE_URL; neon() runs only on first real use.
import { neon } from '@neondatabase/serverless';

let _sql;

export function db() {
  if (!_sql) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set');
    _sql = neon(url);
  }
  return _sql;
}
