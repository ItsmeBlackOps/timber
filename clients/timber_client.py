"""Tiny Timber log client (Python, stdlib only).

POSTs batched events to a Vercel-hosted Timber at ${TIMBER_URL}/v1/logs with a
write key. It drops heartbeat noise, gates by level, batches, applies
backpressure, and never raises into the caller: a logging failure must not crash
the app. This is the defense that prevents the heartbeat-flood CPU spike.

Env:
  TIMBER_URL         e.g. https://your-app.vercel.app
  TIMBER_WRITE_KEY   a write-mode key from TIMBER_KEYS
  LOG_MIN_LEVEL      debug|info|warn|error (default info)

Usage:
  from timber_client import log, flush
  log("user.signup", level="info", message="new user", ids={"userId": "u1"})
  log("ai.call", data={"model": "claude", "inputTokens": 800,
                       "outputTokens": 120, "costUsd": 0.004, "latencyMs": 950})
  flush()  # optional; a background thread flushes every few seconds
"""
import json
import os
import re
import threading
import urllib.request

_LEVELS = {"debug": 10, "info": 20, "warn": 30, "error": 40}
_DROP = [
    re.compile(r"no message \(still listening\)", re.I),
    re.compile(r"heartbeat", re.I),
    re.compile("⏳"),  # the hourglass the firehook heartbeat used
]
_MAX_BATCH = 50
_MAX_BUFFER = 1000


class TimberClient:
    def __init__(self, url=None, key=None, min_level=None, flush_interval=2.0):
        self.url = (url or os.environ.get("TIMBER_URL", "")).rstrip("/")
        self.key = key or os.environ.get("TIMBER_WRITE_KEY", "")
        level_name = (min_level or os.environ.get("LOG_MIN_LEVEL", "info")).lower()
        self.min_level = _LEVELS.get(level_name, 20)
        self.flush_interval = flush_interval
        self._buf = []
        self._lock = threading.Lock()
        self._stop = threading.Event()
        if self.url and self.key:
            t = threading.Thread(target=self._loop, daemon=True)
            t.start()

    def log(self, event, level="info", message=None, ids=None, data=None, ts=None):
        if _LEVELS.get(level, 20) < self.min_level:
            return
        haystack = "%s %s" % (event, message or "")
        if any(p.search(haystack) for p in _DROP):
            return
        ev = {"event": event, "level": level}
        if message is not None:
            ev["message"] = message
        if ids:
            ev["ids"] = ids
        if data:
            ev["data"] = data
        if ts:
            ev["ts"] = ts
        with self._lock:
            if len(self._buf) >= _MAX_BUFFER:
                self._buf.pop(0)  # backpressure: drop the oldest
            self._buf.append(ev)

    def _loop(self):
        while not self._stop.wait(self.flush_interval):
            self.flush()

    def flush(self):
        with self._lock:
            if not self._buf:
                return
            batch = self._buf[:_MAX_BATCH]
            self._buf = self._buf[_MAX_BATCH:]
        try:
            req = urllib.request.Request(
                self.url + "/v1/logs",
                data=json.dumps(batch).encode("utf-8"),
                headers={
                    "content-type": "application/json",
                    "authorization": "Bearer " + self.key,
                },
                method="POST",
            )
            urllib.request.urlopen(req, timeout=5).read()
        except Exception:
            pass  # never raise into the caller

    def close(self):
        self._stop.set()
        self.flush()


_client = None


def get_client():
    global _client
    if _client is None:
        _client = TimberClient()
    return _client


def log(event, **kwargs):
    get_client().log(event, **kwargs)


def flush():
    get_client().flush()
