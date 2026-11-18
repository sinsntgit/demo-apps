/* Context Intelligence Engine — Week-1 UI. Vanilla JS, no external assets.
   All trace text is untrusted: every interpolation goes through esc(). */
const $ = (s, el = document) => el.querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (n) => (n ?? 0).toLocaleString();
const pct = (x) => `${Math.round((x || 0) * 100)}%`;
const FAM = { need: 1, buying: 2, value: 3, risk: 4, friction: 5, experience: 6, geo: 7, temporal: 8 };   // fixed slot order
const famColor = (f) => `var(--s${FAM[f] || 1})`;
const OUTCOME = [["escalated", "Escalated (handoff)", 1], ["abandoned", "Abandoned", 2], ["resolved_proxy", "Resolved (proxy)", 3]];
const store = { get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };

let SRC = store.get("cie.src", "all");
async function api(path) {
  const sep = path.includes("?") ? "&" : "?";
  const r = await fetch(`/api/${path}${sep}source=${SRC}`);
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

/* ---------- tooltip (hover layer for every mark with data-tip) ---------- */
const tip = $("#tip");
document.addEventListener("mousemove", (e) => {
  const t = e.target.closest("[data-tip]");
  if (!t) { tip.style.display = "none"; return; }
  tip.textContent = t.dataset.tip; tip.style.display = "block";
  tip.style.left = Math.min(e.clientX + 12, innerWidth - 330) + "px"; tip.style.top = e.clientY + 14 + "px";
});

/* ---------- chart helpers ---------- */
function bars(rows, { label, value, color = () => "var(--s1)", tipf, max, valueFmt = fmt, swatch }) {
  const m = max ?? Math.max(1, ...rows.map(value));
  return `<div class="bars">${rows.map((r) => `
    <div class="bar" data-tip="${esc(tipf ? tipf(r) : `${label(r)}: ${valueFmt(value(r))}`)}">
      <div class="lab">${swatch ? `<span class="dot" style="background:${color(r)}"></span>` : ""}${esc(label(r))}</div>
      <div class="track"><div class="fill" style="width:${(100 * value(r)) / m}%;background:${color(r)}"></div></div>
      <div class="val">${esc(valueFmt(value(r)))}</div></div>`).join("")}</div>`;
}
function outcomeStack(rows) {
  const tot = rows.reduce((a, r) => a + r.n, 0) || 1;
  const by = Object.fromEntries(rows.map((r) => [r.k, r.n]));
  return `<div class="stack" role="img" aria-label="Session outcomes">${OUTCOME.map(([k, l, s]) => by[k] ? `<div style="width:${(100 * by[k]) / tot}%;background:var(--s${s})" data-tip="${esc(l)}: ${fmt(by[k])} (${pct(by[k] / tot)})"></div>` : "").join("")}</div>
  <div class="legend">${OUTCOME.map(([k, l, s]) => `<span><span class="dot" style="background:var(--s${s})"></span> ${esc(l)} <b>${fmt(by[k] || 0)}</b> · ${pct((by[k] || 0) / tot)}</span>`).join("")}</div>`;
}
const srcPill = (s) => s === "verizon_sample" ? `<span class="pill">real sample</span>` : `<span class="pill syn" title="Synthetic scenario fixture">synthetic</span>`;
const sigChip = (s) => `<span class="pill" data-tip="${esc(`${s.category} · ${s.type} · ${s.method} · conf ${s.confidence}${s.value ? " · " + s.value : ""}`)}"><span class="dot" style="background:${famColor(s.family)}"></span>${esc(s.type)}</span>`;
const outcomeLabel = (o) => { const x = OUTCOME.find((z) => z[0] === o); return x ? `<span class="status"><span class="dot" style="background:var(--s${x[2]})"></span>${esc(x[1])}</span>` : esc(o); };

/* ---------- pages ---------- */
async function pOverview() {
  const d = await api("overview");
  const k = d.kpi, sessions = k.sessions || 1;
  const synth = d.sources.some((s) => s.k !== "verizon_sample");
  const P = d.proxies || {};
  return `<h1>Overview</h1><p class="sub">Traces → signals → episodes → clusters → patterns → scores → evidence cards. ${fmt(d.patterns)} significant patterns · ${fmt(d.clusters)} clusters · <a href="#/insights">${fmt(d.cards)} evidence cards</a>.</p>
  ${synth ? `<div class="banner">This view includes <b>synthetic conversations</b> (100,000 generated sessions calibrated to the real sample, with planted patterns for validation). Numbers describe the generated population, not Verizon customers. Switch <b>Data</b> to "Real sample (36)" for real traces only.</div>` : ""}
  <div class="grid g4">
    <div class="card tile"><div class="l">Sessions</div><div class="v">${fmt(k.sessions)}</div><div class="d">${d.sources.map((s) => `${esc(s.k)} ${fmt(s.n)}`).join(" · ")}</div></div>
    <div class="card tile"><div class="l">Escalated to a human</div><div class="v">${pct((d.outcomes.find((o) => o.k === "escalated") || {}).n / sessions)}</div><div class="d">transfer tool executed</div></div>
    <div class="card tile"><div class="l">Buying / value signal present</div><div class="v">${pct(k.opportunity_sessions / sessions)}</div><div class="d">${fmt(k.opportunity_sessions)} sessions · opportunity proxy</div></div>
    <div class="card tile"><div class="l">Mean friction score</div><div class="v">${k.avg_friction.toFixed(2)}</div><div class="d">0 = smooth · 1 = heavy (weighted friction signals)</div></div>
  </div>
  <div class="card" style="margin-top:16px"><h2>KPI proxies <span class="pill">proxy</span></h2><p class="muted small">${esc(P.note || "")}</p>
    <div class="grid g4">
      <div class="tile" data-tip="Sessions with a buying-intent or value signal and no churn intent"><div class="l">Qualified opportunity volume</div><div class="v">${fmt(P.qualified_opportunity_volume)}</div><div class="d">${P.opportunity_density_per_100} per 100 sessions</div></div>
      <div class="tile" data-tip="Share of qualified opportunities with explicit willingness language"><div class="l">Conversion proxy</div><div class="v">${pct(P.conversion_proxy)}</div><div class="d">willingness among opportunities</div></div>
      <div class="tile" data-tip="Need/buying episodes that ended escalated or abandoned"><div class="l">Unmet-need share</div><div class="v">${pct(P.unmet_need_share)}</div><div class="d">need/buying episodes not contained</div></div>
      <div class="tile" data-tip="Sessions followed by a thread-linked contact within 7 days"><div class="l">Repeat contact (7 days)</div><div class="v">${pct(P.repeat_contact_rate_7d)}</div><div class="d">thread-linked only</div></div>
      <div class="tile" data-tip="Churn-intent sessions with no handoff and no follow-up contact"><div class="l">Save-rate proxy</div><div class="v">${P.save_rate_proxy == null ? "-" : pct(P.save_rate_proxy)}</div><div class="d">${fmt(P.churn_intent_sessions)} churn-intent sessions</div></div>
    </div></div>
  <div class="grid g2" style="margin-top:16px">
    <div class="card"><h2>Pipeline funnel</h2>${bars(d.funnel, { label: (r) => r.stage, value: (r) => r.n, color: (r) => `var(--f${d.funnel.indexOf(r) + 1})` })}
      <p class="muted small">Ordinal steps of one hue. Signals and episodes are child records of sessions.</p></div>
    <div class="card"><h2>Session outcomes</h2>${outcomeStack(d.outcomes)}
      <h3>Authentication state</h3>${bars(d.auth, { label: (r) => r.k, value: (r) => r.n })}
      <p class="muted small">"Resolved" is a proxy: no handoff and no abandonment. Not a verified resolution.</p></div>
    <div class="card"><h2>Sessions with a signal, by family</h2>${bars(d.families, { label: (r) => r.label, value: (r) => r.share, color: (r) => famColor(r.family), swatch: true, max: 1, valueFmt: pct, tipf: (r) => `${r.label}: ${fmt(r.sessions)} sessions (${pct(r.share)}), ${fmt(r.signals)} signals` })}</div>
    <div class="card"><h2>Primary intent, by L1 domain</h2>${bars(d.l1, { label: (r) => r.k, value: (r) => r.n })}
      <h3>Service location source</h3>${bars(d.geo_source, { label: (r) => r.k, value: (r) => r.n })}
      <p class="muted small">Real sample locations are <b>assumed</b> until Verizon supplies the field (AGENTS.md §2.7).</p></div>
  </div>`;
}

async function pSessions(params) {
  const qs = new URLSearchParams(params);
  const d = await api(`sessions?${qs}`);
  return `<h1>Session Explorer</h1><p class="sub">${fmt(d.total)} sessions. Open one to see its transcript with signals, intents, episodes and evaluations.</p>
  <div class="toolbar">
    <input id="q" placeholder="Search text or id" value="${esc(params.q || "")}">
    <input id="fi" placeholder="Intent prefix e.g. BILL." value="${esc(params.intent || "")}" size="18">
    <input id="fs" placeholder="Signal type e.g. churn_intent" value="${esc(params.signal || "")}" size="22">
    <select id="fo"><option value="">Any outcome</option>${OUTCOME.map(([k, l]) => `<option value="${k}" ${params.outcome === k ? "selected" : ""}>${l}</option>`).join("")}</select>
    <button class="primary" id="go">Filter</button></div>
  <div class="card" style="padding:0;overflow:auto;max-height:70vh"><table><thead><tr><th>Session</th><th>Data</th><th>Primary intent</th><th>Outcome</th><th>Segment</th><th class="num">Traces</th><th class="num">Signals</th><th>Service location</th><th>Thread</th></tr></thead><tbody>
  ${d.rows.map((r) => `<tr class="click" data-sid="${esc(r.session_id)}"><td><span class="tag">${esc((r.external_id || r.session_id).slice(0, 22))}</span></td><td>${srcPill(r.source)}</td>
    <td>${esc(r.primary_intent)} <span class="muted small">${r.intent_conf ?? ""}</span></td><td>${outcomeLabel(r.outcome)}</td><td>${esc(r.segment)}</td>
    <td class="num">${r.n_traces}</td><td class="num">${r.n_signals}</td><td>${esc(r.city)}${r.state ? ", " + esc(r.state) : ""}</td><td class="small muted">${r.thread_pos ? "follow-up #" + r.thread_pos : ""}</td></tr>`).join("") || `<tr><td colspan="9" class="empty">No sessions match.</td></tr>`}
  </tbody></table></div>`;
}
function wireSessions() {
  const go = () => { const p = new URLSearchParams(); [["q", "#q"], ["intent", "#fi"], ["signal", "#fs"], ["outcome", "#fo"]].forEach(([k, s]) => { const v = $(s).value.trim(); if (v) p.set(k, v); }); location.hash = "#/sessions?" + p; };
  $("#go")?.addEventListener("click", go);
  ["#q", "#fi", "#fs"].forEach((s) => $(s)?.addEventListener("keydown", (e) => e.key === "Enter" && go()));
  document.querySelectorAll("tr[data-sid]").forEach((tr) => tr.addEventListener("click", () => (location.hash = "#/session/" + encodeURIComponent(tr.dataset.sid))));
}

async function pSession(sid) {
  const d = await api(`sessions/${encodeURIComponent(sid)}`);
  const s = d.session;
  const prim = d.intents.find((i) => i.role === "primary");
  const epOf = (seq) => d.episodes.find((e) => seq >= e.start_seq && seq <= e.end_seq);
  let html = "", lastEp = null;
  for (const t of d.turns) {
    const ep = epOf(t.seq);
    if (ep !== lastEp) {
      if (lastEp) html += "</div>";
      html += `<div class="ep ${ep?.kind || ""}"><div class="ep-h"><b>Episode ${ep?.ep_no ?? "-"} · ${esc(ep?.kind)}</b>${ep?.intent_id ? `<span class="tag">${esc(ep.intent_id)}</span> ${esc(ep.intent_name || "")}` : ""}
        ${ep?.kind === "goal" ? `· ${outcomeLabel(ep.outcome)} · friction ${ep.friction} · boundary: ${esc(ep.boundary_reason)}` : ""}</div>`;
      lastEp = ep;
    }
    const who = `<div class="who"><span>turn ${t.turn_no ?? "?"} · seq ${t.seq}</span>${t.intent ? `<span data-tip="${esc(`${t.intent.method} · conf ${t.intent.confidence} · ${t.intent.evidence}`)}">intent <span class="tag">${esc(t.intent.intent_id)}</span></span>` : ""}${t.lang && t.lang !== "en" ? `<span class="pill">lang ${esc(t.lang)}</span>` : ""}</div>`;
    const user = t.kind === "event" ? `<div class="msg event">${esc(t.event_type)}${t.event_value ? " · " + esc(t.event_value) : ""}</div>` : `<div class="msg user">${who}${esc(t.user_text)}</div>`;
    const chips = t.signals.length ? `<div class="chips">${t.signals.map(sigChip).join("")}</div>` : "";
    const tools = t.tools.length ? `<div class="chips">${t.tools.map((x) => `<span class="pill" data-tip="${esc(JSON.stringify({ intent: x.intent_name, query: x.query, operator: x.requested_operator }))}">⚙ ${esc(x.tool)}${x.failed ? " ✕ failed" : ""}</span>`).join("")}</div>` : "";
    const agent = t.agent_text ? `<div class="msg agent"><div class="who"><span>agent · ${esc(t.roles)}</span></div>${esc(t.agent_text)}${tools}</div>` : tools ? `<div class="msg agent">${tools}</div>` : "";
    html += `<div class="turn">${t.kind === "event" ? user.replace("</div>", "") + (t.intent ? ` · intent ${esc(t.intent.intent_id)}` : "") + "</div>" : user}${chips}${agent}</div>`;
  }
  if (lastEp) html += "</div>";
  const ev = d.evaluations.filter((e) => e.canonical_metric);
  return `<p><a href="#/sessions">← Sessions</a></p><h1>Session <span class="tag">${esc(s.external_id || s.session_id)}</span> ${srcPill(s.source)}</h1>
  <p class="sub">${esc(s.created_at)} · ${s.n_traces} traces · ${esc(s.auth_state)} · ${outcomeLabel(s.outcome)} <span class="muted small">(${esc(s.outcome_basis)})</span></p>
  <div class="layout"><div class="side grid">
    <div class="card"><h2>Intents</h2>${d.intents.map((i) => `<div style="margin-bottom:6px"><span class="pill">${esc(i.role)}</span> <span class="tag">${esc(i.intent_id)}</span><div class="small muted">${esc(i.name || "")} · conf ${i.confidence} · ${esc(i.method)}</div></div>`).join("")}</div>
    <div class="card"><h2>Context</h2><div class="kv">
      <div>Service location</div><div>${esc(s.city)}${s.state ? ", " + esc(s.state) : ""} ${s.zip3 ? `<span class="muted">(${esc(s.zip3)}xx)</span>` : ""}<div class="small muted">${esc(s.market || "")} · ${esc(s.geo_source)}</div></div>
      <div>Segment</div><div>${esc(d.features?.segment)} · ${esc(d.features?.style)}</div>
      <div>Friction</div><div>${d.features?.friction}</div>
      <div>Journey label</div><div>${esc(s.journey_label || "-")}</div>
      <div>Language</div><div>${esc(s.lang || "-")}</div>
      <div>Raw lineage</div><div class="small"><span class="tag">${esc(d.raw?.landing_file)}</span> line ${d.raw?.line_no}<div class="muted">sha256 ${esc((d.raw?.sha256 || "").slice(0, 16))}…</div></div>
    </div></div>
    <div class="card"><h2>Thread &amp; need journeys</h2>${d.thread.length > 1 ? d.thread.map((x) => `<div class="small">${x.session_id === s.session_id ? "▶" : "·"} <a href="#/session/${encodeURIComponent(x.session_id)}">#${x.thread_pos}</a> ${esc((x.created_at || "").slice(0, 16))} · ${esc(x.intent_id)} · ${esc(x.outcome)}</div>`).join("") : `<div class="muted small">Single-session thread (no previous_session_id link).</div>`}
      ${d.journeys.filter((j) => j.n_sessions > 1).map((j) => `<div class="small" style="margin-top:6px"><b>${esc(j.intent_l2)}</b>: ${j.n_sessions} sessions, last outcome ${esc(j.last_outcome)}</div>`).join("")}</div>
    <div class="card"><h2>Persistent context (as of this call)</h2>${(d.facts_as_of_session || []).map((f) => `<div class="small"><b>${esc(f.attribute)}</b> = ${esc(f.value)} <span class="muted">since ${esc((f.valid_from || "").slice(0, 10))}</span></div>`).join("") || "<div class='muted small'>No facts.</div>"}
      ${(d.fact_history || []).some((f) => f.valid_to) ? `<details><summary class="small">Superseded facts (kept on record)</summary>${d.fact_history.filter((f) => f.valid_to).map((f) => `<div class="small muted">${esc(f.attribute)} = ${esc(f.value)} · ${esc((f.valid_from || "").slice(0, 10))} → ${esc((f.valid_to || "").slice(0, 10))}</div>`).join("")}</details>` : ""}
      ${(d.clusters || []).length ? `<h3>Cluster memberships</h3>${d.clusters.map((c) => `<div class="small">${esc(c.family)}: <a href="#/clusters?family=${esc(c.family)}">${esc(c.label)}</a></div>`).join("")}` : ""}</div>
    <div class="card"><h2>Evaluations</h2><table>${ev.map((e) => `<tr><td>${esc(e.canonical_metric)}</td><td class="num">${e.value == null ? `<span class="muted">${esc(e.status)}</span>` : e.value.toFixed(2)}</td></tr>`).join("")}</table>
      ${d.policy.length ? `<h3>Policy verdicts</h3>${d.policy.map((p) => `<div class="small" data-tip="${esc(p.reason || "")}"><span class="tag">${esc(p.policy_id)}</span> ${esc(p.verdict)} · ${esc(p.severity)} · ${esc(p.policy_type)}</div>`).join("")}` : ""}
      <p class="muted small">Judge scores are the platform's own evaluators; status "not_applicable"/"error" is never treated as 0.</p></div>
  </div><div class="card"><h2>Transcript</h2><div class="turns">${html}</div></div></div>`;
}

let TAX = null, SEL = null;
async function pTaxonomy() {
  TAX = await api("taxonomy");
  const n = TAX.nodes, kids = (p) => n.filter((x) => x.parent_id === p);
  const tree = n.filter((x) => x.level === 1).map((l1) => `<div class="l1">${esc(l1.intent_id)} · ${esc(l1.name)}</div>` + kids(l1.intent_id).map((l2) =>
    `<div class="l2">${esc(l2.name)}</div>` + kids(l2.intent_id).map((l3) => `<div class="l3" data-id="${esc(l3.intent_id)}"><span><span class="dot" style="background:${famColor(l3.family)}"></span> ${esc(l3.name)}</span><span class="num">${l3.primary}</span><span class="num">${l3.secondary}</span><span class="num">${l3.real_primary}</span></div>`).join("")).join("")).join("");
  return `<h1>Intent taxonomy <span class="pill">${esc(TAX.version)}</span></h1><p class="sub">L1 domain → L2 category → L3 intent. Draft for SME review; L4 variations come from discovery in Week 2. Dot = insight family.</p>
  <div class="layout" style="grid-template-columns: 1.1fr 1fr"><div class="card tree"><div class="l3" style="cursor:default;font-weight:600;color:var(--ink-2)"><span>Intent</span><span class="num">Primary</span><span class="num">Secondary</span><span class="num">Real (36)</span></div>${tree}</div>
  <div class="grid"><div class="card" id="intentDetail"><div class="muted">Select an intent to see its definition, criteria and review actions.</div></div>
  <div class="card"><h2>Platform intent labels seen in the real sample</h2><table><tr><th>intent_name</th><th class="num">sessions</th></tr>${TAX.platform_labels_real.map((r) => `<tr><td class="tag">${esc(r.intent_name)}</td><td class="num">${r.sessions}</td></tr>`).join("")}</table></div>
  <div class="card"><h2>Discovered L4 candidates <span class="pill">draft</span></h2><p class="muted small">Sub-themes found by clustering each intent's conversations (discovery split only). Approve to add as L4 variations in the next taxonomy version.</p><div id="cands" class="small">Loading…</div></div>
  <div class="card"><h2>Review log</h2>${TAX.reviews.map((r) => `<div class="small">${esc(r.at)} · <b>${esc(r.reviewer)}</b> ${esc(r.action)} <span class="tag">${esc(r.object_id)}</span> ${esc(r.note)}</div>`).join("") || `<div class="muted small">No reviews yet.</div>`}</div></div></div>`;
}
function wireTaxonomy() {
  api("taxonomy/candidates").then((d) => { const el = $("#cands"); if (!el) return; el.innerHTML = d.candidates.slice(0, 40).map((c) => `<div style="margin-bottom:6px"><span class="tag">${esc(c.candidate_id)}</span> <b>${esc(c.label)}</b> · ${fmt(c.size)} episodes<div class="muted">e.g. “${esc((c.examples[0] || "").slice(0, 110))}”</div></div>`).join("") || "None yet."; });
  document.querySelectorAll(".l3[data-id]").forEach((el) => el.addEventListener("click", () => {
    document.querySelectorAll(".l3.sel").forEach((x) => x.classList.remove("sel")); el.classList.add("sel");
    const x = TAX.nodes.find((n) => n.intent_id === el.dataset.id); SEL = x;
    $("#intentDetail").innerHTML = `<h2>${esc(x.name)}</h2><p><span class="tag">${esc(x.intent_id)}</span> · family <b>${esc(x.family)}</b></p><p>${esc(x.definition)}</p>
      <h3>Include</h3><ul>${x.include_criteria.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>
      <h3>Exclude</h3><ul>${x.exclude_criteria.map((i) => `<li>${esc(i)}</li>`).join("") || "<li class='muted'>none</li>"}</ul>
      <h3>Platform labels mapped</h3><div class="chips">${x.platform_intent_patterns.map((p) => `<span class="tag">${esc(p)}</span>`).join("") || "<span class='muted small'>none (keyword rules only)</span>"}</div>
      <h3>Examples</h3><ul>${x.examples.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>
      <p><a href="#/sessions?intent=${encodeURIComponent(x.intent_id)}">View ${x.primary + x.secondary} sessions →</a></p>
      <h3>SME review</h3><div class="toolbar"><input id="rv" placeholder="Reviewer" size="12"><input id="rn" placeholder="Note" style="flex:1"></div>
      <div class="toolbar"><button data-a="approve">Approve</button><button data-a="rename">Request rename</button><button data-a="merge">Propose merge</button><button data-a="split">Propose split</button><button data-a="comment">Comment</button></div><div id="rmsg" class="small muted"></div>`;
    $("#intentDetail").querySelectorAll("button[data-a]").forEach((b) => b.addEventListener("click", async () => {
      const r = await fetch("/api/review", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ object_type: "intent", object_id: x.intent_id, action: b.dataset.a, reviewer: $("#rv").value, note: $("#rn").value }) });
      const j = await r.json(); $("#rmsg").textContent = r.ok ? `Recorded: ${b.dataset.a}` : j.error;
    }));
  }));
}

async function pSignals() {
  const d = await api("signals");
  const fams = [...new Set(d.signals.map((s) => s.family))];
  return `<h1>Signal catalogue <span class="pill">rules ${esc(d.rules_version)}</span></h1><p class="sub">Every signal type the extractor can emit, how it is produced, and live counts. Real = the 36 Verizon sessions.</p>
  ${fams.map((f) => { const rows = d.signals.filter((s) => s.family === f); return `<div class="card" style="margin-bottom:14px"><h2><span class="dot" style="background:${famColor(f)}"></span> ${esc(rows[0].category)}</h2>
    <table><tr><th>Type</th><th>Method</th><th>Description</th><th class="num">Sessions</th><th class="num">Real</th><th>Example evidence</th></tr>
    ${rows.map((s) => `<tr><td><a href="#/sessions?signal=${encodeURIComponent(s.type)}" class="tag">${esc(s.type)}</a></td><td>${esc(s.method)}</td><td class="small">${esc(s.description)}</td><td class="num">${s.sessions}</td><td class="num">${s.real_n}</td>
      <td class="small">${s.examples.slice(0, 2).map((e) => `<div><a href="#/session/${encodeURIComponent(e.session_id)}">${e.source === "verizon_sample" ? "real" : "fixture"}</a>: “${esc((e.text || "").slice(0, 90))}”</div>`).join("")}</td></tr>`).join("")}</table></div>`; }).join("")}`;
}

async function pPipeline() {
  const d = await api("runs"); const L = await api("llm");
  return `<h1>Pipeline &amp; governance</h1><p class="sub">Every stage records its versions and stats. Raw payloads are landed immutably and referenced by line + sha256.</p>
  <div class="grid g2"><div class="card"><h2>Provenance</h2><table><tr><th>Source</th><th>Synthetic</th><th>Batch</th><th class="num">Sessions</th></tr>${d.provenance.map((p) => `<tr><td>${esc(p.source)}</td><td>${p.is_synthetic ? "yes" : "no"}</td><td>${esc(p.batch || "-")}</td><td class="num">${p.n}</td></tr>`).join("")}</table></div>
  <div class="card"><h2>Ingest rejects</h2>${d.rejects.length ? `<table>${d.rejects.map((r) => `<tr><td>${esc(r.file)}:${r.line_no}</td><td>${esc(r.reason)}</td></tr>`).join("")}</table>` : `<div class="muted">None.</div>`}</div></div>
  <div class="card" style="margin-top:16px"><h2>Claude tier (low-confidence adjudication)</h2><p>${L.enabled ? "<span class='pass'>enabled</span>" : "<span class='na'>disabled</span> (no API key configured)"} · models ${esc(JSON.stringify(L.models))} · cap ${pct(L.max_share)} of sessions · ${fmt(L.candidates)} candidate sessions · cache ${fmt(L.cache_rows)}</p>
    <p class="small muted">${esc(L.note)}</p>${L.labels.map((l) => `<span class="pill">${esc(l.status)} ${l.n}</span>`).join(" ")}</div>
  <div class="card" style="margin-top:16px;overflow:auto"><h2>Processing runs</h2><table><tr><th>#</th><th>Stage</th><th>Status</th><th>Started</th><th>Stats</th><th>Versions</th></tr>
  ${d.runs.map((r) => `<tr><td>${r.run_id}</td><td>${esc(r.stage)}</td><td>${esc(r.status)}</td><td class="small">${esc(r.started_at)}</td><td class="small tag">${esc(r.stats)}</td><td class="small muted">${esc(r.versions)}</td></tr>`).join("")}</table></div>`;
}

/* ---------- router ---------- */
async function route() {
  const h = location.hash.slice(2) || "overview";
  const [path, qs] = h.split("?");
  const parts = path.split("/");
  const params = Object.fromEntries(new URLSearchParams(qs || ""));
  document.querySelectorAll("#nav a").forEach((a) => a.classList.toggle("active", a.dataset.r === (parts[0] === "session" ? "sessions" : parts[0])));
  const app = $("#app");
  try {
    if (parts[0] === "overview") app.innerHTML = await pOverview();
    else if (parts[0] === "sessions") { app.innerHTML = await pSessions(params); wireSessions(); }
    else if (parts[0] === "session") app.innerHTML = await pSession(decodeURIComponent(parts.slice(1).join("/")));
    else if (parts[0] === "taxonomy") { app.innerHTML = await pTaxonomy(); wireTaxonomy(); }
    else if (parts[0] === "signals") app.innerHTML = await pSignals();
    else if (parts[0] === "pipeline") app.innerHTML = await pPipeline();
    else if (parts[0] === "insights") { app.innerHTML = await pInsights(params); wireInsights(); }
    else if (parts[0] === "geo") { app.innerHTML = await pGeo(params); wireGeo(); }
    else if (parts[0] === "journeys") app.innerHTML = await pJourneys();
    else if (parts[0] === "clusters") { app.innerHTML = await pClusters(params); wireClusters(); }
    else if (parts[0] === "ask") { app.innerHTML = await pAsk(params); wireAsk(); }
    else if (parts[0] === "validation") app.innerHTML = await pValidation();
    else app.innerHTML = `<div class="empty">Not found.</div>`;
  } catch (e) { app.innerHTML = `<div class="card empty">Could not load: ${esc(e.message)}</div>`; }
  window.scrollTo(0, 0);
}
$("#src").value = SRC;
$("#src").addEventListener("change", (e) => { SRC = e.target.value; store.set("cie.src", SRC); route(); });
$("#theme").addEventListener("click", () => {
  const cur = document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const next = cur === "dark" ? "light" : "dark"; document.documentElement.dataset.theme = next; store.set("cie.theme", next);
});
const savedTheme = store.get("cie.theme", ""); if (savedTheme) document.documentElement.dataset.theme = savedTheme;
addEventListener("hashchange", route); route();
