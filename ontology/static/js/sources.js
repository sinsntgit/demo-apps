// Source material: choosing documents or a whole folder, uploading them, and the "read a database" form.
// Used by the New ontology wizard and by the Sources tab of an ontology.
import { h, fill, api, field, select, toast } from './core.js';

export const DB_TYPES = { postgresql: ['PostgreSQL', 5432], mysql: ['MySQL / MariaDB', 3306], singlestore: ['SingleStore', 3306], mssql: ['Microsoft SQL Server', 1433],
  oracle: ['Oracle', 1521], snowflake: ['Snowflake', null] };
export const ACCEPT = '.pdf,.docx,.pptx,.xlsx,.xlsm,.csv,.txt,.md,.sql,.ddl,.json,.xml,.yaml,.yml,.html,.htm,.ttl,.owl,.rdf,.db,.sqlite,.sqlite3,.tsv,.dbml,.xsd,.graphql,.proto';
export const fmtSize = n => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n > 1024 ? Math.round(n / 1024) + ' KB' : n + ' B';

/** Read every file inside a dropped folder (drag and drop gives directories as entries). */
async function walk(entry, out, prefix = '') {
  if (entry.isFile) {
    await new Promise(res => entry.file(f => { f._path = prefix + f.name; out.push(f); res(); }, res));
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    for (;;) {
      const batch = await new Promise(res => reader.readEntries(res, () => res([])));
      if (!batch.length) break;
      for (const e of batch) await walk(e, out, prefix + entry.name + '/');
    }
  }
}

/** A drop zone with "Choose files" and "Choose a folder". Calls onFiles(File[]); each file has ._path. */
export function filePicker(onFiles) {
  const take = list => { const files = [...list]; files.forEach(f => { f._path = f._path || f.webkitRelativePath || f.name; }); if (files.length) onFiles(files); };
  const files = h('input', { type: 'file', multiple: true, accept: ACCEPT, class: 'hidden', onchange: e => { take(e.target.files); e.target.value = ''; } });
  const folder = h('input', { type: 'file', multiple: true, class: 'hidden', onchange: e => { take(e.target.files); e.target.value = ''; } });
  folder.setAttribute('webkitdirectory', ''); folder.setAttribute('directory', '');
  const zone = h('div', { class: 'drop',
    ondragover: e => { e.preventDefault(); zone.classList.add('over'); }, ondragleave: () => zone.classList.remove('over'),
    ondrop: async e => {
      e.preventDefault(); zone.classList.remove('over');
      const entries = [...(e.dataTransfer.items || [])].map(i => i.webkitGetAsEntry?.()).filter(Boolean);
      if (entries.length) { const out = []; for (const en of entries) await walk(en, out); take(out); } else take(e.dataTransfer.files);
    } },
    h('div', { style: 'margin-bottom:8px' }, 'Drop documents or a whole folder here'),
    h('div', { class: 'row', style: 'justify-content:center' }, h('button', { class: 'btn', type: 'button', onclick: () => files.click() }, '📄 Choose files'),
      h('button', { class: 'btn', type: 'button', onclick: () => folder.click() }, '📁 Choose a folder')),
    h('div', { class: 'small dim', style: 'margin-top:8px' }, 'PDF, Word, PowerPoint, Excel, CSV, text, SQL / DDL scripts, SQLite files. Up to 25 MB each. The text is extracted and kept; the files themselves are not stored.'),
    files, folder);
  return zone;
}

/** Upload in small batches so a big folder shows progress. -> {added: [...], failed: [...]} */
export async function uploadFiles(oid, files, onProgress) {
  const out = { added: [], failed: [] };
  for (let i = 0; i < files.length; i += 10) {
    const part = files.slice(i, i + 10);
    const fd = new FormData();
    part.forEach(f => fd.append('files', f, f.name));
    fd.append('paths', JSON.stringify(part.map(f => f._path || f.name)));
    onProgress?.(Math.min(i + part.length, files.length), files.length);
    try {
      const r = await api('POST', `/api/ontologies/${oid}/sources`, fd);
      out.added.push(...r.added); out.failed.push(...r.failed);
    } catch (e) { part.forEach(f => out.failed.push({ name: f._path || f.name, reason: e.message })); }
  }
  return out;
}

