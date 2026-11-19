import { GET, POST, PUT, DELETE, bad, notFound, forbidden } from './http.js';
import { all, get, run, audit } from './db.js';
import { scopeOf } from './permissions.js';
import { STAGES, CLOSED, stageLabelOf } from './stages.js';
import { listFields } from './customfields.js';

/*
 * Pipeline & forecast review — for monthly (MBR) and quarterly (QBR) business reviews.
 *
 * For a review period it takes: deals won and lost in the period, open deals expected to close in it (their expected
 * close date, or an estimate from the average sales cycle when none is set), and optionally open deals that have slipped
 * past their date. Every open deal falls in a forecast category by its probability:
 *   Commit    probability ≥ worst-case threshold (default 75 %)
 *   Best case probability ≥ best-case threshold  (default 25 %)
 *   Pipeline  below that
 * Scenarios for the period:
 *   Worst case = won + commit              (what you are confident of)
 *   Projected  = won + Σ amount × probability (the weighted forecast)
 *   Best case  = won + commit + best case   (if the likely deals all close)
 */
const DAY = 86400000;
const iso = (d) => d.toISOString().slice(0, 10);
const addMonths = (y, m, n) => { const d = new Date(Date.UTC(y, m - 1 + n, 1)); return [d.getUTCFullYear(), d.getUTCMonth() + 1]; };

/** Turn the period choice into dates. Quarters and years follow the fiscal year start month. */
export function periodRange(p = {}, today = new Date()) {
  const fy = Math.min(12, Math.max(1, Number(p.fy_start) || 1));
  const type = ['month', 'quarter', 'year', 'custom'].includes(p.type) ? p.type : 'quarter';
  if (type === 'custom') {
    const from = /^\d{4}-\d{2}-\d{2}$/.test(p.from || '') ? p.from : null, to = /^\d{4}-\d{2}-\d{2}$/.test(p.to || '') ? p.to : null;
    if (!from || !to || from > to) throw bad('Choose a valid from and to date');
    return { type, from, to, label: `${from} – ${to}`, fy_start: fy };
  }
  let y = today.getUTCFullYear(), m = today.getUTCMonth() + 1;
  if (type === 'month') {
    const mm = /^(\d{4})-(\d{2})$/.exec(p.month || ''); if (mm) { y = +mm[1]; m = +mm[2]; }
    const [ny, nm] = addMonths(y, m, 1);
    return { type, from: `${y}-${String(m).padStart(2, '0')}-01`, to: iso(new Date(Date.UTC(ny, nm - 1, 1) - DAY)), label: new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }), fy_start: fy };
  }
  // fiscal year "FY y" starts in month fy of year y (or y-1 when fy > 1: FY2027 starting April = Apr 2026–Mar 2027)
  const fyOf = (yy, mm) => (fy === 1 ? yy : mm >= fy ? yy + 1 : yy);
  let fyYear = fyOf(y, m), q = Math.floor(((m - fy + 12) % 12) / 3) + 1;
  const qm = /^(\d{4})-Q([1-4])$/.exec(p.quarter || ''); if (type === 'quarter' && qm) { fyYear = +qm[1]; q = +qm[2]; }
  const ym = /^(\d{4})$/.exec(String(p.year || '')); if (type === 'year' && ym) fyYear = +ym[1];
  const startY = fy === 1 ? fyYear : fyYear - 1;
  const [sy, sm] = addMonths(startY, fy, type === 'quarter' ? (q - 1) * 3 : 0);
  const [ey, em] = addMonths(sy, sm, type === 'quarter' ? 3 : 12);
  const from = `${sy}-${String(sm).padStart(2, '0')}-01`, to = iso(new Date(Date.UTC(ey, em - 1, 1) - DAY));
  const fyLabel = fy === 1 ? `${fyYear}` : `FY${fyYear}`;
  return { type, from, to, label: type === 'quarter' ? `Q${q} ${fyLabel}` : fyLabel, quarter: `${fyYear}-Q${q}`, year: fyYear, fy_start: fy };
}

const num = (v, d) => (v === '' || v === null || v === undefined || !Number.isFinite(Number(v)) ? d : Number(v));
const arr = (v) => (Array.isArray(v) ? v : v === undefined || v === null || v === '' ? [] : String(v).split(',')).map(String).filter(Boolean);

