// Minimal JSON response helpers for the Vercel Node functions (req, res).

export const json = (res, status, body) => {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
};

export const badRequest = (res, error) => json(res, 400, { error });
export const methodNotAllowed = (res, allow) => {
  res.setHeader('allow', allow);
  return json(res, 405, { error: 'method not allowed' });
};

// Parse a JSON body whether Vercel pre-parsed it (object), handed us a string,
// or left it unread (stream). Returns { ok, value } | { ok:false }.
export async function readJson(req) {
  if (req.body !== undefined && req.body !== null && typeof req.body === 'object') {
    return { ok: true, value: req.body };
  }
  let raw = req.body;
  if (typeof raw !== 'string') {
    raw = await new Promise((resolve) => {
      let buf = '';
      req.on('data', (c) => (buf += c));
      req.on('end', () => resolve(buf));
      req.on('error', () => resolve(''));
    });
  }
  if (raw === '') return { ok: false };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false };
  }
}
