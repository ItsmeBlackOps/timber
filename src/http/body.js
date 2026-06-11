// Overflow check is strictly greater-than: a body of exactly maxBytes is accepted.
// On overflow the request (and its socket) is destroyed, so the caller's error
// response is silently dropped by node:http — that is fine: the client already
// sees a reset, and not reading the rest of the body is the point.
export async function readBody(req, maxBytes) {
  return new Promise((resolve) => {
    const chunks = [];
    let received = 0;
    let settled = false;

    function finish(result) {
      if (settled) return;
      settled = true;
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onAborted);
      req.off('close', onAborted);
      resolve(result);
    }

    function onData(chunk) {
      received += chunk.length;
      if (received > maxBytes) {
        req.destroy();
        finish({ ok: false, status: 413 });
        return;
      }
      chunks.push(chunk);
    }

    function onEnd() {
      finish({ ok: true, buffer: Buffer.concat(chunks) });
    }

    // 'error'/'close' before 'end' = client went away mid-body. Resolve the
    // contract's failure shape rather than reject: the caller's write to the
    // dead socket is a no-op, and the promise must never hang.
    function onAborted() {
      finish({ ok: false, status: 413 });
    }

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onAborted);
    req.on('close', onAborted);
  });
}