/** The form for reading a live database's structure. value() -> payload or null when left empty. */
/** The form for a database connection. opts.dataSource: profiling with a stored password (data sources),
 *  otherwise a one-off structure read. value() -> payload or null when left empty; set(connection) fills it in. */
export function dbForm(opts = {}) {
  const type = select(Object.entries(DB_TYPES).map(([k, v]) => [k, v[0]]), 'postgresql', () => adapt());
  const host = h('input', { type: 'text' }), port = h('input', { type: 'number' });
  const database = h('input', { type: 'text' }), schema = h('input', { type: 'text' });
  const user = h('input', { type: 'text', autocomplete: 'off' }), password = h('input', { type: 'password', autocomplete: 'new-password' });
  const warehouse = h('input', { type: 'text', placeholder: 'e.g. COMPUTE_WH' }), role = h('input', { type: 'text', placeholder: 'optional, e.g. ANALYST' });
  const f = { host: field('Host', host), port: field('Port', port, 'blank = default'), database: field('Database', database), schema: field('Schema', schema),
    warehouse: field('Warehouse', warehouse), role: field('Role', role, 'optional') };
  const adapt = () => {
    const k = type.value, sf = k === 'snowflake';
    f.host.firstChild.firstChild.textContent = sf ? 'Account identifier' : 'Host';
    host.placeholder = sf ? 'orgname-accountname (from your Snowflake URL)' : 'db.yourcompany.com';
    f.database.firstChild.firstChild.textContent = k === 'oracle' ? 'Service name' : 'Database';
    database.placeholder = k === 'oracle' ? 'e.g. ORCLPDB1' : 'Database name';
    port.placeholder = DB_TYPES[k][1] || '';
    schema.placeholder = { postgresql: 'optional, e.g. public', mssql: 'optional, e.g. dbo', snowflake: 'optional, e.g. PUBLIC', oracle: 'optional — the owner, e.g. LENDING' }[k] || 'optional';
    f.port.classList.toggle('hidden', sf); f.warehouse.classList.toggle('hidden', !sf); f.role.classList.toggle('hidden', !sf);
    f.schema.classList.toggle('hidden', k === 'mysql' || k === 'singlestore');
  };
  const note = opts.dataSource
    ? 'Tables are profiled from at most 2,000 rows each; nothing is written. The password is stored encrypted so the database can be re-read, and is never shown again. A read-only database user is enough.'
    : 'Only the structure is read: tables, columns, types, keys and comments. No rows are read. The password is used for this one read and is not stored. A read-only database user is enough.';
  const el = h('div', { class: 'stack' }, h('div', { class: 'banner info' }, note),
    h('div', { class: 'grid2' }, field('Database type', type), f.host, f.port, f.database, field('User', user), field('Password', password), f.warehouse, f.role, f.schema));
  el.value = () => host.value.trim() || database.value.trim() ? { db_type: type.value, host: host.value.trim(), port: port.value ? Number(port.value) : null,
    database: database.value.trim(), user: user.value, password: password.value, schema_name: schema.value.trim(), warehouse: warehouse.value.trim(), role: role.value.trim() } : null;
  el.label = () => `${DB_TYPES[type.value][0]} ${database.value.trim()} on ${host.value.trim()}`;
  el.set = c => {
    type.value = c.db_type; host.value = c.host || ''; port.value = c.port || ''; database.value = c.database || ''; user.value = c.user || '';
    schema.value = c.schema || ''; warehouse.value = c.warehouse || ''; role.value = c.role || '';
    password.placeholder = c.has_password ? '•••••••• (unchanged)' : ''; adapt();
  };
  adapt();
  return el;
}

export function failedList(failed) {
  return failed.length ? h('div', { class: 'banner warn' }, h('b', {}, `${failed.length} file${failed.length > 1 ? 's were' : ' was'} not added:`),
    h('ul', { class: 'bul' }, failed.slice(0, 12).map(f => h('li', {}, h('b', {}, f.name), ' — ', f.reason)), failed.length > 12 ? h('li', {}, `…and ${failed.length - 12} more`) : null)) : null;
}
export { fill, toast };
