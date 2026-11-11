import { GET, PUT, DELETE, bad, notFound } from './http.js';
import { all, get, run, audit, nowIso } from './db.js';
import { getSetting, setSetting } from './settings.js';

/*
 * Deal currencies: every deal is entered in Currency 1 and shown in Currency 2 too.
 * Rates are kept per calendar year (1 unit of Currency 1 = rate units of Currency 2) and never thrown away:
 * changing the pair keeps the old pair's years, and every rate change is logged in fx_rate_changes.
 * Which year applies to a deal is decided in the deal_fx view (see migration 8).
 */
export const currencyPair = () => ({ c1: getSetting('currency.c1', 'USD'), c2: getSetting('currency.c2', null) || null });
const validCode = (c) => { const s = String(c || '').trim().toUpperCase(); if (!/^[A-Z]{3}$/.test(s)) return null; try { new Intl.NumberFormat('en', { style: 'currency', currency: s }); return s; } catch { return null; } };
export const ratesFor = (c1, c2) => (c2 ? all('SELECT year, rate, note, updated_at, updated_by_name FROM fx_rates WHERE c1=? AND c2=? ORDER BY year DESC', c1, c2) : []);
/** What every page needs to show amounts (sent with /api/meta). */
export function currencyMeta() {
  const { c1, c2 } = currencyPair(); const rates = ratesFor(c1, c2).map((r) => ({ year: r.year, rate: r.rate }));
  const year = new Date().getFullYear();
  return { c1, c2, rates, current_rate: rates.find((r) => r.year <= year)?.rate ?? null, missing_current_year: !!c2 && !rates.some((r) => r.year === year) };
}

GET('/api/currency', () => {
  const { c1, c2 } = currencyPair();
  return {
    c1, c2, rates: ratesFor(c1, c2),
    history: all('SELECT * FROM fx_rate_changes ORDER BY id DESC LIMIT 200'),
    other_pairs: all('SELECT c1, c2, COUNT(*) AS years, MIN(year) AS first_year, MAX(year) AS last_year FROM fx_rates WHERE NOT (c1=? AND c2=?) GROUP BY c1, c2', c1, c2 || ''),
    deals_without_rate: c2 ? get('SELECT COUNT(*) n FROM deals d JOIN deal_fx fx ON fx.deal_id=d.id WHERE fx.fx_rate IS NULL').n : 0,
    deals_using_fallback: c2 ? get('SELECT COUNT(*) n FROM deals d JOIN deal_fx fx ON fx.deal_id=d.id WHERE fx.fx_rate IS NOT NULL AND fx.fx_exact=0').n : 0,
  };
});

PUT('/api/currency', ({ body, user }) => {
  const c1 = validCode(body.c1); if (!c1) throw bad('Currency 1 must be a 3-letter currency code such as USD, SAR, INR or AED');
  const c2raw = String(body.c2 || '').trim(); const c2 = c2raw ? validCode(c2raw) : null;
  if (c2raw && !c2) throw bad('Currency 2 must be a 3-letter currency code such as USD, SAR, INR or AED');
  if (c2 && c2 === c1) throw bad('Currency 2 must be different from Currency 1');
  const before = currencyPair();
  setSetting('currency.c1', c1); setSetting('currency.c2', c2);
  if (before.c1 !== c1 || before.c2 !== c2) {
    run('INSERT INTO fx_rate_changes (c1,c2,year,old_rate,new_rate,note,changed_by_name) VALUES (?,?,?,?,?,?,?)', c1, c2 || '', 0, null, null, `Currencies changed from ${before.c1}${before.c2 ? ' → ' + before.c2 : ''} to ${c1}${c2 ? ' → ' + c2 : ''}`, user.name);
    audit(user, 'update', 'settings', 0, `deal currencies ${c1}/${c2 || '-'}`);
  }
  return currencyMeta();
});

PUT('/api/currency/rates/:year', ({ params, body, user }) => {
  const { c1, c2 } = currencyPair(); if (!c2) throw bad('Choose Currency 2 first');
  const year = Number(params.year); if (!Number.isInteger(year) || year < 1990 || year > 2100) throw bad('Enter a year between 1990 and 2100');
  const rate = Number(body.rate); if (!Number.isFinite(rate) || rate <= 0 || rate > 1e7) throw bad(`Enter how many ${c2} one ${c1} is worth (a number above 0)`);
  const note = String(body.note || '').trim().slice(0, 200) || null;
  const old = get('SELECT rate FROM fx_rates WHERE c1=? AND c2=? AND year=?', c1, c2, year);
  if (old && old.rate === rate && !note) return ratesFor(c1, c2);
  run(`INSERT INTO fx_rates (c1,c2,year,rate,note,updated_at,updated_by_name) VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(c1,c2,year) DO UPDATE SET rate=excluded.rate, note=excluded.note, updated_at=excluded.updated_at, updated_by_name=excluded.updated_by_name`, c1, c2, year, rate, note, nowIso(), user.name);
  run('INSERT INTO fx_rate_changes (c1,c2,year,old_rate,new_rate,note,changed_by_name) VALUES (?,?,?,?,?,?,?)', c1, c2, year, old?.rate ?? null, rate, note, user.name);
  audit(user, 'update', 'settings', 0, `${year} rate 1 ${c1} = ${rate} ${c2}${old ? ` (was ${old.rate})` : ''}`);
  return ratesFor(c1, c2);
});

DELETE('/api/currency/rates/:year', ({ params, user }) => {
  const { c1, c2 } = currencyPair(); const year = Number(params.year);
  const old = get('SELECT rate FROM fx_rates WHERE c1=? AND c2=? AND year=?', c1, c2, year); if (!old) throw notFound('No rate for that year');
  run('DELETE FROM fx_rates WHERE c1=? AND c2=? AND year=?', c1, c2, year);
  run('INSERT INTO fx_rate_changes (c1,c2,year,old_rate,new_rate,note,changed_by_name) VALUES (?,?,?,?,?,?,?)', c1, c2, year, old.rate, null, 'Rate removed', user.name);
  audit(user, 'delete', 'settings', 0, `${year} rate ${c1}/${c2}`);
  return ratesFor(c1, c2);
});
