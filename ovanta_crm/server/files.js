import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import busboy from 'busboy';
import { GET, POST, DELETE, HttpError, bad, notFound, forbidden } from './http.js';
import { all, get, run, audit } from './db.js';
import { config } from './config.js';
import { ENTITIES, getOne } from './entities.js';
import { hasPerm, canOnRecord } from './permissions.js';

const KINDS = ['contacts', 'accounts', 'deals', 'invoices'];
const BLOCKED = /\.(exe|dll|bat|cmd|com|scr|msi|ps1|vbs|js|jse|jar|sh|app|apk|dmg|lnk|hta|cpl|reg)$/i;
// shown inline in the browser only when harmless; everything else downloads
const INLINE = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'text/plain']);

/** The record must exist and be visible to this user. Invoices are not an `ENTITIES` row, so they follow the invoices permission. */
function guardRecord(kind, id, user, needEdit = false) {
  if (!KINDS.includes(kind)) throw bad('Unknown record type');
  id = Number(id); if (!id) throw bad('Missing record');
  if (kind === 'invoices') { if (!get('SELECT 1 FROM invoices WHERE id=?', id)) throw notFound('Record not found'); if (!hasPerm(user, 'invoices.view')) throw forbidden(); return; }
  const r = getOne(ENTITIES[kind], id, user);
  if (needEdit && !canOnRecord(user, `${kind}.edit`, r.owner_id)) throw forbidden(`Your role can only add files to ${kind} you own.`);
}
const safeName = (n) => String(n || 'file').replace(/[\\/\0]/g, '_').replace(/[\r\n"]/g, '').trim().slice(0, 200) || 'file';
const out = (f) => ({ id: f.id, name: f.name, mime: f.mime, size: f.size, note: f.note, uploaded_by_name: f.uploaded_by_name, created_at: f.created_at, sha256: f.sha256 });

GET('/api/files', ({ query, user }) => {
  guardRecord(query.entity, query.id, user);
  return all('SELECT * FROM files WHERE entity=? AND record_id=? ORDER BY id DESC', query.entity, Number(query.id)).map(out);
});

POST('/api/files', ({ req, query, user, send }) => new Promise((resolve, reject) => {
  try { guardRecord(query.entity, query.id, user, true); } catch (e) { req.resume(); return reject(e); }
  const ct = req.headers['content-type'] || ''; if (!ct.startsWith('multipart/form-data')) { req.resume(); return reject(new HttpError(415, 'Send the file as multipart/form-data')); }
  const maxBytes = config.maxUploadMb * 1024 * 1024; fs.mkdirSync(config.filesDir, { recursive: true });
  const tmp = path.join(config.filesDir, `.tmp-${crypto.randomBytes(8).toString('hex')}`);
  let bb; try { bb = busboy({ headers: req.headers, limits: { files: 1, fileSize: maxBytes, fields: 5 } }); } catch { req.resume(); return reject(bad('Invalid upload')); }
  let meta = null, note = '', failed = null, written = 0; const hash = crypto.createHash('sha256'); let ws = null, done = null;
  const fail = (e) => { if (!failed) failed = e; };
  bb.on('field', (n, v) => { if (n === 'note') note = String(v).slice(0, 300); });
  bb.on('file', (_n, stream, info) => {
    const name = safeName(info.filename);
    if (BLOCKED.test(name)) { fail(bad('This file type is not allowed (programs and scripts cannot be attached).')); return stream.resume(); }
    meta = { name, mime: String(info.mimeType || 'application/octet-stream').toLowerCase().slice(0, 100) };
    ws = fs.createWriteStream(tmp, { mode: 0o600 }); done = new Promise((r) => ws.on('close', r));
    stream.on('data', (c) => { written += c.length; hash.update(c); });
    stream.on('limit', () => fail(new HttpError(413, `File is larger than ${config.maxUploadMb} MB`)));
    stream.on('error', fail); ws.on('error', fail); stream.pipe(ws);
  });
  bb.on('error', (e) => fail(bad('Upload failed: ' + e.message)));
  bb.on('close', async () => {
    if (done) await done;
    const cleanup = () => { try { fs.unlinkSync(tmp); } catch {} };
    if (failed) { cleanup(); return reject(failed); }
    if (!meta || !written) { cleanup(); return reject(bad('Choose a file to upload (empty files are not accepted)')); }
    const sha = hash.digest('hex'); const rel = `${sha.slice(0, 2)}/${sha}-${crypto.randomBytes(4).toString('hex')}`;
    try {
      fs.mkdirSync(path.dirname(path.join(config.filesDir, rel)), { recursive: true }); fs.renameSync(tmp, path.join(config.filesDir, rel));
      const id = Number(run('INSERT INTO files (entity,record_id,name,mime,size,sha256,path,note,uploaded_by,uploaded_by_name) VALUES (?,?,?,?,?,?,?,?,?,?)', query.entity, Number(query.id), meta.name, meta.mime, written, sha, rel, note || null, user.id, user.name).lastInsertRowid);
      audit(user, 'upload', query.entity, Number(query.id), `${meta.name} (${written} bytes)`);
      resolve(out(get('SELECT * FROM files WHERE id=?', id)));
    } catch (e) { cleanup(); reject(e); }
  });
  req.pipe(bb);
}), { raw: true });

GET('/api/files/:id/download', ({ params, user, res }) => {
  const f = get('SELECT * FROM files WHERE id=?', params.id); if (!f) throw notFound('File not found');
  guardRecord(f.entity, f.record_id, user);
  const file = path.join(config.filesDir, f.path);
  if (!file.startsWith(config.filesDir + path.sep) || !fs.existsSync(file)) throw notFound('The stored file is missing on disk');
  const inline = INLINE.has(f.mime);
  res.writeHead(200, { 'Content-Type': inline ? f.mime : 'application/octet-stream', 'Content-Length': f.size, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store',
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${f.name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(f.name)}`, 'Content-Security-Policy': "default-src 'none'; sandbox" });
  fs.createReadStream(file).pipe(res);
});

DELETE('/api/files/:id', ({ params, user }) => {
  const f = get('SELECT * FROM files WHERE id=?', params.id); if (!f) throw notFound('File not found');
  guardRecord(f.entity, f.record_id, user, true);
  run('DELETE FROM files WHERE id=?', f.id);
  try { fs.unlinkSync(path.join(config.filesDir, f.path)); } catch {}
  audit(user, 'delete_file', f.entity, f.record_id, f.name);
  return { ok: true };
});
