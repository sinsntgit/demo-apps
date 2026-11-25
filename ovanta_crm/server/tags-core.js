// Constants and the install step for the shared tag fields. No imports from db.js (the migrations use this).
const LIMIT = { items: 200, length: 60 };
export const TAG_ENTITIES = ['contacts', 'accounts', 'deals'];
export const TAG_KEYS = ['cf_tag1', 'cf_tag2', 'cf_tag3', 'cf_tag4'];
export const isTagKey = (k) => TAG_KEYS.includes(k);
export const DEFAULT_TAGS = ['Text2SQL', 'AI Consulting', 'Staffing', 'BI Reporting'];

export function tagList(dbGet) {
  try { const v = JSON.parse(dbGet("SELECT value FROM settings WHERE key='tags.list'")?.value || 'null'); if (Array.isArray(v)) return v; } catch { /* default */ }
  return DEFAULT_TAGS;
}

/** Used by the migration (raw db handle): store the default list and create the 12 dropdown fields. */
export function installTagFields(db) {
  if (!db.prepare("SELECT 1 FROM settings WHERE key='tags.list'").get()) db.prepare("INSERT INTO settings (key,value,updated_at) VALUES ('tags.list',?,datetime('now'))").run(JSON.stringify(DEFAULT_TAGS));
  const opts = JSON.stringify(tagList((sql) => db.prepare(sql).get()));
  for (const e of TAG_ENTITIES) {
    let pos = (db.prepare('SELECT MAX(position) p FROM field_defs WHERE entity=?').get(e).p ?? 0);
    TAG_KEYS.forEach((k, i) => {
      if (db.prepare('SELECT 1 FROM field_defs WHERE entity=? AND key=?').get(e, k)) return;
      db.prepare('INSERT INTO field_defs (entity,key,label,type,options,config,required,show_in_list,filterable,searchable,position) VALUES (?,?,?,?,?,?,0,0,1,1,?)').run(e, k, `Tag ${i + 1}`, 'dropdown', opts, '{}', ++pos);
    });
  }
}

export { LIMIT };
