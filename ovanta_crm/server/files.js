import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import busboy from 'busboy';
import { GET, POST, PUT, DELETE, HttpError, bad, notFound, forbidden } from './http.js';
import { all, get, run, audit } from './db.js';
import { config } from './config.js';
import { ENTITIES, STAGES, getOne } from './entities.js';
import { hasPerm, canOnRecord } from './permissions.js';
import { hmac } from './auth.js';

const KINDS = ['contacts', 'accounts', 'deals', 'invoices'];
const MAX_FILES = 20;
const BLOCKED = /\.(exe|dll|bat|cmd|com|scr|msi|ps1|vbs|js|jse|jar|sh|app|apk|dmg|lnk|hta|cpl|reg)$/i;
// what the browser may show inline; everything else is a download
const MEDIA = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'video/mp4', 'video/webm', 'audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/wav', 'audio/webm']);
const TEXTLIKE = /^(text\/|application\/(json|xml|x-yaml|yaml)|image\/svg\+xml)/; // shown as plain text (never rendered as HTML/SVG)
const TEXT_EXT = /\.(txt|csv|tsv|log|md|json|xml|ya?ml|ini|conf|html?|svg)$/i;
const BY_EXT = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', wav: 'audio/wav',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', csv: 'text/csv', txt: 'text/plain' };
/** Browsers often send application/octet-stream; fall back to the extension for known types. */
const mimeFor = (name, sent) => { const s = String(sent || '').toLowerCase().slice(0, 100); if (s && s !== 'application/octet-stream') return s; return BY_EXT[String(name).split('.').pop().toLowerCase()] || 'application/octet-stream'; };