/** Build the report. `cfg` is the saved/edited view: period, filters, thresholds, target, grouping. */
export function pipelineReport(cfg = {}, user, today = new Date()) {
  const period = periodRange(cfg.period, today);
  const worstAt = Math.min(100, Math.max(0, num(cfg.worst_threshold, 75)));
  const bestAt = Math.min(worstAt, Math.max(0, num(cfg.best_threshold, 25)));
  const scope = cfg.scope === 'all_open' ? 'all_open' : 'period';
  const includeSlipped = cfg.include_slipped !== false;
  const f = cfg.filters || {};
  const todayIso = iso(today);

  const where = [], params = [];
  if (scopeOf(user, 'deals.view') === 'own') { where.push('d.owner_id=?'); params.push(user.id); }
  const owners = arr(f.owner_ids).map(Number).filter(Boolean); if (owners.length) { where.push(`d.owner_id IN (${owners.map(() => '?').join(',')})`); params.push(...owners); }
  const accounts = arr(f.account_ids).map(Number).filter(Boolean); if (accounts.length) { where.push(`d.account_id IN (${accounts.map(() => '?').join(',')})`); params.push(...accounts); }
  const stages = arr(f.stages); if (stages.length) { where.push(`d.stage IN (${stages.map(() => '?').join(',')})`); params.push(...stages); }
  if (f.min_amount !== undefined && f.min_amount !== '') { where.push('d.amount >= ?'); params.push(Number(f.min_amount)); }
  if (f.max_amount !== undefined && f.max_amount !== '') { where.push('d.amount <= ?'); params.push(Number(f.max_amount)); }
  if (f.q) { where.push('(d.name LIKE ? OR a.name LIKE ?)'); params.push(`%${f.q}%`, `%${f.q}%`); }
  const cfDefs = listFields('deals').filter((x) => !x.archived);
  for (const [k, v] of Object.entries(f.custom || {})) {
    const def = cfDefs.find((x) => x.key === k); if (!def || v === '' || v === null || (Array.isArray(v) && !v.length)) continue;
    const vals = arr(v); where.push(`json_extract(d.custom, ?) IN (${vals.map(() => '?').join(',')})`); params.push(`$.${k}`, ...vals);
  }
  const W = where.length ? ` AND ${where.join(' AND ')}` : '';

  // average sales cycle (created → won), used to estimate a close date for open deals without one
  const cyc = get(`SELECT AVG(julianday(d.closed_at) - julianday(d.created_at)) AS days, COUNT(*) n FROM deals d LEFT JOIN accounts a ON a.id=d.account_id WHERE d.stage='won' AND d.closed_at IS NOT NULL${W}`, ...params);
  const cycleDays = cyc.n ? Math.max(1, Math.round(cyc.days)) : 60;

  const rows = all(`SELECT d.*, a.name AS account_name, u.name AS owner_name, TRIM(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')) AS contact_name, fx.amount2,
      (SELECT MAX(h.changed_at) FROM deal_stage_history h WHERE h.deal_id=d.id) AS stage_since
    FROM deals d LEFT JOIN accounts a ON a.id=d.account_id LEFT JOIN users u ON u.id=d.owner_id LEFT JOIN contacts c ON c.id=d.contact_id LEFT JOIN deal_fx fx ON fx.deal_id=d.id
    WHERE 1=1${W}`, ...params);

  const days = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(String(a).slice(0, 10) + 'T00:00:00Z')) / DAY);
  const deals = [];
  for (const r of rows) {
    const closed = CLOSED.includes(r.stage);
    let est = r.close_date, estimated = false;
    if (!closed && !est) { const e = new Date(new Date(String(r.created_at).slice(0, 10) + 'T00:00:00Z').getTime() + cycleDays * DAY); est = iso(e < today ? today : e); estimated = true; }
    const closedOn = closed ? String(r.closed_at || r.close_date || r.created_at).slice(0, 10) : null;
    const slipped = !closed && !!r.close_date && r.close_date < todayIso;
    let inPeriod;
    if (closed) inPeriod = closedOn >= period.from && closedOn <= period.to;
    else if (scope === 'all_open') inPeriod = true;
    else inPeriod = (est >= period.from && est <= period.to) || (includeSlipped && slipped && est < period.from && period.to >= todayIso);
    if (!inPeriod) continue;
    const prob = Number(r.probability) || 0;
    const category = r.stage === 'won' ? 'won' : r.stage === 'lost' ? 'lost' : prob >= worstAt ? 'commit' : prob >= bestAt ? 'best_case' : 'pipeline';
    if (arr(f.categories).length && !arr(f.categories).includes(category)) continue;
    let custom = {}; try { custom = JSON.parse(r.custom || '{}'); } catch { /* ignore */ }
    deals.push({
      id: r.id, name: r.name, account_id: r.account_id, account_name: r.account_name, owner_id: r.owner_id, owner_name: r.owner_name, contact_name: r.contact_name || null,
      stage: r.stage, stage_label: stageLabelOf(r.stage), category, amount: r.amount, amount2: r.amount2 ?? null, probability: prob,
      weighted: r.stage === 'won' ? r.amount : r.stage === 'lost' ? 0 : r.amount * prob / 100,
      close_date: r.close_date, est_close: closed ? closedOn : est, estimated, slipped, closed_on: closedOn,
      created_at: String(r.created_at).slice(0, 10), age_days: days(r.created_at, todayIso),
      days_in_stage: days(r.stage_since || r.created_at, todayIso), close_month: (closed ? closedOn : est).slice(0, 7), custom,
    });
  }

  const sum = (list, k = 'amount') => list.reduce((a, d) => a + (Number(d[k]) || 0), 0);
  const totals = (list) => {
    const won = list.filter((d) => d.category === 'won'), lost = list.filter((d) => d.category === 'lost'), open = list.filter((d) => !['won', 'lost'].includes(d.category));
    const commit = open.filter((d) => d.category === 'commit'), best = open.filter((d) => d.category === 'best_case');
    const has2 = list.some((d) => d.amount2 !== null);
    const t = {
      count: list.length, open_count: open.length, won_count: won.length, lost_count: lost.length,
      won: sum(won), lost: sum(lost), pipeline: sum(open), commit: sum(commit), best_case_only: sum(best), weighted_open: sum(open, 'weighted'),
      worst_case: sum(won) + sum(commit), projected: sum(won) + sum(open, 'weighted'), best_case: sum(won) + sum(commit) + sum(best),
      slipped_count: open.filter((d) => d.slipped).length, slipped: sum(open.filter((d) => d.slipped)),
    };
    if (has2) Object.assign(t, { won2: sum(won, 'amount2'), pipeline2: sum(open, 'amount2'), worst_case2: sum(won, 'amount2') + sum(commit, 'amount2'),
      projected2: sum(won, 'amount2') + open.reduce((a, d) => a + (Number(d.amount2) || 0) * d.probability / 100, 0), best_case2: sum(won, 'amount2') + sum(commit, 'amount2') + sum(best, 'amount2') });
    return t;
  };
  const summary = totals(deals);
  const decided = summary.won_count + summary.lost_count;
  summary.win_rate = decided ? summary.won_count / decided : null;
  summary.avg_won = summary.won_count ? summary.won / summary.won_count : null;
  summary.cycle_days = cycleDays; summary.cycle_from_history = !!cyc.n;
  summary.new_deals = get(`SELECT COUNT(*) n FROM deals d LEFT JOIN accounts a ON a.id=d.account_id WHERE substr(d.created_at,1,10) BETWEEN ? AND ?${W}`, period.from, period.to, ...params).n;
  const target = num(cfg.target, null);
  if (target) Object.assign(summary, { target, attainment: summary.won / target, gap_worst: target - summary.worst_case, gap_projected: target - summary.projected, gap_best: target - summary.best_case });

  // month by month inside the period (or next months for "all open")
  const months = [];
  for (let [y, m] = [+period.from.slice(0, 4), +period.from.slice(5, 7)]; `${y}-${String(m).padStart(2, '0')}` <= period.to.slice(0, 7); [y, m] = addMonths(y, m, 1)) months.push(`${y}-${String(m).padStart(2, '0')}`);
  const byMonth = months.map((mo) => ({ key: mo, label: new Date(`${mo}-01T00:00:00Z`).toLocaleString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' }), ...totals(deals.filter((d) => d.close_month === mo || (d.slipped && d.close_month < months[0] && mo === months[0]))) }));

  const groupBy = ['owner', 'stage', 'account', 'category', 'month'].includes(cfg.group_by) ? cfg.group_by : 'owner';
  const CAT = { commit: 'Commit', best_case: 'Best case', pipeline: 'Pipeline', won: 'Won', lost: 'Lost' };
  const keyOf = { owner: (d) => [d.owner_id || 0, d.owner_name || 'Unassigned'], stage: (d) => [d.stage, d.stage_label], account: (d) => [d.account_id || 0, d.account_name || 'No account'], category: (d) => [d.category, CAT[d.category]], month: (d) => [d.close_month, d.close_month] };
  const groups = new Map();
  for (const d of deals) { const [k, label] = keyOf[groupBy](d); if (!groups.has(k)) groups.set(k, { key: k, label, deals: [] }); groups.get(k).deals.push(d); }
  const order = groupBy === 'stage' ? (g) => STAGES.findIndex((s) => s.key === g.key) : groupBy === 'category' ? (g) => Object.keys(CAT).indexOf(g.key) : null;
  const grouped = [...groups.values()].map((g) => ({ key: g.key, label: g.label, ...totals(g.deals) }))
    .sort((a, b) => (order ? order(a) - order(b) : groupBy === 'month' ? String(a.key).localeCompare(String(b.key)) : b.projected - a.projected));

  return { period, settings: { worst_threshold: worstAt, best_threshold: bestAt, scope, include_slipped: includeSlipped, group_by: groupBy }, summary, by_month: byMonth, groups: grouped, deals,
    categories: CAT, custom_fields: cfDefs.map((x) => ({ key: x.key, label: x.label, type: x.type, options: x.options || x.config?.options || null })), generated_at: new Date().toISOString() };
}

POST('/api/reports/pipeline', ({ body, user }) => pipelineReport(body || {}, user));

// ---------- saved report views (personal, or shared with everyone) ----------
const viewOut = (v) => ({ id: v.id, name: v.name, shared: !!v.shared, owner_id: v.owner_id, owner_name: v.owner_name, config: JSON.parse(v.config || '{}'), updated_at: v.updated_at });
GET('/api/reports/views', ({ user }) => all(`SELECT v.*, u.name AS owner_name FROM report_views v LEFT JOIN users u ON u.id=v.owner_id WHERE v.kind='pipeline' AND (v.owner_id=? OR v.shared=1) ORDER BY v.name`, user.id).map(viewOut));
function viewInput(body) {
  const name = String(body.name || '').trim().slice(0, 80); if (!name) throw bad('Give the report a name');
  const config = JSON.stringify(body.config || {}); if (config.length > 20000) throw bad('Report settings are too large');
  return { name, config, shared: body.shared ? 1 : 0 };
}
POST('/api/reports/views', ({ body, user }) => {
  const v = viewInput(body);
  const id = Number(run("INSERT INTO report_views (kind, name, config, shared, owner_id) VALUES ('pipeline',?,?,?,?)", v.name, v.config, v.shared, user.id).lastInsertRowid);
  audit(user, 'create', 'report_views', id, v.name);
  return viewOut(get('SELECT v.*, u.name AS owner_name FROM report_views v LEFT JOIN users u ON u.id=v.owner_id WHERE v.id=?', id));
});
const ownView = (id, user) => {
  const v = get('SELECT * FROM report_views WHERE id=?', id); if (!v) throw notFound('Report not found');
  if (v.owner_id !== user.id && user.role !== 'admin') throw forbidden('Only the person who saved this report (or an administrator) can change it.');
  return v;
};
PUT('/api/reports/views/:id', ({ params, body, user }) => {
  const old = ownView(params.id, user); const v = viewInput(body);
  run("UPDATE report_views SET name=?, config=?, shared=?, updated_at=datetime('now') WHERE id=?", v.name, v.config, v.shared, old.id);
  audit(user, 'update', 'report_views', old.id, v.name);
  return viewOut(get('SELECT v.*, u.name AS owner_name FROM report_views v LEFT JOIN users u ON u.id=v.owner_id WHERE v.id=?', old.id));
});
DELETE('/api/reports/views/:id', ({ params, user }) => { const v = ownView(params.id, user); run('DELETE FROM report_views WHERE id=?', v.id); audit(user, 'delete', 'report_views', v.id, v.name); return { ok: true }; });
