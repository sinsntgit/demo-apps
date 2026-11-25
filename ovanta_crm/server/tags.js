import { all, get, run, tx, audit } from './db.js';
import { bad } from './http.js';

/*
 * Shared tag choices. Contacts/leads, accounts and deals each get four dropdown fields (Tag 1 – Tag 4, stored as the
 * custom fields cf_tag1 … cf_tag4) that all draw their options from ONE list kept in settings ("tags.list"), edited by
 * administrators under Customisation. Because they are ordinary custom fields they already work in forms, detail pages,
 * lists, filters, search, CSV import and segments.
 */
import { TAG_ENTITIES, TAG_KEYS, DEFAULT_TAGS, LIMIT, tagList as tagListRaw } from './tags-core.js';
export { TAG_ENTITIES, TAG_KEYS, DEFAULT_TAGS };
export const tagList = () => tagListRaw(get);
export function tagUsage() {
  const out = {};
  for (const e of TAG_ENTITIES) for (const k of TAG_KEYS) for (const r of all(`SELECT json_extract(custom,'$.${k}') v, COUNT(*) n FROM ${e} WHERE json_extract(custom,'$.${k}') IS NOT NULL GROUP BY v`)) {
    out[r.v] = out[r.v] || { contacts: 0, accounts: 0, deals: 0 }; out[r.v][e] += r.n;
  }
  return out;
}
export const tagsOut = () => ({ list: tagList(), usage: tagUsage(), max: LIMIT });

/** items: [{ orig: 'existing name' | null, text: 'name' }] in the order to show. Renames follow the data; removed choices are cleared from records. */
export function saveTags(user, items) {
  if (!Array.isArray(items)) throw bad('Send the list of tags');
  const cur = tagList(); const seen = new Set(); const next = []; const renames = {}; const kept = new Set();
  for (const it of items) {
    const text = String(it.text ?? '').replace(/\s+/g, ' ').trim(); if (!text) continue;
    if (text.length > LIMIT.length) throw bad(`A tag can have up to ${LIMIT.length} characters`);
    if (seen.has(text.toLowerCase())) throw bad(`“${text}” is listed twice`);
    seen.add(text.toLowerCase()); next.push(text);
    if (it.orig && cur.includes(it.orig)) { kept.add(it.orig); if (it.orig !== text) renames[it.orig] = text; }
  }
  if (next.length > LIMIT.items) throw bad(`At most ${LIMIT.items} tags`);
  if (!next.length) throw bad('Keep at least one tag in the list');
  const removed = cur.filter((c) => !kept.has(c));
  tx(() => {
    run("INSERT INTO settings (key,value,updated_at) VALUES ('tags.list',?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at", JSON.stringify(next));
    run(`UPDATE field_defs SET options=? WHERE key IN (${TAG_KEYS.map(() => '?').join(',')})`, JSON.stringify(next), ...TAG_KEYS);
    for (const e of TAG_ENTITIES) for (const r of all(`SELECT id, custom FROM ${e} WHERE ${TAG_KEYS.map((k) => `json_extract(custom,'$.${k}') IS NOT NULL`).join(' OR ')}`)) {
      let c; try { c = JSON.parse(r.custom || '{}'); } catch { continue; } let changed = false;
      for (const k of TAG_KEYS) {
        if (c[k] == null) continue;
        if (renames[c[k]]) { c[k] = renames[c[k]]; changed = true; } else if (removed.includes(c[k])) { delete c[k]; changed = true; }
      }
      if (changed) run(`UPDATE ${e} SET custom=? WHERE id=?`, JSON.stringify(c), r.id);
    }
  });
  audit(user, 'update', 'tags', 0, `${next.length} tags; renamed ${Object.keys(renames).length}, removed ${removed.length}`);
  return tagsOut();
}
