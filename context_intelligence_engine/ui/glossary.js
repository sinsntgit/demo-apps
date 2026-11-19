/* Definitions layer: loaded before app.js. Everything shown here comes from GET /api/glossary (cie/glossary.py),
   so the screens, the Glossary page and the docs cannot disagree. Uses esc() from app.js at call time. */
let GLOSS = { terms: {}, kpis: {}, pages: {}, gates: {}, score_labels: {}, score_dimensions: [], cluster_families: [], cluster_criteria: [], insight_families: {}, thresholds: {}, composite: {} };
let SOURCES = null;

async function loadMeta() {
  try { const r = await fetch("/api/glossary"); if (r.ok) GLOSS = await r.json(); } catch (e) { /* UI still works without definitions */ }
  try { const r = await fetch("/api/sources"); if (r.ok) SOURCES = await r.json(); } catch (e) { /* ignore */ }
}

/* term with hover definition (dotted underline); unknown keys fall back to plain text */
const T = (key, text) => {
  const t = GLOSS.terms[key] || GLOSS.kpis[key];
  const label = text ?? (t ? t.label : key);
  return t ? `<span class="term" tabindex="0" data-tip="${esc(t.definition)}">${esc(label)}</span>` : esc(label);
};
const sDim = (k) => GLOSS.score_dimensions.find((d) => d.key === k);
const sLabel = (k) => GLOSS.score_labels[k] || k;
const famLabel = (k) => (GLOSS.cluster_families.find((f) => f.key === k) || {}).label || k;
const insightFam = (k) => GLOSS.insight_families[k] || k;
const dimTip = (k) => { const d = sDim(k); return d ? `${d.label}: ${d.question} ${d.telecom}` : sLabel(k); };
const level = (v) => (v == null ? "n/a" : v >= 0.67 ? "High" : v >= 0.34 ? "Moderate" : "Low");

/* collapsible per-page help */
const HELP = (page) => {
  const p = GLOSS.pages[page];
  if (!p) return "";
  return `<details class="howto"><summary>How to read this page</summary><ul>${p.help.map((h) => `<li>${esc(h)}</li>`).join("")}</ul>
    <a href="#/glossary">Open the glossary and methodology (cluster criteria, score formulas) →</a></details>`;
};
const SCOPE_NOTE = `<div class="scope small">Covers all loaded data. The Data selector does not filter this page: cards, clusters and patterns are computed on the whole dataset.</div>`;

/* Data selector: grey out sources that are not loaded, show counts, never leave the user on an empty selection */
function applySources(selectEl, current, onChange) {
  if (!SOURCES) return current;
  const names = { all: "All sources", verizon_sample: "Real sample", synthetic: "Synthetic", fixtures: "Scripted fixtures" };
  let cur = current;
  [...selectEl.options].forEach((o) => {
    const n = SOURCES[o.value] ?? 0;
    o.textContent = `${names[o.value] || o.value} (${o.value === "all" ? Object.entries(SOURCES).filter(([k]) => k !== "all").reduce((a, [, v]) => a + v, 0).toLocaleString() : n.toLocaleString()})`;
    o.disabled = o.value !== "all" && n === 0;
    if (o.disabled) o.textContent = `${names[o.value] || o.value}: not loaded`;
  });
  if (cur !== "all" && !(SOURCES[cur] > 0)) { cur = "all"; selectEl.value = "all"; if (onChange) onChange(cur); }
  return cur;
}
const emptySource = (src) => `<div class="card empty"><h2>No data for this selection</h2>
  <p>${src === "verizon_sample" ? "The real Verizon sample is not loaded in this database. Put the export at <span class='tag'>sample/verizon_traces_example.jsonl</span> and run <span class='tag'>python run_all.py --rebuild</span>." : "This source has no sessions in the database."}</p>
  <p>Switch <b>Data</b> (top right) to <b>All sources</b> or <b>Synthetic</b>.</p></div>`;
const num = (v, f) => (v == null || (typeof v === "number" && !isFinite(v)) ? "n/a" : f(v));
