// Request-level auth: wraps the keyring with the read/write gate and a 401
// response. The keyring is built once per cold start from TIMBER_KEYS.
import { createKeyring, canRead, canWrite } from './keyring.js';
import { loadKeys } from './env.js';
import { json } from './respond.js';

let ring;
const keyring = () => (ring ??= createKeyring(loadKeys()));

export function requireRead(req, res) {
  const p = keyring().authenticate(req.headers.authorization);
  if (!canRead(p)) {
    json(res, 401, { error: 'unauthorized' });
    return null;
  }
  return p;
}

export function requireWrite(req, res) {
  const p = keyring().authenticate(req.headers.authorization);
  if (!canWrite(p)) {
    json(res, 401, { error: 'unauthorized' });
    return null;
  }
  return p;
}
