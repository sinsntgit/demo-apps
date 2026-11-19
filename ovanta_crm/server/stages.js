import { get, run, all, tx, audit } from './db.js';
import { bad } from './http.js';

/*
 * Deal stages, editable under Customisation → Deal stages.
 * STAGES is one shared array (updated in place) so every module sees changes at once.
 * "won" and "lost" always exist and always come last: reports, forecasts and the closed date depend on them;
 * their names and the open stages (add, rename, reorder, probability, delete) are up to the customer.
 * Deleted stages are kept as "archived" only so old history entries still show a readable name.
 */
export const DEFAULT_STAGES = [
  { key: 'prospecting', label: 'Prospecting', prob: 10 },
  { key: 'qualification', label: 'Qualification', prob: 25 },
  { key: 'proposal', label: 'Proposal', prob: 50 },
  { key: 'negotiation', label: 'Negotiation', prob: 75 },
  { key: 'won', label: 'Closed Won', prob: 100 },
  { key: 'lost', label: 'Closed Lost', prob: 0 },
];
export const CLOSED = ['won', 'lost'];
export const STAGES = DEFAULT_STAGES.map((s) => ({ ...s }));
export const STAGE_KEYS = STAGES.map((s) => s.key);
const archived = new Map(); // key -> label

function apply(list, arch) {
  STAGES.splice(0, STAGES.length, ...list.map((s) => ({ key: s.key, label: s.label, prob: s.prob })));
  STAGE_KEYS.splice(0, STAGE_KEYS.length, ...STAGES.map((s) => s.key));
  archived.clear(); for (const a of arch || []) archived.set(a.key, a.label);
}
export function loadStages() {
  let saved = null;
  try { saved = JSON.parse(get("SELECT value FROM settings WHERE key='deal_stages'")?.value || 'null'); } catch { saved = null; }
  if (saved?.stages?.length) apply(saved.stages, saved.archived); else apply(DEFAULT_STAGES, []);
}
export const stageLabelOf = (k) => STAGES.find((s) => s.key === k)?.label || archived.get(k) || k;
export const openStages = () => STAGES.filter((s) => !CLOSED.includes(s.key));
export const firstStage = () => openStages()[0]?.key || 'won';
export const stagesForClient = () => ({ stages: STAGES.map((s) => ({ ...s, closed: CLOSED.includes(s.key) })), labels: Object.fromEntries([...archived, ...STAGES.map((s) => [s.key, s.label])]) });

const slug = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30) || 'stage';

/**
 * Save a new stage list. body.stages: [{ key? (existing), label, prob }] in board order, including won and lost.
 * body.moves: { deletedKey: targetKey } — where the deals (and their stage folder files) of a deleted stage go.
 * Open deals still on a stage's old default probability follow its new default.
 */
