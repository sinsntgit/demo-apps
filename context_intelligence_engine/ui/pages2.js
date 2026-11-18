/* W3-W4 pages: Insights, Geography, Journeys & Trends, Clusters, Ask/Search, Validation.
   Loaded before app.js; uses its helpers ($, esc, api, bars, fmt, pct, famColor, outcomeLabel) at call time. */
const scoreBar = (v) => `<span class="meter" data-tip="${(v ?? 0).toFixed(2)}"><span style="width:${Math.round((v || 0) * 100)}%"></span></span>`;
const DIMS = ["prevalence", "recurrence", "trend", "evidence_strength", "business_relevance", "geo_concentration"];
const originPill = (o) => o === "verizon_sample" ? `<span class="pill">real sample</span>` : `<span class="pill syn">${esc(o)}</span>`;
async function post(path, body) {
  const r = await fetch(`/api/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json(); if (!r.ok) throw new Error(j.error || r.statusText); return j;
}

/* ---------------- Insights (evidence cards) ---------------- */
async function pInsights(params) {
  const qs = new URLSearchParams(params); const d = await api(`cards?${qs}`);
  const st = Object.fromEntries(d.status_counts.map((r) => [r.status, r.n]));
  const fams = ["", "buying", "value", "risk", "need", "friction", "temporal"];
  return `<h1>Insight backlog</h1><p class="sub">Evidence cards: scored, governed patterns with quotes, caveats and a business hypothesis. ${fmt(d.cards.length)} active cards ·
    draft ${st.draft || 0} · in review ${st.in_review || 0} · approved ${st.approved || 0} · rejected ${st.rejected || 0}.</p>
  <div class="banner">Scores are shown as six separate dimensions. The ranking uses a <b>provisional</b> composite (weights ${esc(Object.entries(d.score_weights).map(([k, v]) => `${k} ${v}`).join(", "))}) until the customer approves weights.</div>
  <div class="toolbar"><select id="cf">${fams.map((f) => `<option value="${f}" ${params.family === f ? "selected" : ""}>${f ? esc(f) : "All families"}</option>`).join("")}</select>
    <select id="cs"><option value="">Any status</option>${["draft", "in_review", "approved", "rejected"].map((s) => `<option ${params.status === s ? "selected" : ""}>${s}</option>`).join("")}</select>
    <input id="cq" placeholder="Search title / scope" value="${esc(params.q || "")}"><button class="primary" id="cgo">Filter</button></div>
  <div class="grid">${d.cards.map((c) => `<div class="cardrow" data-cid="${c.card_id}">
      <div><span class="dot" style="background:${famColor(c.family)}"></span> <span class="t">${esc(c.title)}</span></div>
      <div class="small">${originPill(c.data_origin)} <span class="pill">${esc(c.status)}</span> <span class="pill">${esc(c.confidence)} confidence</span></div>
      <div class="o">${esc(c.observation)}</div>
      <div class="small muted">${esc(c.kind)} · ${esc(c.scope)} · population ${esc(c.population)} · composite ${scoreBar(c.composite)} · ${DIMS.map((k) => `${k.replace("_", " ")} ${scoreBar(c.scores[k])}`).join(" ")}</div>
    </div>`).join("") || `<div class="empty">No cards match.</div>`}</div><div id="drawer"></div>`;
}
function wireInsights() {
  $("#cgo")?.addEventListener("click", () => { const p = new URLSearchParams(); if ($("#cf").value) p.set("family", $("#cf").value); if ($("#cs").value) p.set("status", $("#cs").value); if ($("#cq").value) p.set("q", $("#cq").value); location.hash = "#/insights?" + p; });
  document.querySelectorAll("[data-cid]").forEach((el) => el.addEventListener("click", () => openCard(el.dataset.cid)));
}
async function openCard(id) {
  const c = await api(`cards/${id}`);
  const m = c.metrics || {};
  $("#drawer").innerHTML = `<div class="drawer"><button class="close" id="dx">Close</button>
    <p class="small muted">Card ${c.card_id} · version ${c.version} · ${esc(c.kind)} · ${esc(c.family)} · ${originPill(c.data_origin)}</p>
    <h1>${esc(c.title)}</h1><p class="answer">${esc(c.observation)}</p>
    <div class="grid g3"><div class="card tile"><div class="l">Population</div><div class="v" style="font-size:20px">${esc(c.population)}</div><div class="d">supporting / denominator</div></div>
      <div class="card tile"><div class="l">Lift (shrunk)</div><div class="v" style="font-size:20px">${(m.lift_shrunk || 0).toFixed(2)}x</div><div class="d">95% CI ${pct(m.ci_lo)}–${pct(m.ci_hi)} · BH q ${(m.qval ?? 0).toExponential(1)}</div></div>
      <div class="card tile"><div class="l">Confidence</div><div class="v" style="font-size:20px">${esc(c.confidence)}</div><div class="d">from evidence strength</div></div></div>
    <h3>Scope · period · trend</h3><p>${esc(c.scope)} · ${esc(c.period)} · ${esc(c.trend)}</p>
    <h3>Score dimensions (separate; composite is provisional)</h3>${bars(DIMS.map((k) => ({ k, v: c.scores[k] || 0 })), { label: (r) => r.k.replace("_", " "), value: (r) => r.v, max: 1, valueFmt: (v) => v.toFixed(2) })}
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
  const val = (c) => metric === "esc" ? c.esc : metric === "risk" ? c.risk : (c.opportunity_index || 0) / 200;
  const maxS = Math.max(...d.cities.map((c) => c.sessions), 1);
  const ramp = ["var(--f1)", "var(--f2)", "var(--f3)", "var(--f4)", "var(--f5)"];
  const vs = d.cities.map(val), lo = Math.min(...vs), hi = Math.max(...vs);
  const col = (v) => ramp[Math.min(4, Math.floor(((v - lo) / ((hi - lo) || 1)) * 5))];
  const mLabel = { opportunity_index: "Opportunity index (proxy)", esc: "Escalation rate", risk: "Retention-risk share" }[metric];
  return `<h1>Geography</h1><p class="sub">By <b>service location</b> (assumed field contract; not where the caller was). Geo coverage ${pct(d.geo_coverage)}. Cities with fewer than 30 sessions are suppressed.</p>
  <div class="tabs">${[["opportunity_index", "Opportunity index"], ["esc", "Escalation rate"], ["risk", "Risk share"]].map(([k, l]) => `<button data-m="${k}" class="${k === metric ? "on" : ""}">${l}</button>`).join("")}</div>
  <div class="grid g2" style="grid-template-columns:1.4fr 1fr"><div class="card"><h2>${esc(mLabel)} by city <span class="muted small">(dot size = sessions)</span></h2>
    <svg class="map" viewBox="0 0 900 520" role="img" aria-label="US map of cities"><polygon points="${US.map(([a, b]) => proj(a, b).join(",")).join(" ")}" fill="var(--surface-2)" stroke="var(--border)"/>
    ${d.cities.filter((c) => c.lat).map((c) => { const [x, y] = proj(c.lon, c.lat); return `<circle cx="${x}" cy="${y}" r="${5 + 14 * Math.sqrt(c.sessions / maxS)}" fill="${col(val(c))}" data-tip="${esc(`${c.city}, ${c.state}: ${fmt(c.sessions)} sessions · opportunity index ${c.opportunity_index} · escalation ${pct(c.esc)} · ${c.patterns} patterns${c.demand_profile ? " · " + c.demand_profile : ""}`)}"/>`; }).join("")}
    </svg><div class="legend"><span>low</span>${ramp.map((r) => `<span class="dot" style="background:${r}"></span>`).join("")}<span>high · schematic outline</span></div></div>
    <div class="card" style="overflow:auto;max-height:640px"><h2>Cities</h2><table><tr><th>City</th><th class="num">Sessions</th><th class="num">Opp. index</th><th class="num">Escalation</th><th>Top needs / cards</th></tr>
    ${d.cities.map((c) => `<tr><td><b>${esc(c.city)}</b>, ${esc(c.state)}<div class="small muted">${esc(c.demand_profile || "")}</div></td><td class="num">${fmt(c.sessions)}</td><td class="num">${c.opportunity_index}</td><td class="num">${pct(c.esc)}</td>
      <td class="small">${c.top_intents.map(([n, k]) => esc(n)).join(" · ")}${c.cards.map((k) => `<div><a href="#/insights?q=${encodeURIComponent(c.city)}">▸ ${esc(k.title)}</a></div>`).join("")}</td></tr>`).join("")}</table></div></div>`;
}
function wireGeo() { document.querySelectorAll(".tabs button[data-m]").forEach((b) => b.addEventListener("click", () => (location.hash = "#/geo?metric=" + b.dataset.m))); }

/* ---------------- Journeys & trends ---------------- */
async function pJourneys() {
  const d = await api("journeys");
  const maxW = Math.max(...d.weekly.map((w) => w.n), 1);
  return `<h1>Journeys &amp; trends</h1><p class="sub">Temporal history across thread-linked contacts (previous_session_id) and week-by-week change. ${esc(d.note)}</p>
  <div class="grid g2"><div class="card"><h2>Emerging needs</h2><p class="muted small">Share of a need in a 2-week window vs the prior 6 weeks, Bonferroni over windows, BH-adjusted.</p>
    <table><tr><th>Need</th><th>Where</th><th>Window</th><th class="num">Ratio</th><th class="num">Support</th></tr>${d.emerging.map((e) => `<tr><td>${esc(e.subject_label)}</td><td>${esc(e.dim_value)}</td><td class="small">${esc(e.period)}</td><td class="num">${(e.trend || 0).toFixed(1)}x</td><td class="num">${e.support}</td></tr>`).join("") || `<tr><td colspan="5" class="muted">None significant.</td></tr>`}</table></div>
    <div class="card"><h2>Sessions per week</h2><div class="wk">${d.weekly.map((w) => `<div style="height:${(100 * w.n) / maxW}%" data-tip="week ${esc(w.week)}: ${fmt(w.n)} sessions"></div>`).join("")}</div><p class="muted small">Week 0 = first week in the data window.</p></div>
    <div class="card"><h2>What happens next (sequences)</h2><p class="muted small">P(next contact is B | previous was A) vs P(B) among all follow-ups.</p>
    <table><tr><th>First contact → next contact</th><th class="num">Share</th><th class="num">Lift</th></tr>${d.sequences.slice(0, 12).map((s) => `<tr><td>${esc(s.subject_label)}</td><td class="num">${pct(s.rate)}</td><td class="num">${(s.lift_shrunk || 0).toFixed(1)}x</td></tr>`).join("")}</table></div>
    <div class="card"><h2>Repeat contact</h2>${bars(d.thread_sizes.map((t) => ({ k: `${t.n} contact${t.n > 1 ? "s" : ""} in thread`, v: t.threads })), { label: (r) => r.k, value: (r) => r.v })}
    <h3>Needs that recur across contacts (need journeys)</h3><table><tr><th>Need (L2)</th><th class="num">Multi-contact journeys</th><th class="num">Ended resolved</th></tr>${d.need_journeys.map((j) => `<tr><td>${esc(j.name)}</td><td class="num">${fmt(j.multi)}</td><td class="num">${pct(j.resolved)}</td></tr>`).join("")}</table></div></div>`;
}

/* ---------------- Clusters ---------------- */
async function pClusters(params) {
  const fam = params.family || "need"; const d = await api(`clusters?family=${fam}`);
  return `<h1>Clusters</h1><p class="sub">Four overlapping cluster families. Stable ids persist across refits; a cluster is published only if bootstrap stability ≥ 0.60 and it has ≥ 30 sessions. Labels are machine drafts until an SME approves or renames them.</p>
  <div class="tabs">${d.families.map((f) => `<button data-f="${esc(f.family)}" class="${f.family === fam ? "on" : ""}">${esc(f.family)} (${f.n}, ${f.published} published)</button>`).join("")}</div>
  <div class="card" style="overflow:auto"><table><tr><th>#</th><th>Label</th><th class="num">Size</th><th class="num">Stability</th><th class="num">Escalation</th><th>Top intents / signals</th><th>Status</th></tr>
  ${d.clusters.map((c) => `<tr class="click" data-k="${c.cluster_id}"><td>${c.stable_id}</td><td><b>${esc(c.label)}</b><div class="small muted">${esc((c.top_terms || []).slice(0, 6).join(", "))}</div></td><td class="num">${fmt(c.size)}</td>
    <td class="num">${(c.stability ?? 0).toFixed(2)} ${c.published ? "" : "<span class='muted small'>(unpublished)</span>"}</td><td class="num">${c.family === "geo" ? "-" : pct(c.esc_rate)}</td>
    <td class="small">${(c.top_intents || []).slice(0, 2).map((x) => esc(Array.isArray(x) ? x[0] : x)).join(" · ")}${(c.top_signals || []).length ? "<br>" + (c.top_signals || []).slice(0, 3).map((x) => esc(Array.isArray(x) ? x[0] : x)).join(" · ") : ""}</td><td>${esc(c.status)}</td></tr>`).join("")}</table></div><div id="drawer"></div>`;
}
function wireClusters() {
  document.querySelectorAll(".tabs button[data-f]").forEach((b) => b.addEventListener("click", () => (location.hash = "#/clusters?family=" + b.dataset.f)));
  document.querySelectorAll("tr[data-k]").forEach((tr) => tr.addEventListener("click", async () => {
    const c = await api(`clusters/${tr.dataset.k}`);
    $("#drawer").innerHTML = `<div class="drawer"><button class="close" id="dx">Close</button><p class="small muted">Cluster ${c.stable_id} · family ${esc(c.family)} · ${esc(c.status)}</p><h1>${esc(c.label)}</h1>
      <p>Size ${fmt(c.size)} · stability ${(c.stability ?? 0).toFixed(2)}${c.silhouette != null ? ` · silhouette ${c.silhouette.toFixed(2)}` : ""}</p>
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
      out = `<div class="card"><h2>${d.results.length} conversations · method ${esc(params.method || "hybrid")}</h2><table><tr><th>Score</th><th>Need</th><th>City</th><th>Outcome</th><th>Snippet</th></tr>
        ${d.results.map((r) => `<tr><td class="num">${r.score}</td><td>${esc(r.intent_id)}</td><td>${esc(r.city)}</td><td>${outcomeLabel(r.outcome)}</td><td class="small"><a href="#/session/${encodeURIComponent(r.session_id)}">${esc(r.snippet)}</a>${r.facts_as_of ? `<div class="muted">facts as of: ${r.facts_as_of.map((f) => esc(f.attribute + "=" + f.value)).join("; ")}</div>` : ""}</td></tr>`).join("")}</table></div>`;
    } else {
      const d = await api(`ask?q=${encodeURIComponent(params.q)}`);
      out = `<div class="card"><h2>Answer</h2><p class="answer">${esc(d.answer)}</p><p class="small muted">${esc(d.method)} · ${esc(d.data_note)}</p>
        <h3>Cards</h3>${d.cards.map((c) => `<div><a href="#/insights?q=${encodeURIComponent(c.scope || "")}">[card ${c.card_id}] ${esc(c.title)}</a> ${originPill(c.data_origin)}</div>`).join("") || "<div class='muted'>none</div>"}
        <h3>Conversations</h3>${d.episodes.map((h) => `<div class="quote">${esc(h.snippet)}<div class="small"><a href="#/session/${encodeURIComponent(h.session_id)}">session ${esc(h.session_id.slice(0, 8))} · ${esc(h.intent_id)} · ${esc(h.city)}</a></div></div>`).join("")}</div>`;
    }
  }
  return `<h1>Ask &amp; search</h1><p class="sub">Retrieval over 100K conversations and the evidence cards: BM25 (keywords) + dense (LSA semantic) fused by reciprocal rank, with structured filters and an "as of" date. No LLM is used to write answers; every statement cites cards or sessions.</p>
  <div class="card"><div class="toolbar"><select id="am"><option value="ask" ${params.mode !== "search" ? "selected" : ""}>Ask a question</option><option value="search" ${params.mode === "search" ? "selected" : ""}>Search conversations</option></select>
    <input id="aq" style="flex:1;min-width:260px" placeholder="e.g. Why are customers in Phoenix calling? / add a line in Austin" value="${esc(params.q || "")}"></div>
    <div class="toolbar"><select id="amt">${["hybrid", "bm25", "dense"].map((m) => `<option ${params.method === m ? "selected" : ""}>${m}</option>`).join("")}</select>
    <input id="ac" placeholder="City filter" size="12" value="${esc(params.city || "")}"><input id="ai" placeholder="Intent prefix e.g. ADDSVC." size="18" value="${esc(params.intent || "")}">
    <input id="aa" type="date" title="As of" value="${esc(params.asof || "")}"><button class="primary" id="ago">Go</button></div>
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
  if (d.error) return `<div class="card empty">${esc(d.error)}</div>`;
  const G = d.gates || {};
  const row = (k, g) => { const s = g.pass === true ? "PASS" : g.pass === false ? "FAIL" : "INFO"; return `<div class="gate"><b>${esc(k.replace(/_/g, " "))}</b><span class="${s === "PASS" ? "pass" : s === "FAIL" ? "fail" : "na"}">${s}</span><span class="small muted">${esc(g.summary || "")}</span></div>`; };
  return `<h1>Validation</h1><p class="sub">Acceptance gates computed by <span class="tag">python -m cie.validate</span>. Synthetic results prove the pipeline and statistics; they do <b>not</b> prove accuracy on real Verizon language (see real-sample gold, which needs SME review).</p>
  <div class="card">${Object.entries(G).map(([k, g]) => row(k, g)).join("")}</div>
  <details style="margin-top:12px"><summary>Full report (JSON)</summary><pre class="small" style="white-space:pre-wrap">${esc(JSON.stringify(d, null, 1))}</pre></details>`;
}
