/* Insight pages: Insights, Geography, Journeys & Trends, Clusters, Ask/Search, Validation, Glossary.
   Helpers from app.js ($, esc, api, bars, fmt, pct, famColor, outcomeLabel) and glossary.js (T, HELP, sLabel, ...) are used at call time. */
const scoreBar = (v, tip) => `<span class="meter" data-tip="${esc(tip || (v ?? 0).toFixed(2))}"><span style="width:${Math.round((v || 0) * 100)}%"></span></span>`;
const DIMS = ["prevalence", "recurrence", "trend", "evidence_strength", "business_relevance", "geo_concentration"];
const originPill = (o) => o === "verizon_sample" ? `<span class="pill">real sample</span>` : `<span class="pill syn" data-tip="Generated test data calibrated to the real sample; not Verizon customers">${esc(o)}</span>`;
async function post(path, body) {
  const r = await fetch(`/api/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json(); if (!r.ok) throw new Error(j.error || r.statusText); return j;
}
const dimChip = (k, v) => `<span class="dim" data-tip="${esc(`${dimTip(k)} Value ${(v ?? 0).toFixed(2)} (${level(v)}).`)}">${esc(sLabel(k))} ${scoreBar(v)}</span>`;

/* ---------------- Insights (evidence cards) ---------------- */
async function pInsights(params) {
  const qs = new URLSearchParams(params); const d = await api(`cards?${qs}`);
  const st = Object.fromEntries(d.status_counts.map((r) => [r.status, r.n]));
  const fams = ["", "buying", "value", "risk", "need", "friction", "temporal"];
  const W = GLOSS.score_dimensions.map((x) => `${x.label} ${Math.round(x.weight * 100)}%`).join(", ");
  return `<h1>Insight backlog</h1><p class="sub">${T("pattern", "Evidence cards")}: tested findings with the conversations behind them. ${fmt(d.cards.length)} active ·
    draft ${st.draft || 0} · in review ${st.in_review || 0} · approved ${st.approved || 0} · rejected ${st.rejected || 0}.</p>${HELP("insights")}${SCOPE_NOTE}
  <div class="banner">Each card has six separate scores (hover any score for its meaning). The ranking uses the <b>${T("composite", "Priority Score")}</b>, a <b>provisional</b> blend (${esc(W)}) until Verizon approves the weights. Formulas are on the <a href="#/glossary">Glossary</a>.</div>
  <div class="toolbar"><select id="cf">${fams.map((f) => `<option value="${f}" ${params.family === f ? "selected" : ""}>${f ? esc(insightFam(f)) : "All insight families"}</option>`).join("")}</select>
    <select id="cs"><option value="">Any status</option>${["draft", "in_review", "approved", "rejected"].map((s) => `<option ${params.status === s ? "selected" : ""}>${s}</option>`).join("")}</select>
    <input id="cq" placeholder="Search title / scope" value="${esc(params.q || "")}"><button class="primary" id="cgo">Filter</button></div>
  <div class="grid">${d.cards.map((c) => `<div class="cardrow" data-cid="${c.card_id}">
      <div><span class="dot" style="background:${famColor(c.family)}"></span> <span class="t">${esc(c.title)}</span></div>
      <div class="small">${originPill(c.data_origin)} <span class="pill" data-tip="Review status: draft, in review, approved or rejected">${esc(c.status)}</span> <span class="pill" data-tip="${esc(GLOSS.terms.confidence?.definition || "")}">${esc(c.confidence)} confidence</span></div>
      <div class="o">${esc(c.observation)}</div>
      <div class="small muted">${esc(insightFam(c.family))} · ${esc(c.scope)} · ${T("population")} ${esc(c.population)} · <span class="dim" data-tip="${esc(GLOSS.composite?.telecom || "")}"><b>Priority</b> ${scoreBar(c.composite)} ${(c.composite ?? 0).toFixed(2)}</span><div class="dims">${DIMS.map((k) => dimChip(k, c.scores[k])).join("")}</div></div>
    </div>`).join("") || `<div class="empty">No cards match.</div>`}</div><div id="drawer"></div>`;
}
function wireInsights() {
  $("#cgo")?.addEventListener("click", () => { const p = new URLSearchParams(); if ($("#cf").value) p.set("family", $("#cf").value); if ($("#cs").value) p.set("status", $("#cs").value); if ($("#cq").value) p.set("q", $("#cq").value); location.hash = "#/insights?" + p; });
  document.querySelectorAll("[data-cid]").forEach((el) => el.addEventListener("click", () => openCard(el.dataset.cid)));
}
async function openCard(id) {
  const c = await api(`cards/${id}`);
  const m = c.metrics || {};
  const dims = DIMS.map((k) => { const d = sDim(k) || {}; const v = c.scores[k] ?? 0;
    return `<div class="dimrow"><div class="dh"><b>${esc(d.label || k)}</b> <span class="muted small">${esc(d.question || "")}</span><span class="dv">${v.toFixed(2)} · ${level(v)}</span></div>
      <div class="track" style="height:10px"><div class="fill" style="width:${Math.round(v * 100)}%;background:var(--s1)"></div></div>
      <div class="small">${esc(v >= 0.67 ? d.high : v < 0.34 ? d.low : "In between.")} <span class="muted">${esc(d.telecom || "")}</span></div>
      <details class="small"><summary>How this score is calculated (weight ${Math.round((d.weight || 0) * 100)}% of Priority Score)</summary><div>${esc(d.formula || "")}</div><div class="muted">Example: ${esc(d.example || "")}</div></details></div>`; }).join("");
  $("#drawer").innerHTML = `<div class="drawer"><button class="close" id="dx">Close</button>
    <p class="small muted">Card ${c.card_id} · version ${c.version} · ${esc(c.kind)} · ${esc(insightFam(c.family))} · ${originPill(c.data_origin)}</p>
    <h1>${esc(c.title)}</h1><p class="answer">${esc(c.observation)}</p>
    <div class="grid g3"><div class="card tile"><div class="l">${T("population")}</div><div class="v" style="font-size:20px">${esc(c.population)}</div><div class="d">supporting / comparable calls</div></div>
      <div class="card tile"><div class="l">${T("lift", "Lift (shrunk)")}</div><div class="v" style="font-size:20px">${(m.lift_shrunk || 0).toFixed(2)}x</div><div class="d">${T("ci")} ${pct(m.ci_lo)}–${pct(m.ci_hi)} · ${T("qvalue")} ${(m.qval ?? 0).toExponential(1)}</div></div>
      <div class="card tile"><div class="l">${T("confidence")}</div><div class="v" style="font-size:20px">${esc(c.confidence)}</div><div class="d">from Proof Strength</div></div></div>
    <h3>Scope · period · momentum</h3><p>${esc(c.scope)} · ${esc(c.period)} · ${esc(c.trend)}</p>
    <h3>The six scores (separate on purpose)</h3><p class="small muted">${esc(GLOSS.composite?.telecom || "")}</p>
    <div class="dimrow prio"><div class="dh"><b>${esc(GLOSS.composite?.label || "Priority Score")}</b> <span class="muted small">provisional blend</span><span class="dv">${(c.composite ?? 0).toFixed(2)}</span></div>
      <details class="small"><summary>How it is calculated</summary><div>${esc(GLOSS.composite?.formula || "")}</div></details></div>${dims}
    <h3>Evidence (sanitised quotes)</h3>${c.evidence.map((e) => `<div class="quote">“${esc(e.quote)}”<div class="small muted"><a href="#/session/${encodeURIComponent(e.session_id)}">session ${esc(e.session_id.slice(0, 8))}</a> · turn ${e.turn_no ?? "-"} · ${esc(e.source)}</div></div>`).join("")}
    <h3>Business hypothesis</h3><p>${esc(c.hypothesis)}</p><h3>Suggested action (to investigate)</h3><p>${esc(c.action)}</p>
    <h3>KPI hypothesis</h3><p>${esc(c.kpi)}</p>
    <h3>Caveats</h3><ul>${(c.caveats || []).map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
    <h3>Governance</h3><p class="small tag">${esc(JSON.stringify(c.governance))}</p>
    <h3>Versions</h3>${c.versions.map((v) => `<div class="small">v${v.version} · ${esc(v.status)} · from ${esc(v.valid_from)}${v.valid_to ? ` to ${esc(v.valid_to)} (superseded by ${v.superseded_by})` : " (current)"}</div>`).join("")}
    <h3>Review</h3><div class="toolbar"><input id="rv" placeholder="Reviewer" size="14"><input id="rn" placeholder="Note" style="flex:1"></div>
    <div class="toolbar">${["approved", "in_review", "rejected", "draft"].map((s) => `<button data-s="${s}">${s === "approved" ? "Approve" : s === "rejected" ? "Reject" : s === "in_review" ? "Send to review" : "Back to draft"}</button>`).join("")}</div>
    <div id="rmsg" class="small muted"></div>${c.reviews.map((r) => `<div class="small">${esc(r.at)} · ${esc(r.reviewer)} · ${esc(r.action)} ${esc(r.note)}</div>`).join("")}</div>`;
  $("#dx").addEventListener("click", () => ($("#drawer").innerHTML = ""));
  document.querySelectorAll(".drawer button[data-s]").forEach((b) => b.addEventListener("click", async () => {
    try { await post(`cards/${id}/review`, { status: b.dataset.s, reviewer: $("#rv").value, note: $("#rn").value }); $("#rmsg").textContent = `Recorded: ${b.dataset.s}`; }
    catch (e) { $("#rmsg").textContent = e.message; }
  }));
}

/* ---------------- Geography ---------------- */
const US = [[-124.7, 48.4], [-123, 46.2], [-124.2, 42], [-124.4, 40.3], [-122.4, 37.2], [-120.6, 34.5], [-117.1, 32.5], [-114.7, 32.7], [-111, 31.3], [-108.2, 31.3], [-106.5, 31.8], [-103.3, 29], [-101.4, 29.8], [-99.5, 27.5], [-97.4, 25.9], [-97.2, 27.7], [-94.7, 29.4], [-90.2, 29.1], [-89, 30.2], [-85.3, 29.7], [-83.6, 29.9], [-82.7, 27.5], [-81.1, 25.1], [-80.1, 26.6], [-81.4, 30.6], [-79.2, 33.2], [-75.5, 35.2], [-76, 37.3], [-74, 39.5], [-71.1, 41.5], [-69.9, 41.9], [-70.6, 43.1], [-67, 44.8], [-69.2, 47.4], [-71.5, 45], [-75, 45], [-79.2, 43.4], [-82.5, 41.7], [-83.5, 46], [-88.4, 48.3], [-95.2, 49], [-123.3, 49]];
const proj = (lon, lat) => [((lon + 125) / 59) * 900, ((50 - lat) / 26) * 520];
async function pGeo(params) {
  const d = await api("geo"); const metric = params.metric || "opportunity_index";
  if (!d.cities.length) return `<h1>Geography</h1>${HELP("geo")}<div class="card empty"><h2>No cities to show</h2><p>No service-location city has ${GLOSS.thresholds.k_anon || 30} or more sessions in this selection (small groups are hidden for privacy), or the location field is not loaded.</p></div>`;
  const val = (c) => metric === "esc" ? c.esc : metric === "risk" ? c.risk : (c.opportunity_index || 0) / 200;
  const maxS = Math.max(...d.cities.map((c) => c.sessions), 1);
  const ramp = ["var(--f1)", "var(--f2)", "var(--f3)", "var(--f4)", "var(--f5)"];
  const vs = d.cities.map(val), lo = Math.min(...vs), hi = Math.max(...vs);
  const col = (v) => ramp[Math.min(4, Math.floor(((v - lo) / ((hi - lo) || 1)) * 5))];
  const mLabel = { opportunity_index: "Opportunity index (proxy)", esc: "Escalation rate", risk: "Retention-risk share" }[metric];
  return `<h1>Geography</h1><p class="sub">By <b>${T("service_location")}</b> (assumed field contract). Geo coverage ${pct(d.geo_coverage)}. Cities with fewer than ${GLOSS.thresholds.k_anon || 30} sessions are suppressed.</p>${HELP("geo")}
  <div class="tabs">${[["opportunity_index", "Opportunity index"], ["esc", "Escalation rate"], ["risk", "Risk share"]].map(([k, l]) => `<button data-m="${k}" class="${k === metric ? "on" : ""}">${l}</button>`).join("")}</div>
  <div class="grid g2" style="grid-template-columns:1.4fr 1fr"><div class="card"><h2>${esc(mLabel)} by city <span class="muted small">(dot size = sessions)</span></h2>
    <svg class="map" viewBox="0 0 900 520" role="img" aria-label="US map of cities"><polygon points="${US.map(([a, b]) => proj(a, b).join(",")).join(" ")}" fill="var(--surface-2)" stroke="var(--border)"/>
    ${d.cities.filter((c) => c.lat).map((c) => { const [x, y] = proj(c.lon, c.lat); return `<circle cx="${x}" cy="${y}" r="${5 + 14 * Math.sqrt(c.sessions / maxS)}" fill="${col(val(c))}" data-tip="${esc(`${c.city}, ${c.state}: ${fmt(c.sessions)} sessions · opportunity index ${c.opportunity_index} · escalation ${pct(c.esc)} · ${c.patterns} patterns${c.demand_profile ? " · " + c.demand_profile : ""}`)}"/>`; }).join("")}
    </svg><div class="legend"><span>low (${metric === "opportunity_index" ? Math.round(lo * 200) : pct(lo)})</span>${ramp.map((r) => `<span class="dot" style="background:${r}"></span>`).join("")}<span>high (${metric === "opportunity_index" ? Math.round(hi * 200) : pct(hi)}) · colours span the observed range · schematic outline</span></div></div>
    <div class="card" style="overflow:auto;max-height:640px"><h2>Cities</h2><table><tr><th>City</th><th class="num">Sessions</th><th class="num">${T("opp_index", "Opp. index")}</th><th class="num">${T("escalation")}</th><th>Top needs / cards</th></tr>
    ${d.cities.map((c) => `<tr><td><b>${esc(c.city)}</b>, ${esc(c.state)}<div class="small muted" data-tip="${esc(famLabel("geo") + ": a group of cities with a similar mix of needs")}">${esc(c.demand_profile || "")}</div></td><td class="num">${fmt(c.sessions)}</td><td class="num">${num(c.opportunity_index, String)}</td><td class="num">${pct(c.esc)}</td>
      <td class="small">${c.top_intents.map(([n, k]) => esc(n)).join(" · ")}${c.cards.map((k) => `<div><a href="#/insights?q=${encodeURIComponent(c.city)}">▸ ${esc(k.title)}</a></div>`).join("")}</td></tr>`).join("")}</table></div></div>`;
}
function wireGeo() { document.querySelectorAll(".tabs button[data-m]").forEach((b) => b.addEventListener("click", () => (location.hash = "#/geo?metric=" + b.dataset.m))); }

/* ---------------- Journeys & trends ---------------- */
async function pJourneys() {
  const d = await api("journeys");
  const maxW = Math.max(...d.weekly.map((w) => w.n), 1);
  return `<h1>Journeys &amp; trends</h1><p class="sub">Temporal history across ${T("thread", "thread-linked")} contacts and week-by-week change. ${esc(d.note)}</p>${HELP("journeys")}${SCOPE_NOTE}
  <div class="grid g2"><div class="card"><h2>${T("emerging", "Emerging needs")}</h2><p class="muted small">Share of a need in a 2-week window vs the prior 6 weeks, adjusted for the number of windows tested, then ${T("fdr", "false-discovery controlled")}.</p>
    <table><tr><th>Need</th><th>Where</th><th>Window</th><th class="num">Ratio</th><th class="num">${T("support")}</th></tr>${d.emerging.map((e) => `<tr><td>${esc(e.subject_label)}</td><td>${esc(e.dim_value)}</td><td class="small">${esc(e.period)}</td><td class="num">${(e.trend || 0).toFixed(1)}x</td><td class="num">${e.support}</td></tr>`).join("") || `<tr><td colspan="5" class="muted">None significant.</td></tr>`}</table></div>
    <div class="card"><h2>Sessions per week</h2><div class="wk">${d.weekly.map((w) => `<div style="height:${(100 * w.n) / maxW}%" data-tip="week ${esc(w.week)}: ${fmt(w.n)} sessions"></div>`).join("")}</div><p class="muted small">Week 0 = first week in the data window.</p></div>
    <div class="card"><h2>${T("sequence", "What happens next (sequences)")}</h2><p class="muted small">P(next contact is B | previous was A) vs P(B) among all follow-ups. ${T("lift")} shown.</p>
    <table><tr><th>First contact → next contact</th><th class="num">Share</th><th class="num">${T("lift")}</th></tr>${d.sequences.slice(0, 12).map((s) => `<tr><td>${esc(s.subject_label)}</td><td class="num">${pct(s.rate)}</td><td class="num">${(s.lift_shrunk || 0).toFixed(1)}x</td></tr>`).join("") || `<tr><td colspan="3" class="muted">None significant.</td></tr>`}</table></div>
    <div class="card"><h2>Repeat contact</h2>${bars(d.thread_sizes.map((t) => ({ k: `${t.n} contact${t.n > 1 ? "s" : ""} in thread`, v: t.threads })), { label: (r) => r.k, value: (r) => r.v })}
    <h3>${T("need_journey", "Needs that recur across contacts")}</h3><table><tr><th>Need (L2)</th><th class="num">Multi-contact journeys</th><th class="num">Ended ${T("resolved_proxy", "resolved (proxy)")}</th></tr>${d.need_journeys.map((j) => `<tr><td>${esc(j.name)}</td><td class="num">${fmt(j.multi)}</td><td class="num">${pct(j.resolved)}</td></tr>`).join("")}</table></div></div>`;
}

/* ---------------- Clusters ---------------- */
function familyPanel(fam) {
  const f = GLOSS.cluster_families.find((x) => x.key === fam); if (!f) return "";
  return `<div class="card famcard"><h2>${esc(f.label)}</h2><p>${esc(f.what)}</p>
    <div class="kv2"><div>Groups</div><div>${esc(f.unit)}</div><div>Built from</div><div>${esc(f.features)}</div><div>Method</div><div>${esc(f.method)}</div><div>Example</div><div>${esc(f.example)}</div></div></div>`;
}
const criteriaPanel = () => `<details class="howto"><summary>Criteria for clusters (how they are formed and when they are published)</summary>
  <table><tr><th>Criterion</th><th>Rule</th></tr>${GLOSS.cluster_criteria.map((c) => `<tr><td><b>${esc(c.criterion)}</b></td><td>${esc(c.detail)}</td></tr>`).join("")}</table></details>`;
async function pClusters(params) {
  const fam = params.family || "need"; const d = await api(`clusters?family=${fam}`);
  const ms = GLOSS.thresholds.min_stability ?? 0.6, ka = GLOSS.thresholds.k_anon ?? 30;
  return `<h1>Clusters</h1><p class="sub">${T("cluster")}s are groups of similar conversations found by the engine, in four overlapping families. A cluster is published only if its ${T("stability")} is at least ${ms.toFixed(2)} and it has at least ${ka} sessions; labels are machine drafts until reviewed.</p>${HELP("clusters")}${SCOPE_NOTE}
  <div class="tabs">${d.families.map((f) => `<button data-f="${esc(f.family)}" class="${f.family === fam ? "on" : ""}" data-tip="${esc((GLOSS.cluster_families.find((x) => x.key === f.family) || {}).what || "")}">${esc(famLabel(f.family))} (${f.n}, ${f.published} published)</button>`).join("")}</div>
  ${familyPanel(fam)}${criteriaPanel()}
  <div class="card" style="overflow:auto;margin-top:12px"><table><tr><th>#</th><th>Label (draft)</th><th class="num">${T("cluster_size")}</th><th class="num">${T("stability")}</th><th class="num">${T("silhouette")}</th><th class="num">${T("escalation")}</th><th>Top intents / signals</th><th>${T("cluster_status", "Status")}</th></tr>
  ${d.clusters.map((c) => `<tr class="click" data-k="${c.cluster_id}"><td>${c.stable_id}</td><td><b>${esc(c.label)}</b><div class="small muted">${esc((c.top_terms || []).slice(0, 6).join(", "))}</div></td><td class="num">${fmt(c.size)}${c.family === "geo" ? " cities" : ""}</td>
    <td class="num">${num(c.stability, (v) => v.toFixed(2))} ${c.published ? `<span class="pass small" data-tip="${esc(GLOSS.terms.published?.definition || "")}">published</span>` : `<span class="muted small" data-tip="${esc(GLOSS.terms.unpublished?.definition || "")}">unpublished</span>`}</td>
    <td class="num">${num(c.silhouette, (v) => v.toFixed(2))}</td><td class="num">${c.family === "geo" ? "-" : pct(c.esc_rate)}</td>
    <td class="small">${(c.top_intents || []).slice(0, 2).map((x) => esc(Array.isArray(x) ? x[0] : x)).join(" · ")}${(c.top_signals || []).length ? "<br>" + (c.top_signals || []).slice(0, 3).map((x) => esc(Array.isArray(x) ? x[0] : x)).join(" · ") : ""}</td><td>${esc(c.status)}</td></tr>`).join("")}</table></div><div id="drawer"></div>`;
}
function wireClusters() {
  document.querySelectorAll(".tabs button[data-f]").forEach((b) => b.addEventListener("click", () => (location.hash = "#/clusters?family=" + b.dataset.f)));
  document.querySelectorAll("tr[data-k]").forEach((tr) => tr.addEventListener("click", async () => {
    const c = await api(`clusters/${tr.dataset.k}`);
    const ms = GLOSS.thresholds.min_stability ?? 0.6, ka = GLOSS.thresholds.k_anon ?? 30;
    const okS = (c.stability ?? 0) >= ms, okN = (c.sessions ?? c.size) >= ka;
    $("#drawer").innerHTML = `<div class="drawer"><button class="close" id="dx">Close</button><p class="small muted">Cluster ${c.stable_id} · ${esc(famLabel(c.family))} · ${esc(c.status)}</p><h1>${esc(c.label)}</h1>
      <h3>Publication check</h3>
      <div class="gate"><b>${T("stability")} ≥ ${ms.toFixed(2)}</b><span class="${okS ? "pass" : "fail"}">${okS ? "PASS" : "FAIL"}</span><span class="small muted">this cluster: ${num(c.stability, (v) => v.toFixed(2))}</span></div>
      <div class="gate"><b>${T("cluster_size")} ≥ ${ka} sessions</b><span class="${okN ? "pass" : "fail"}">${okN ? "PASS" : "FAIL"}</span><span class="small muted">this cluster: ${fmt(c.sessions ?? c.size)}</span></div>
      <p class="small muted">${c.silhouette != null ? `${T("silhouette")} ${c.silhouette.toFixed(2)}. ` : ""}${esc((GLOSS.cluster_families.find((x) => x.key === c.family) || {}).unit || "")}</p>
      ${c.members ? `<h3>Cities</h3><p>${c.members.map(esc).join(", ")}</p>` : `<h3>Top cities</h3>${bars(c.cities || [], { label: (r) => r.city, value: (r) => r.n })}
      <h3>Representative customer turns</h3>${(c.examples || []).map((e) => `<div class="quote">“${esc(e.user_text)}”<div class="small"><a href="#/session/${encodeURIComponent(e.session_id)}">session ${esc(e.session_id.slice(0, 8))}</a></div></div>`).join("")}`}
      <h3>Review label</h3><div class="toolbar"><input id="rv" placeholder="Reviewer" size="12"><input id="rl" placeholder="New label (for rename)" style="flex:1"></div>
      <div class="toolbar"><button data-a="approve">Approve</button><button data-a="rename">Rename</button><button data-a="reject">Reject</button></div><div id="rmsg" class="small muted"></div></div>`;
    $("#dx").addEventListener("click", () => ($("#drawer").innerHTML = ""));
    document.querySelectorAll(".drawer button[data-a]").forEach((b) => b.addEventListener("click", async () => {
      try { await post(`clusters/${c.cluster_id}/review`, { action: b.dataset.a, reviewer: $("#rv").value, label: $("#rl").value }); $("#rmsg").textContent = "Recorded: " + b.dataset.a; }
      catch (e) { $("#rmsg").textContent = e.message; }
    }));
  }));
}

/* ---------------- Ask / search ---------------- */
async function pAsk(params) {
  let out = "";
  if (params.q) {
    if (params.mode === "search") {
      const d = await api(`search?${new URLSearchParams(params)}`);
      out = `<div class="card"><h2>${d.results.length} conversations · ${T(params.method || "hybrid")}</h2>${d.results.length ? `<table><tr><th>Score</th><th>Need</th><th>City</th><th>${T("outcome")}</th><th>Snippet</th></tr>
        ${d.results.map((r) => `<tr><td class="num">${r.score}</td><td>${esc(r.intent_id)}</td><td>${esc(r.city)}</td><td>${outcomeLabel(r.outcome)}</td><td class="small"><a href="#/session/${encodeURIComponent(r.session_id)}">${esc(r.snippet)}</a>${r.facts_as_of ? `<div class="muted">facts as of: ${r.facts_as_of.map((f) => esc(f.attribute + "=" + f.value)).join("; ")}</div>` : ""}</td></tr>`).join("")}</table>` : `<p class="muted">No conversations matched. Try fewer filters or different words.</p>`}</div>`;
    } else {
      const d = await api(`ask?q=${encodeURIComponent(params.q)}`);
      out = `<div class="card"><h2>Answer</h2><p class="answer">${esc(d.answer)}</p><p class="small muted">${esc(d.method)} · ${esc(d.data_note)}</p>
        <h3>Cards</h3>${d.cards.map((c) => `<div><a href="#/insights?q=${encodeURIComponent(c.scope || "")}">[card ${c.card_id}] ${esc(c.title)}</a> ${originPill(c.data_origin)}</div>`).join("") || "<div class='muted'>none</div>"}
        <h3>Conversations</h3>${d.episodes.map((h) => `<div class="quote">${esc(h.snippet)}<div class="small"><a href="#/session/${encodeURIComponent(h.session_id)}">session ${esc(h.session_id.slice(0, 8))} · ${esc(h.intent_id)} · ${esc(h.city)}</a></div></div>`).join("")}</div>`;
    }
  }
  return `<h1>Ask &amp; search</h1><p class="sub">Retrieval over the conversations and the evidence cards. ${T("bm25", "Keyword")} + ${T("dense", "semantic")} search fused as ${T("hybrid", "hybrid")}, with structured filters and an ${T("asof", "as of")} date. No LLM writes the answers; every statement cites cards or sessions.</p>${HELP("ask")}
  <div class="card"><div class="toolbar"><select id="am"><option value="ask" ${params.mode !== "search" ? "selected" : ""}>Ask a question</option><option value="search" ${params.mode === "search" ? "selected" : ""}>Search conversations</option></select>
    <input id="aq" style="flex:1;min-width:260px" placeholder="e.g. Why are customers in Phoenix calling? / add a line in Austin" value="${esc(params.q || "")}"></div>
    <div class="toolbar"><select id="amt">${["hybrid", "bm25", "dense"].map((m) => `<option value="${m}" ${params.method === m ? "selected" : ""}>${m === "bm25" ? "keyword (bm25)" : m === "dense" ? "semantic (dense)" : "hybrid"}</option>`).join("")}</select>
    <input id="ac" placeholder="City filter" size="12" value="${esc(params.city || "")}"><input id="ai" placeholder="Intent prefix e.g. ADDSVC." size="18" value="${esc(params.intent || "")}">
    <input id="aa" type="date" title="As of" value="${esc((params.asof || "").slice(0, 10))}"><button class="primary" id="ago">Go</button></div>
    <div class="small muted">Try: <a href="#/ask?q=Why%20are%20customers%20in%20Houston%20calling%20about%20outages%3F">outages in Houston</a> · <a href="#/ask?q=add%20a%20line%20opportunities%20in%20Austin">add a line in Austin</a> · <a href="#/ask?q=price%20sensitive%20customers%20in%20Detroit">price sensitivity in Detroit</a> · <a href="#/ask?mode=search&q=travelpass%20abroad&city=Orlando">search: TravelPass, Orlando</a></div></div>
  <div style="margin-top:16px">${out}</div>`;
}
function wireAsk() {
  const go = () => { const p = new URLSearchParams({ q: $("#aq").value, mode: $("#am").value, method: $("#amt").value }); if ($("#ac").value) p.set("city", $("#ac").value); if ($("#ai").value) p.set("intent", $("#ai").value); if ($("#aa").value) p.set("asof", $("#aa").value + " 23:59:59"); location.hash = "#/ask?" + p; };
  $("#ago")?.addEventListener("click", go); $("#aq")?.addEventListener("keydown", (e) => e.key === "Enter" && go());
}

/* ---------------- Validation ---------------- */
async function pValidation() {
  const d = await api("validation");
  if (d.error) return `<h1>Validation</h1>${HELP("validation")}<div class="card empty"><h2>No validation report yet</h2><p>${esc(d.error)}</p></div>`;
  const G = d.gates || {};
  const gateInfo = (k) => { const id = k.startsWith("G") ? k.split("_")[0] : k.startsWith("real") ? "real" : k; return GLOSS.gates[id] || {}; };
  const row = (k, g) => { const s = g.pass === true ? "PASS" : g.pass === false ? "FAIL" : "INFO"; const gi = gateInfo(k);
    return `<div class="gate"><div style="min-width:240px"><b>${esc(gi.name ? `${k.startsWith("G") ? k.split("_")[0] + " " : ""}${gi.name}` : k.replace(/_/g, " "))}</b><div class="small muted">${esc(gi.checks || "")}</div></div>
      <span class="${s === "PASS" ? "pass" : s === "FAIL" ? "fail" : "na"}">${s}</span><div class="small"><div>${esc(g.summary || "")}</div><div class="muted">Pass criterion: ${esc(gi.criterion || "")}</div></div></div>`; };
  return `<h1>Validation</h1><p class="sub">${T("gate", "Acceptance gates")} computed by <span class="tag">python -m cie.validate</span>. Synthetic results prove the pipeline and statistics, not accuracy on real Verizon language.</p>${HELP("validation")}
  ${d.stale ? `<div class="banner warn"><b>This report is older than the latest build of this database</b> (report ${esc(d.generated_at || "unknown")}, build ${esc(d.last_build_at || "")}). Run <span class="tag">python -m cie.validate</span> to refresh it.</div>` : ""}
  <div class="card">${Object.entries(G).map(([k, g]) => row(k, g)).join("")}</div>
  <details style="margin-top:12px"><summary>Full report (JSON)</summary><pre class="small" style="white-space:pre-wrap">${esc(JSON.stringify(d, null, 1))}</pre></details>`;
}

/* ---------------- Glossary & methodology ---------------- */
async function pGlossary(params) {
  const q = (params.q || "").toLowerCase();
  const terms = Object.entries(GLOSS.terms).concat(Object.entries(GLOSS.kpis)).filter(([k, v]) => !q || (v.label + " " + v.definition + " " + k).toLowerCase().includes(q)).sort((a, b) => a[1].label.localeCompare(b[1].label));
  return `<h1>Glossary &amp; methodology</h1><p class="sub">Definitions of every term on every screen, how clusters are formed and published, and exactly how each score is calculated. Scoring version <span class="tag">${esc(GLOSS.thresholds.scoring_version || "")}</span>.</p>
  <div class="toolbar"><a href="#scores">Scores</a> · <a href="#clusters-m">Clusters</a> · <a href="#thresholds">Thresholds</a> · <a href="#terms">Terms</a> · <a href="#gates">Gates</a></div>
  <div class="card" id="scores"><h2>The six scores and the Priority Score</h2>
    <p>Every evidence card is scored on six separate questions, each from 0 (low) to 1 (high). They are shown separately because a card can be big but not growing, or growing fast but thinly evidenced. The Priority Score ranks the backlog and is <b>provisional</b>: its weights are not yet approved by Verizon.</p>
    <table><tr><th>Score</th><th>The question</th><th>What it means in telecom terms</th><th>How it is calculated</th><th class="num">Weight</th></tr>
    ${GLOSS.score_dimensions.map((d) => `<tr><td><b>${esc(d.label)}</b><div class="small muted">stored as <span class="tag">${esc(d.key)}</span></div></td><td>${esc(d.question)}</td><td>${esc(d.telecom)}<div class="small muted">Example: ${esc(d.example)}</div><div class="small"><b>Low:</b> ${esc(d.low)} <b>High:</b> ${esc(d.high)}</div></td><td class="small">${esc(d.formula)}</td><td class="num">${Math.round(d.weight * 100)}%</td></tr>`).join("")}
    <tr><td><b>${esc(GLOSS.composite.label || "Priority Score")}</b><div class="small muted">stored as <span class="tag">composite_provisional</span></div></td><td>What should we look at first?</td><td>${esc(GLOSS.composite.telecom || "")}</td><td class="small">${esc(GLOSS.composite.formula || "")}</td><td class="num">100%</td></tr></table>
    <p class="small muted">Reading a level: 0.67 or more is High, 0.34 to 0.66 Moderate, below 0.34 Low. Confidence labels on cards come from Proof Strength alone.</p></div>
  <div class="card" id="clusters-m" style="margin-top:14px"><h2>How clusters are built</h2><p>Four families group different things. A conversation can appear in several.</p>
    ${GLOSS.cluster_families.map((f) => `<div class="famcard"><h3>${esc(f.label)}</h3><p>${esc(f.what)}</p><div class="kv2"><div>Groups</div><div>${esc(f.unit)}</div><div>Built from</div><div>${esc(f.features)}</div><div>Method</div><div>${esc(f.method)}</div><div>Example</div><div>${esc(f.example)}</div></div></div>`).join("")}
    <h3>Criteria</h3><table><tr><th>Criterion</th><th>Rule</th></tr>${GLOSS.cluster_criteria.map((c) => `<tr><td><b>${esc(c.criterion)}</b></td><td>${esc(c.detail)}</td></tr>`).join("")}</table></div>
  <div class="card" id="thresholds" style="margin-top:14px"><h2>Thresholds that govern publication</h2><table><tr><th>Setting</th><th>Value</th><th>Meaning</th></tr>
    <tr><td>Minimum population</td><td>${GLOSS.thresholds.k_anon}</td><td>No pattern, city, cluster or quote is published for fewer sessions.</td></tr>
    <tr><td>Minimum support</td><td>${GLOSS.thresholds.min_support}</td><td>A pattern needs at least this many supporting sessions.</td></tr>
    <tr><td>Minimum lift</td><td>${GLOSS.thresholds.min_lift}x</td><td>Patterns must be at least this much more (or, for risk, less) common than average, after shrinkage.</td></tr>
    <tr><td>False-discovery level</td><td>${GLOSS.thresholds.fdr_q}</td><td>q-value limit after correcting for the thousands of combinations tested.</td></tr>
    <tr><td>Cluster stability</td><td>${GLOSS.thresholds.min_stability}</td><td>Minimum bootstrap stability for a cluster to be published (${GLOSS.thresholds.n_boot} resamples).</td></tr>
    <tr><td>Novelty similarity</td><td>${GLOSS.thresholds.novelty_cos}</td><td>New calls less similar than this to every cluster are flagged novel.</td></tr></table></div>
  <div class="card" id="terms" style="margin-top:14px"><h2>Terms A to Z</h2><div class="toolbar"><input id="gq" placeholder="Search terms" value="${esc(params.q || "")}" style="flex:1"></div>
    <dl class="terms">${terms.map(([k, v]) => `<dt id="t-${esc(k)}" class="${params.term === k ? "hit" : ""}">${esc(v.label)}</dt><dd>${esc(v.definition)}</dd>`).join("") || "<p class='muted'>No match.</p>"}</dl></div>
  <div class="card" id="gates" style="margin-top:14px"><h2>Acceptance gates</h2><table><tr><th>Gate</th><th>What it checks</th><th>Pass criterion</th></tr>${Object.entries(GLOSS.gates).map(([k, g]) => `<tr><td><b>${esc(k)} ${esc(g.name)}</b></td><td>${esc(g.checks)}</td><td>${esc(g.criterion)}</td></tr>`).join("")}</table></div>`;
}
function wireGlossary(params) {
  $("#gq")?.addEventListener("keydown", (e) => e.key === "Enter" && (location.hash = "#/glossary?q=" + encodeURIComponent(e.target.value)));
  document.querySelectorAll(".toolbar a[href^='#']").forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); document.getElementById(a.getAttribute("href").slice(1))?.scrollIntoView({ behavior: "smooth" }); }));
  if (params.term) document.getElementById("t-" + params.term)?.scrollIntoView({ block: "center" });
}
