import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';

import { createRouter } from '../src/http/router.js';
import { readBody } from '../src/http/body.js';
import { sendJson, sendError } from '../src/http/respond.js';

// agent:false ⇒ one connection per request, so a server-side req.destroy()
// in the 413 test can never poison a kept-alive socket reused by later tests.
function request({ port, method = 'GET', path = '/', body = null, headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path, headers, agent: false },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

async function listen(server) {
  server.listen(0);
  await once(server, 'listening');
  return server.address().port;
}

function closeServer(server) {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(resolve));
}

async function waitFor(fn, timeoutMs = 2000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('router', () => {
  let server;
  let port;
  let captured;

  before(async () => {
    const router = createRouter();
    router.add('GET', '/hello', async (req, res, url) => {
      captured = {
        method: req.method,
        isUrl: url instanceof URL,
        host: url.host,
        pathname: url.pathname,
        x: url.searchParams.get('x'),
      };
      sendJson(res, 200, { route: 'get-hello' });
    });
    router.add('POST', '/hello', async (req, res) => {
      sendJson(res, 201, { route: 'post-hello' });
    });
    router.add('GET', '/other', async (req, res) => {
      sendJson(res, 200, { route: 'get-other' });
    });
    server = http.createServer((req, res) => {
      router.dispatch(req, res);
    });
    port = await listen(server);
  });

  after(() => closeServer(server));

  test('dispatches by method + exact pathname', async () => {
    const r1 = await request({ port, method: 'GET', path: '/hello' });
    assert.equal(r1.status, 200);
    assert.deepEqual(JSON.parse(r1.body), { route: 'get-hello' });

    const r2 = await request({ port, method: 'POST', path: '/hello' });
    assert.equal(r2.status, 201);
    assert.deepEqual(JSON.parse(r2.body), { route: 'post-hello' });

    const r3 = await request({ port, method: 'GET', path: '/other' });
    assert.equal(r3.status, 200);
    assert.deepEqual(JSON.parse(r3.body), { route: 'get-other' });
  });

  test('handler receives a parsed URL (base http://localhost) with searchParams', async () => {
    const r = await request({ port, method: 'GET', path: '/hello?x=42' });
    assert.equal(r.status, 200);
    assert.deepEqual(captured, {
      method: 'GET',
      isUrl: true,
      host: 'localhost',
      pathname: '/hello',
      x: '42',
    });
  });

  test('no matching route -> 404 JSON {error:"not found"}', async () => {
    const r = await request({ port, method: 'GET', path: '/nope' });
    assert.equal(r.status, 404);
    assert.match(r.headers['content-type'], /^application\/json/);
    assert.deepEqual(JSON.parse(r.body), { error: 'not found' });
  });

  test('method mismatch on a known pathname -> 404', async () => {
    const r = await request({ port, method: 'DELETE', path: '/hello' });
    assert.equal(r.status, 404);
    assert.deepEqual(JSON.parse(r.body), { error: 'not found' });
  });

  test('exact-pathname only: subpaths and trailing slashes do not match', async () => {
    const sub = await request({ port, method: 'GET', path: '/hello/extra' });
    assert.equal(sub.status, 404);
    const slash = await request({ port, method: 'GET', path: '/hello/' });
    assert.equal(slash.status, 404);
  });
});

describe('readBody', () => {
  let server;
  let port;
  let results;

  before(async () => {
    results = [];
    server = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://localhost');
      const max = Number(url.searchParams.get('max'));
      const result = await readBody(req, max);
      results.push({ result, destroyed: req.destroyed });
      if (result.ok) {
        sendJson(res, 200, {
          len: result.buffer.length,
          isBuffer: Buffer.isBuffer(result.buffer),
          echo: result.buffer.toString('utf8').slice(0, 32),
        });
      } else {
        sendError(res, result.status, 'payload too large');
      }
    });
    port = await listen(server);
  });

  after(() => closeServer(server));

  test('under the limit -> {ok:true, buffer} with full body', async () => {
    const r = await request({ port, method: 'POST', path: '/?max=100', body: 'hello world' });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body), { len: 11, isBuffer: true, echo: 'hello world' });
    const last = results.at(-1);
    assert.equal(last.result.ok, true);
    // no destroyed:false assert here: Node auto-destroys a fully consumed
    // IncomingMessage after 'end'; the delivered 200 proves the socket survived
  });

  test('exactly at the limit is not an overflow', async () => {
    const r = await request({ port, method: 'POST', path: '/?max=5', body: 'abcde' });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body), { len: 5, isBuffer: true, echo: 'abcde' });
  });

  test('empty body -> {ok:true} with empty buffer', async () => {
    const r = await request({ port, method: 'POST', path: '/?max=10', body: null });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body), { len: 0, isBuffer: true, echo: '' });
  });

  test('over the limit -> {ok:false, status:413} and the request is destroyed', async () => {
    const countBefore = results.length;
    let clientError = null;
    try {
      await request({ port, method: 'POST', path: '/?max=1024', body: 'x'.repeat(8192) });
    } catch (err) {
      clientError = err;
    }
    // server destroyed the socket mid-request, so the client never gets a clean response
    assert.ok(clientError, 'client should observe a connection error');
    await waitFor(() => results.length > countBefore);
    const last = results.at(-1);
    assert.deepEqual(last.result, { ok: false, status: 413 });
    assert.equal(last.destroyed, true);
  });

  test('server keeps serving normal requests after an overflow destroy', async () => {
    const r = await request({ port, method: 'POST', path: '/?max=100', body: 'still alive' });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body), { len: 11, isBuffer: true, echo: 'still alive' });
  });
});

describe('respond', () => {
  let server;
  let port;

  before(async () => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      switch (url.pathname) {
        case '/json':
          sendJson(res, 207, { a: 1, nested: { b: 'two' } }, { 'x-extra': 'yes' });
          break;
        case '/json-defaults':
          sendJson(res, 200, { ok: true });
          break;
        case '/error-plain':
          sendError(res, 401, 'unauthorized');
          break;
        case '/error-extra':
          sendError(res, 400, 'invalid event', { index: 3 });
          break;
        default:
          sendError(res, 404, 'not found');
      }
    });
    port = await listen(server);
  });

  after(() => closeServer(server));

  test('sendJson sets status, application/json content-type, custom headers, JSON body, and ends', async () => {
    const r = await request({ port, path: '/json' });
    assert.equal(r.status, 207);
    assert.match(r.headers['content-type'], /^application\/json/);
    assert.equal(r.headers['x-extra'], 'yes');
    assert.deepEqual(JSON.parse(r.body), { a: 1, nested: { b: 'two' } });
  });

  test('sendJson works without the headers argument', async () => {
    const r = await request({ port, path: '/json-defaults' });
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /^application\/json/);
    assert.deepEqual(JSON.parse(r.body), { ok: true });
  });

  test('sendError -> {error: message}', async () => {
    const r = await request({ port, path: '/error-plain' });
    assert.equal(r.status, 401);
    assert.match(r.headers['content-type'], /^application\/json/);
    assert.deepEqual(JSON.parse(r.body), { error: 'unauthorized' });
  });

  test('sendError merges extra fields into the body', async () => {
    const r = await request({ port, path: '/error-extra' });
    assert.equal(r.status, 400);
    assert.deepEqual(JSON.parse(r.body), { error: 'invalid event', index: 3 });
  });
});
