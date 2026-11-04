import { parseCookies, readSession } from './auth.js';

export class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}
export const bad = (m, extra) => new HttpError(400, m, extra);
export const notFound = (m = 'Not found') => new HttpError(404, m);
export const forbidden = (m = 'You do not have permission to do that') => new HttpError(403, m);

const routes = [];
export function route(method, pattern, handler, opts = {}) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
  (keys.length ? routes.push.bind(routes) : routes.unshift.bind(routes))({ method, re, keys, handler, opts });
}
export const GET = (p, h, o) => route('GET', p, h, o);
export const POST = (p, h, o) => route('POST', p, h, o);
export const PUT = (p, h, o) => route('PUT', p, h, o);
export const DELETE = (p, h, o) => route('DELETE', p, h, o);

export async function readBody(req, limit = 8 * 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > limit) throw new HttpError(413, 'Payload too large'); chunks.push(c); }
  return Buffer.concat(chunks).toString('utf8');
}

export async function handleApi(req, res, url) {
  const send = (status, data, headers = {}) => {
    const body = JSON.stringify(data);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(body);
  };
  try {
    const user = readSession(parseCookies(req.headers.cookie).ovantaa_session);
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(url.pathname);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      if (!r.opts.public && !user) throw new HttpError(401, 'Authentication required');
      if (r.opts.roles && !r.opts.roles.includes(user.role)) throw forbidden();
      let body = {};
      if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
        const raw = await readBody(req);
        if (raw && !(req.headers['content-type'] || '').includes('application/json')) throw new HttpError(415, 'Content-Type must be application/json');
        if (!raw && !req.headers['content-type']?.includes('application/json') && req.headers['content-length'] !== '0' && req.headers['content-length'] !== undefined) throw new HttpError(415, 'Content-Type must be application/json');
        try { body = raw ? JSON.parse(raw) : {}; } catch { throw bad('Invalid JSON body'); }
      }
      const ctx = { req, res, user, params, body, query: Object.fromEntries(url.searchParams), url, send };
      const out = await r.handler(ctx);
      if (out !== undefined && !res.writableEnded) send(200, out);
      return;
    }
    throw notFound('Unknown API endpoint');
  } catch (e) {
    if (e instanceof HttpError) return send(e.status, { error: e.message, ...(e.extra || {}) });
    if (String(e?.message).includes('UNIQUE constraint failed')) return send(409, { error: 'A record with that value already exists' });
    if (String(e?.message).includes('CHECK constraint failed')) return send(400, { error: 'Invalid value for a restricted field' });
    console.error(e);
    send(500, { error: 'Internal server error' });
  }
}
