import { sendError } from './respond.js';

export function createRouter() {
  const routes = new Map();
  return {
    add(method, pathname, handler) {
      routes.set(`${method.toUpperCase()} ${pathname}`, handler);
    },
    async dispatch(req, res) {
      const url = new URL(req.url, 'http://localhost');
      const handler = routes.get(`${req.method} ${url.pathname}`);
      if (!handler) {
        sendError(res, 404, 'not found');
        return;
      }
      return handler(req, res, url);
    },
  };
}