/** The record must exist and be visible to this user. Invoices are not an `ENTITIES` row, so they follow the invoices permission. */
function guardRecord(kind, id, user, needEdit = false) {
  if (!KINDS.includes(kind)) throw bad('Unknown record type');
  id = Number(id); if (!id) throw bad('Missing record');
  if (kind === 'invoices') { if (!get('SELECT 1 FROM invoices WHERE id=?', id)) throw notFound('Record not found'); if (!hasPerm(user, 'invoices.view')) throw forbidden(); return null; }
  const r = getOne(ENTITIES[kind], id, user);
  if (needEdit && !canOnRecord(user, `${kind}.edit`, r.owner_id)) throw forbidden(`Your role can only add files to ${kind} you own.`);
  return r;
}
export const canSeeRecord = (kind, id, user) => { try { guardRecord(kind, id, user); return true; } catch { return false; } };
const safeName = (n) => String(n || 'file').replace(/[\\/\0]/g, '_').replace(/[\r\n"]/g, '').trim().slice(0, 200) || 'file';
/** A name that is valid on Windows, macOS and Linux disks. */
const diskName = (n) => safeName(n).replace(/[<>:"|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').slice(0, 120) || 'file';
const checkStage = (kind, stage) => {
  if (stage === undefined || stage === null || stage === '') return null;
  if (kind !== 'deals') throw bad('Stage folders exist only on deals');
  if (!STAGES.some((s) => s.key === stage)) throw bad('Unknown stage');
  return stage;
};
const folderOf = (f) => `${f.entity}/${f.record_id}/${f.stage || 'general'}`;
const out = (f) => ({ id: f.id, entity: f.entity, record_id: f.record_id, stage: f.stage || null, folder: folderOf(f), name: f.name, mime: f.mime, size: f.size, note: f.note, uploaded_by_name: f.uploaded_by_name, created_at: f.created_at, sha256: f.sha256 });
const absPath = (rel) => { const p = path.resolve(config.filesDir, rel); if (!p.startsWith(path.resolve(config.filesDir) + path.sep)) throw notFound(); return p; };

GET('/api/files', ({ query, user }) => {
  guardRecord(query.entity, query.id, user);
  return all('SELECT * FROM files WHERE entity=? AND record_id=? ORDER BY id DESC', query.entity, Number(query.id)).map(out);
});

/**
 * Upload one or more files (multipart, field name "file", up to 20 per request) to a record.
 * On deals, `?stage=` puts them in that stage's folder. Stored on disk as files/<entity>/<id>/<stage|general>/<hash>-<name>.
 */
POST('/api/files', ({ req, query, user }) => new Promise((resolve, reject) => {
  let stage;
  try { guardRecord(query.entity, query.id, user, true); stage = checkStage(query.entity, query.stage); } catch (e) { req.resume(); return reject(e); }
  const ct = req.headers['content-type'] || ''; if (!ct.startsWith('multipart/form-data')) { req.resume(); return reject(new HttpError(415, 'Send the files as multipart/form-data')); }
  const maxBytes = config.maxUploadMb * 1024 * 1024; fs.mkdirSync(config.filesDir, { recursive: true });
  let bb; try { bb = busboy({ headers: req.headers, limits: { files: MAX_FILES, fileSize: maxBytes, fields: 5 } }); } catch { req.resume(); return reject(bad('Invalid upload')); }
  const items = []; let note = ''; let tooMany = false;
  bb.on('field', (n, v) => { if (n === 'note') note = String(v).slice(0, 300); });
  bb.on('filesLimit', () => { tooMany = true; });
  bb.on('file', (_n, stream, info) => {
    const it = { name: safeName(info.filename), size: 0, hash: crypto.createHash('sha256'), error: null, tmp: path.join(config.filesDir, `.tmp-${crypto.randomBytes(8).toString('hex')}`) };
    it.mime = mimeFor(it.name, info.mimeType); items.push(it);
    if (BLOCKED.test(it.name)) { it.error = 'This file type is not allowed (programs and scripts cannot be attached).'; return stream.resume(); }
    const ws = fs.createWriteStream(it.tmp, { mode: 0o600 }); it.done = new Promise((r) => ws.on('close', r));
    stream.on('data', (c) => { it.size += c.length; it.hash.update(c); });
    stream.on('limit', () => { it.error = `File is larger than ${config.maxUploadMb} MB`; it.status = 413; });
    stream.on('error', (e) => { it.error = e.message; }); ws.on('error', (e) => { it.error = e.message; }); stream.pipe(ws);
  });
  bb.on('error', (e) => reject(bad('Upload failed: ' + e.message)));
  bb.on('close', async () => {
    const saved = [], errors = [];
    for (const it of items) {
      if (it.done) await it.done;
      const drop = () => { try { fs.unlinkSync(it.tmp); } catch {} };
      if (!it.error && !it.size) it.error = 'Empty files are not accepted';
      if (it.error) { drop(); errors.push({ name: it.name, error: it.error, status: it.status || 400 }); continue; }
      const sha = it.hash.digest('hex');
      const rel = `${query.entity}/${Number(query.id)}/${stage || 'general'}/${sha.slice(0, 8)}-${crypto.randomBytes(3).toString('hex')}-${diskName(it.name)}`;
      try {
        const dest = absPath(rel); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.renameSync(it.tmp, dest);
        const id = Number(run('INSERT INTO files (entity,record_id,stage,name,mime,size,sha256,path,note,uploaded_by,uploaded_by_name) VALUES (?,?,?,?,?,?,?,?,?,?,?)', query.entity, Number(query.id), stage, it.name, it.mime, it.size, sha, rel, note || null, user.id, user.name).lastInsertRowid);
        saved.push(out(get('SELECT * FROM files WHERE id=?', id)));
      } catch (e) { drop(); errors.push({ name: it.name, error: 'Could not store the file: ' + e.message, status: 500 }); }
    }
    if (tooMany) errors.push({ name: '', error: `Only ${MAX_FILES} files can be uploaded at once; the rest were skipped`, status: 400 });
    if (saved.length) audit(user, 'upload', query.entity, Number(query.id), `${saved.length} file(s)${stage ? ` to ${stage}` : ''}: ${saved.map((f) => f.name).join(', ').slice(0, 300)}`);
    if (!saved.length) return reject(new HttpError(errors[0]?.status || 400, errors[0]?.error || 'Choose at least one file to upload', { errors }));
    resolve({ files: saved, errors });
  });
  req.pipe(bb);
}), { raw: true });

/** Move a file to another stage folder and/or change its note. */
PUT('/api/files/:id', ({ params, body, user }) => {
  const f = get('SELECT * FROM files WHERE id=?', params.id); if (!f) throw notFound('File not found');
  guardRecord(f.entity, f.record_id, user, true);
  const stage = body.stage === undefined ? f.stage : checkStage(f.entity, body.stage);
  const note = body.note === undefined ? f.note : String(body.note || '').slice(0, 300) || null;
  let rel = f.path;
  if ((stage || null) !== (f.stage || null)) { // keep the on-disk folder in step with the stage
    rel = `${f.entity}/${f.record_id}/${stage || 'general'}/${path.basename(f.path)}`;
    try { const dest = absPath(rel); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.renameSync(absPath(f.path), dest); } catch { rel = f.path; }
  }
  run('UPDATE files SET stage=?, note=?, path=? WHERE id=?', stage, note, rel, f.id);
  audit(user, 'update_file', f.entity, f.record_id, `${f.name}${stage !== f.stage ? ` → ${stage || 'general'}` : ''}`);
  return out(get('SELECT * FROM files WHERE id=?', f.id));
});

function sendFile(res, f, { inline }) {
  const file = absPath(f.path); if (!fs.existsSync(file)) throw notFound('The stored file is missing on disk');
  let type = 'application/octet-stream', disp = 'attachment';
  if (inline) {
    if (MEDIA.has(f.mime)) { type = f.mime; disp = 'inline'; }
    else if (TEXTLIKE.test(f.mime) || TEXT_EXT.test(f.name)) { type = 'text/plain; charset=utf-8'; disp = 'inline'; }
  }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': f.size, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store',
    'Content-Disposition': `${disp}; filename="${f.name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(f.name)}`,
    // browsers refuse to run their PDF viewer in a sandboxed document, so PDFs get a no-script policy instead of `sandbox`
    'Content-Security-Policy': type === 'application/pdf' ? "default-src 'none'; object-src 'self'; frame-ancestors 'self'" : "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'; sandbox", 'X-Frame-Options': 'SAMEORIGIN' });
  fs.createReadStream(file).pipe(res);
}
const loadVisible = (id, user) => { const f = get('SELECT * FROM files WHERE id=?', id); if (!f) throw notFound('File not found'); guardRecord(f.entity, f.record_id, user); return f; };
GET('/api/files/:id/download', ({ params, user, res }) => { sendFile(res, loadVisible(params.id, user), { inline: false }); });
GET('/api/files/:id/view', ({ params, user, res }) => { sendFile(res, loadVisible(params.id, user), { inline: true }); });

// ---- temporary links that work without signing in (for external viewers such as Microsoft Office Online) ----
const LINK_TTL = 60 * 60; // 1 hour
const linkSig = (id, exp) => hmac(`file-link:${id}:${exp}`).slice(0, 32);
POST('/api/files/:id/link', ({ params, user }) => {
  const f = loadVisible(params.id, user);
  const exp = Math.floor(Date.now() / 1000) + LINK_TTL;
  audit(user, 'share_file_link', f.entity, f.record_id, `${f.name} (1 hour)`);
  return { url: `${config.baseUrl}/f/${f.id}/${exp}/${linkSig(f.id, exp)}/${encodeURIComponent(f.name)}`, expires_at: new Date(exp * 1000).toISOString() };
});
/** Public handler for /f/:id/:exp/:sig/:name — called from index.js. Returns false when the link is not valid. */
export function servePublicFile(res, id, exp, sig) {
  const good = linkSig(Number(id), Number(exp));
  if (!sig || sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good)) || Number(exp) < Date.now() / 1000) return false;
  const f = get('SELECT * FROM files WHERE id=?', Number(id)); if (!f) return false;
  try { sendFile(res, f, { inline: true }); return true; } catch { return false; }
}

DELETE('/api/files/:id', ({ params, user }) => {
  const f = get('SELECT * FROM files WHERE id=?', params.id); if (!f) throw notFound('File not found');
  guardRecord(f.entity, f.record_id, user, true);
  run('DELETE FROM files WHERE id=?', f.id);
  try { fs.unlinkSync(absPath(f.path)); } catch {}
  audit(user, 'delete_file', f.entity, f.record_id, f.name);
  return { ok: true };
});
