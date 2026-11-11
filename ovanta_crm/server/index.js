import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { db, get, run, nowIso } from './db.js';
import { handleApi, readBody } from './http.js';
import './api.js';
import './api2.js';
import './api3.js';
import './api4.js';
import './api5.js';
import './api6.js';
import './leads.js';
import { servePublicFile } from './files.js';
import './search.js';
import './live.js';
import { portalGet, portalClaim } from './api3.js';
import { recordEvent, signUrl, startScheduler } from './campaigns.js';
import { seedIfEmpty } from './seed.js';
import { purgeOldSessions } from './auth.js';

const PUB = path.join(config.root, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const SEC = {
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-src 'self'; frame-ancestors 'none'; form-action 'self'",
};

const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:system-ui,Arial,sans-serif;background:#f3f4f8;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
.c{background:#fff;border-radius:14px;padding:36px;max-width:420px;box-shadow:0 8px 30px rgba(20,20,60,.1);text-align:center}h1{font-size:20px;margin:0 0 8px}p{color:#555;line-height:1.5}
button{background:#4f46e5;color:#fff;border:0;border-radius:8px;padding:10px 20px;font-size:15px;cursor:pointer}</style></head><body><div class="c">${body}</div></body></html>`;

async function handlePublic(req, res, url) {
  let m;
  if ((m = url.pathname.match(/^\/t\/o\/([\w-]+)\.gif$/))) {
    recordEvent(m[1], 'open');
    res.writeHead(200, { 'Content-Type': 'image/gif', 'Cache-Control': 'no-store, max-age=0', 'Content-Length': PIXEL.length });
    return res.end(PIXEL);
  }
  if ((m = url.pathname.match(/^\/t\/c\/([\w-]+)$/))) {
    const target = url.searchParams.get('u') || '', sig = url.searchParams.get('s') || '';
    if (!/^https?:\/\//i.test(target) || sig !== signUrl(m[1], target)) { res.writeHead(400); return res.end('Invalid link'); }
    recordEvent(m[1], 'click', target);
    res.writeHead(302, { Location: target, 'Cache-Control': 'no-store' });
    return res.end();
  }
  if ((m = url.pathname.match(/^\/u\/([\w-]+)$/))) {
    const r = m[1] === 'preview' ? { email: 'preview@example.com' } : get('SELECT * FROM campaign_recipients WHERE token=?', m[1]);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (!r) { res.writeHead(404); return res.end(page('Not found', '<h1>Link not recognised</h1><p>This unsubscribe link is invalid or has expired.</p>')); }
    const masked = r.email.replace(/^(.).*(@.*)$/, '$1•••$2');
    if (req.method === 'POST') {
      if (m[1] !== 'preview') {
        if (!r.unsubscribed_at) {
          run('UPDATE campaign_recipients SET unsubscribed_at=? WHERE id=?', nowIso(), r.id);
          run("INSERT INTO campaign_events (campaign_id,recipient_id,type) VALUES (?,?,'unsubscribe')", r.campaign_id, r.id);
        }
        if (r.contact_id) run('UPDATE contacts SET subscribed=0 WHERE id=?', r.contact_id);
      }
      res.writeHead(200); return res.end(page('Unsubscribed', `<h1>You're unsubscribed</h1><p>${masked} will no longer receive marketing email from us.</p>`));
    }
    res.writeHead(200);
    return res.end(page('Unsubscribe', `<h1>Unsubscribe</h1><p>Stop sending marketing email to <b>${masked}</b>?</p><form method="post" action="/u/${m[1]}"><button>Yes, unsubscribe me</button></form>`));
  }
  if ((m = url.pathname.match(/^\/f\/(\d+)\/(\d+)\/([\w-]+)(?:\/[^/]*)?$/)) && req.method === 'GET') {
    if (!servePublicFile(res, m[1], m[2], m[3])) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('This file link is invalid or has expired.'); }
    return;
  }
  if ((m = url.pathname.match(/^\/pay\/([\w-]+)$/)) && req.method === 'GET') {
    const r = await portalGet(m[1], url.searchParams);
    res.writeHead(r.status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' }); return res.end(r.html);
  }
  if ((m = url.pathname.match(/^\/pay\/([\w-]+)\/claim$/)) && req.method === 'POST') {
    const form = new URLSearchParams(await readBody(req, 8192).catch(() => ''));
    const r = portalClaim(m[1], form, req.socket.remoteAddress || '?');
    if (r.status === 404) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(303, { Location: r.redirect }); return res.end();
  }
  return false;
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' ) rel = '/index.html';
  const file = path.normalize(path.join(PUB, rel));
  if (!file.startsWith(PUB + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) {
      if (path.extname(rel)) { res.writeHead(404); return res.end('Not found'); }
      return fs.readFile(path.join(PUB, 'index.html'), (e2, d2) => { res.writeHead(200, { 'Content-Type': MIME['.html'] }); res.end(d2); });
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

export const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SEC)) res.setHeader(k, v);
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (/^\/(t|u)\//.test(url.pathname) && req.method === 'POST') await readBody(req, 1024).catch(() => {});
    if (/^\/(t|u|pay|f)\//.test(url.pathname)) { if (await handlePublic(req, res, url) !== false) return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    serveStatic(req, res, url);
  } catch (e) { console.error(e); if (!res.headersSent) res.writeHead(500); res.end('Server error'); }
});

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  seedIfEmpty();
  startScheduler(); purgeOldSessions(); setInterval(purgeOldSessions, 6 * 3600 * 1000).unref();
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') console.error(`\nPort ${config.port} is already in use — Ovantaa (or another program) is probably still running.\n  • Close the other window where "npm start" is running (or press Ctrl+C there), then try again, or\n  • start on another port:  PowerShell: $env:PORT=3001; npm start    macOS/Linux: PORT=3001 npm start\n`);
    else console.error('Could not start the server:', e.message);
    db.close(); process.exit(1);
  });
  server.listen(config.port, () => console.log(`Ovantaa CRM v${config.version} running at ${config.baseUrl}  (mail transport: ${config.mailTransport})`));
  process.on('SIGTERM', () => { server.close(); db.close(); process.exit(0); });
}
