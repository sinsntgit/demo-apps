import { GET, POST, bad } from './http.js';
import { get } from './db.js';
import { hasPerm, scopeOf } from './permissions.js';

/*
 * Live updates over Server-Sent Events: one long-lived GET /api/live per open browser tab.
 *  - "changed": a record was created/updated/deleted by someone → open pages refresh, edit forms warn
 *  - "presence": who is viewing / editing a record right now
 * Everything is filtered by the receiving user's permissions (own/all scope) before it is sent.
 */
const ENTITIES = ['contacts', 'accounts', 'deals', 'tasks'];
const clients = new Set(); // { res, user, sessionId }
const presence = new Map(); // `${entity}:${id}` -> Map(userId -> { name, mode, until })
const PRESENCE_TTL = 45_000;

function canSee(user, entity, rec) {
  if (!ENTITIES.includes(entity) || !hasPerm(user, `${entity}.view`)) return false;
  if (scopeOf(user, `${entity}.view`) !== 'own' || !rec) return true;
  return rec.owner_id === user.id || (entity === 'tasks' && rec.assigned_by === user.id);
}
const write = (c, event, data) => { try { c.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { clients.delete(c); } };

/** Tell every open tab (that may see it) that a record changed. `rec` is the row (after the change, or before a delete). */
export function publishChange(entity, rec, actor, action = 'updated') {
  if (!rec?.id) return;
  const data = { entity, id: rec.id, action, version: rec.version ?? null, by: actor?.name || null, by_id: actor?.id ?? null, at: new Date().toISOString() };
  for (const c of clients) if (canSee(c.user, entity, rec)) write(c, 'changed', data);
}
function presenceList(key) {
  const m = presence.get(key); if (!m) return [];
  const now = Date.now(); for (const [uid, p] of m) if (p.until < now) m.delete(uid);
  return [...m.entries()].map(([uid, p]) => ({ user_id: uid, name: p.name, mode: p.mode }));
}
function publishPresence(entity, id) {
  const rec = get(`SELECT id, owner_id${entity === 'tasks' ? ', assigned_by' : ''} FROM ${entity} WHERE id=?`, id);
  const data = { entity, id: Number(id), people: presenceList(`${entity}:${id}`) };
  for (const c of clients) if (canSee(c.user, entity, rec)) write(c, 'presence', data);
}

GET('/api/live', ({ req, res, user }) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 5000\n\n');
  const c = { res, user, sessionId: user.session_id }; clients.add(c);
  const ping = setInterval(() => {
    // stop streaming to a session that was signed out or revoked
    const s = get('SELECT revoked_at FROM sessions WHERE id=?', c.sessionId);
    if (!s || s.revoked_at) { clearInterval(ping); clients.delete(c); return res.end(); }
    write(c, 'ping', { t: Date.now() });
  }, 25_000);
  ping.unref?.();
  req.on('close', () => { clearInterval(ping); clients.delete(c); });
});

/** Heartbeat from a record page or edit form: { entity, id, mode: 'viewing' | 'editing' | 'left' }. */
POST('/api/live/presence', ({ body, user }) => {
  const entity = String(body.entity || ''), id = Number(body.id), mode = body.mode;
  if (!ENTITIES.includes(entity) || !id) throw bad('Unknown record');
  if (!['viewing', 'editing', 'left'].includes(mode)) throw bad('Unknown mode');
  const rec = get(`SELECT id, owner_id${entity === 'tasks' ? ', assigned_by' : ''} FROM ${entity} WHERE id=?`, id);
  if (!rec || !canSee(user, entity, rec)) throw bad('Unknown record');
  const key = `${entity}:${id}`; if (!presence.has(key)) presence.set(key, new Map());
  const m = presence.get(key); const before = JSON.stringify(presenceList(key));
  if (mode === 'left') m.delete(user.id); else m.set(user.id, { name: user.name, mode, until: Date.now() + PRESENCE_TTL });
  const people = presenceList(key);
  if (JSON.stringify(people) !== before) publishPresence(entity, id);
  return { people };
});
export const liveClientCount = () => clients.size;
// people who closed a tab without saying goodbye drop off after PRESENCE_TTL
const seen = new Map();
setInterval(() => {
  for (const key of presence.keys()) {
    const now = JSON.stringify(presenceList(key));
    if (seen.get(key) !== now) { seen.set(key, now); const [entity, id] = key.split(':'); publishPresence(entity, id); }
    if (now === '[]') { presence.delete(key); seen.delete(key); }
  }
}, 15_000).unref?.();