export function saveStages(body, user) {
  const input = Array.isArray(body?.stages) ? body.stages : null;
  if (!input) throw bad('Send the list of stages');
  const current = new Map(STAGES.map((s) => [s.key, s]));
  const seenLabels = new Set(), out = [];
  for (const s of input) {
    const label = String(s.label ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
    if (!label) throw bad('Every stage needs a name');
    if (seenLabels.has(label.toLowerCase())) throw bad(`Two stages are called “${label}”`); seenLabels.add(label.toLowerCase());
    const key = s.key && current.has(s.key) ? s.key : null;
    let prob = Number(s.prob); if (!Number.isFinite(prob) || prob < 0 || prob > 100) throw bad(`Probability for “${label}” must be 0–100`);
    prob = Math.round(prob);
    if (key === 'won') prob = 100; if (key === 'lost') prob = 0;
    out.push({ key, label, prob });
  }
  for (const k of CLOSED) if (!out.some((s) => s.key === k)) throw bad(`The “${current.get(k).label}” stage cannot be removed — it marks deals as ${k}.`);
  const open = out.filter((s) => !CLOSED.includes(s.key));
  if (!open.length) throw bad('Keep at least one open stage');
  if (out.length > 20) throw bad('At most 20 stages');
  // give new stages a key that has never been used (old history may still mention archived keys)
  const used = new Set([...current.keys(), ...archived.keys()]);
  for (const s of open) if (!s.key) { let k = slug(s.label), i = 2; while (used.has(k) || CLOSED.includes(k)) k = `${slug(s.label)}_${i++}`; used.add(k); s.key = k; s.isNew = true; }
  const ordered = [...open, ...CLOSED.map((k) => out.find((s) => s.key === k))];
  const keep = new Set(ordered.map((s) => s.key));
  const removed = [...current.keys()].filter((k) => !keep.has(k));
  const moves = body.moves || {};
  const plan = [];
  for (const k of removed) {
    const n = get('SELECT COUNT(*) n FROM deals WHERE stage=?', k).n, files = get("SELECT COUNT(*) n FROM files WHERE entity='deals' AND stage=?", k).n;
    let to = moves[k];
    if ((n || files) && !to) throw bad(`“${current.get(k).label}” still has ${n} deal${n === 1 ? '' : 's'}${files ? ` and ${files} file${files === 1 ? '' : 's'}` : ''}. Choose a stage to move ${n ? 'them' : 'the files'} to.`, { needs_move: k, deals: n, files });
    if (to) {
      const target = ordered.find((s) => s.key === to || (s.isNew && s.label === to));
      if (!target) throw bad(`Unknown stage to move “${current.get(k).label}” deals to`);
      to = target.key;
    }
    plan.push({ key: k, label: current.get(k).label, to, n, files });
  }
  tx(() => {
    for (const p of plan) {
      if (!p.to) continue;
      const target = ordered.find((s) => s.key === p.to); const oldDefault = current.get(p.key).prob;
      for (const d of all('SELECT id, amount, probability, owner_id FROM deals WHERE stage=?', p.key)) {
        const closed = CLOSED.includes(p.to);
        run(`UPDATE deals SET stage=?, probability=?${closed ? ", closed_at=COALESCE(closed_at, datetime('now'))" : ''} WHERE id=?`, p.to, d.probability === oldDefault || closed ? target.prob : d.probability, d.id);
        run('INSERT INTO deal_stage_history (deal_id, from_stage, to_stage, comment, amount, owner_id, owner_name, changed_by, changed_by_name) VALUES (?,?,?,?,?,?,(SELECT name FROM users WHERE id=?),?,?)',
          d.id, p.key, p.to, `Stage “${p.label}” was removed in Customisation; deal moved to “${target.label}”.`, d.amount, d.owner_id, d.owner_id, user?.id ?? null, user?.name ?? null);
      }
      run("UPDATE files SET stage=? WHERE entity='deals' AND stage=?", p.to, p.key);
    }
    // open deals that still use a stage's old default probability follow the new default
    for (const s of ordered) { const before = current.get(s.key); if (before && before.prob !== s.prob && !CLOSED.includes(s.key)) run('UPDATE deals SET probability=? WHERE stage=? AND probability=?', s.prob, s.key, before.prob); }
    const arch = [...archived].map(([key, label]) => ({ key, label })).filter((a) => !keep.has(a.key));
    for (const p of plan) if (!arch.some((a) => a.key === p.key)) arch.push({ key: p.key, label: p.label });
    const value = JSON.stringify({ stages: ordered.map(({ key, label, prob }) => ({ key, label, prob })), archived: arch });
    run("INSERT INTO settings (key,value,updated_at) VALUES ('deal_stages',?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at", value);
    apply(JSON.parse(value).stages, arch);
  });
  audit(user, 'update', 'deal_stages', 0, `${STAGES.map((s) => `${s.label} ${s.prob}%`).join(' → ')}${plan.length ? ` · removed ${plan.map((p) => p.label).join(', ')}` : ''}`);
  return { ...stagesForClient(), moved: plan.filter((p) => p.to).map((p) => ({ from: p.label, to: stageLabelOf(p.to), deals: p.n, files: p.files })) };
}

/** How many deals and files are in each stage (shown next to each stage in Customisation). */
export const stageUsage = () => Object.fromEntries(STAGES.map((s) => [s.key, { deals: get('SELECT COUNT(*) n FROM deals WHERE stage=?', s.key).n, files: get("SELECT COUNT(*) n FROM files WHERE entity='deals' AND stage=?", s.key).n }]));
export const resetStagesForTests = () => apply(DEFAULT_STAGES, []);

loadStages();
