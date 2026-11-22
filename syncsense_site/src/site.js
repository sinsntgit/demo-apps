/* SyncSense site script: menus, form helpers, the AskData sample demo. Content works without it. */
(function () {
  "use strict";

  // Menus: one dropdown open at a time; close on outside click or Escape.
  var menus = Array.prototype.slice.call(document.querySelectorAll(".main-nav details"));
  menus.forEach(function (d) {
    d.addEventListener("toggle", function () {
      if (d.open) menus.forEach(function (o) { if (o !== d) o.open = false; });
    });
  });
  document.addEventListener("click", function (e) {
    menus.forEach(function (d) { if (d.open && !d.contains(e.target)) d.open = false; });
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") menus.forEach(function (d) { if (d.open) { d.open = false; d.querySelector("summary").focus(); } });
  });

  // Forms: tick the interest passed in the URL (?interest=demo) and show an error notice (?status=error).
  var params = new URLSearchParams(location.search);
  var interest = params.get("interest");
  if (interest) {
    var box = document.querySelector('input[name="interest[]"][value="' + interest.replace(/[^a-z]/g, "") + '"]');
    if (box) box.checked = true;
  }
  if (params.get("status") === "error") {
    document.querySelectorAll('[data-status="error"]').forEach(function (n) { n.hidden = false; });
  }

  // Image viewer: click a screenshot to see it full screen; "Restore" (or Esc) returns.
  var lb = null, lbImg, lbCap, lastTrigger = null;
  function buildViewer() {
    lb = document.createElement("div");
    lb.className = "lb"; lb.hidden = true;
    lb.setAttribute("role", "dialog"); lb.setAttribute("aria-modal", "true"); lb.setAttribute("aria-label", "Enlarged image");
    lb.innerHTML = '<div class="lb-bar"><span class="lb-cap"></span><button type="button" class="lb-restore">⤡ Restore</button></div><div class="lb-stage"><img alt=""><div class="lb-video" hidden></div></div>';
    document.body.appendChild(lb);
    lbImg = lb.querySelector("img"); lbCap = lb.querySelector(".lb-cap");
    lb.querySelector(".lb-restore").addEventListener("click", closeViewer);
    lb.querySelector(".lb-stage").addEventListener("click", function (e) { if (e.target === e.currentTarget) closeViewer(); });
  }
  function openViewer(src, alt, trigger) {
    if (!lb) buildViewer();
    lastTrigger = trigger || null;
    lbImg.hidden = false; lb.querySelector(".lb-video").hidden = true;
    lbImg.src = src; lbImg.alt = alt || ""; lbCap.textContent = alt || "";
    lb.hidden = false; document.body.classList.add("lb-open");
    lb.querySelector(".lb-restore").focus();
  }
  function closeViewer() {
    if (!lb || lb.hidden) return;
    lb.hidden = true; document.body.classList.remove("lb-open"); lbImg.removeAttribute("src");
    var v = lb.querySelector(".lb-video"); v.textContent = ""; v.hidden = true;
    if (lastTrigger) lastTrigger.focus();
  }
  document.addEventListener("keydown", function (e) {
    if (lb && !lb.hidden) {
      if (e.key === "Escape") { e.preventDefault(); closeViewer(); }
      if (e.key === "Tab") { e.preventDefault(); lb.querySelector(".lb-restore").focus(); }
    }
  });
  // Demo videos: YouTube (privacy-enhanced) loads only when the button is pressed.
  function openVideo(id, title, trigger) {
    if (!lb) buildViewer();
    lastTrigger = trigger || null;
    lbImg.hidden = true; lbImg.removeAttribute("src"); lbCap.textContent = title || "Demo video";
    var box = lb.querySelector(".lb-video"); box.hidden = false; box.textContent = "";
    var f = document.createElement("iframe");
    f.src = "https://www.youtube-nocookie.com/embed/" + encodeURIComponent(id) + "?autoplay=1&rel=0&modestbranding=1";
    f.title = title || "Demo video";
    f.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen";
    f.allowFullscreen = true;
    box.appendChild(f);
    lb.hidden = false; document.body.classList.add("lb-open");
    lb.querySelector(".lb-restore").focus();
  }
  document.querySelectorAll("[data-video]").forEach(function (b) {
    b.addEventListener("click", function (e) { e.preventDefault(); openVideo(b.getAttribute("data-video"), b.getAttribute("data-title"), b); });
  });

  // Home cards: buttons carry the full-size image in data-zoom.
  document.querySelectorAll("button[data-zoom]").forEach(function (b) {
    b.addEventListener("click", function () { var i = b.querySelector("img"); openViewer(b.getAttribute("data-zoom"), i ? i.alt : "", b); });
  });
  // Screenshots on other pages: make them keyboard-focusable and enlargeable.
  document.querySelectorAll(".screen img, figure.dash img").forEach(function (img) {
    img.setAttribute("data-zoomable", ""); img.tabIndex = 0; img.setAttribute("role", "button");
    img.setAttribute("aria-label", "Enlarge image: " + (img.alt || "screenshot"));
    var open = function () { openViewer(img.currentSrc || img.src, img.alt, img); };
    img.addEventListener("click", open);
    img.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
  });

  // AskData sample demo (made-up data, runs in the browser only).
  var root = document.querySelector("[data-t2s]");
  if (!root) return;
  var SAMPLES = [
    {
      q: "Claims ratio by product for the last 4 quarters",
      sql: "SELECT p.product_name,\n       ROUND(SUM(c.paid_amount) / SUM(pr.earned_premium) * 100, 1) AS claims_ratio_pct\nFROM claims c\nJOIN policies po ON po.policy_id = c.policy_id\nJOIN products p ON p.product_id = po.product_id\nJOIN premiums pr ON pr.policy_id = po.policy_id\nWHERE c.loss_date >= DATE '2025-10-01'\nGROUP BY p.product_name\nORDER BY claims_ratio_pct DESC;",
      cols: ["Product", "Claims ratio %"],
      rows: [["Motor", 71.4], ["Health", 68.9], ["Travel", 42.3], ["Home", 31.8]],
      sum: "Motor has the highest claims ratio over the last four quarters (71.4%), followed by Health. Home is lowest at 31.8%."
    },
    {
      q: "Top borrowers with EMIs overdue more than 60 days",
      sql: "SELECT b.borrower_name, br.branch_name,\n       SUM(e.emi_amount) AS overdue_amount,\n       MAX(CURRENT_DATE - e.due_date) AS days_overdue\nFROM emis e\nJOIN loans l ON l.loan_id = e.loan_id\nJOIN borrowers b ON b.borrower_id = l.borrower_id\nJOIN branches br ON br.branch_id = l.branch_id\nWHERE e.paid_date IS NULL\n  AND CURRENT_DATE - e.due_date > 60\nGROUP BY b.borrower_name, br.branch_name\nORDER BY overdue_amount DESC\nLIMIT 20;",
      cols: ["Borrower", "Branch", "Overdue (₹)", "Days overdue"],
      rows: [["Borrower A", "Pune East", "18,40,000", 94], ["Borrower B", "Nashik", "12,75,500", 71], ["Borrower C", "Thane", "9,10,000", 66]],
      sum: "3 borrowers in the sample have EMIs overdue more than 60 days, ₹40.3 lakh in total. Pune East has the largest exposure."
    },
    {
      q: "Subscribers billed twice in October",
      sql: "SELECT s.subscriber_id, s.plan_name,\n       COUNT(*) AS invoices_in_month\nFROM invoices i\nJOIN subscribers s ON s.subscriber_id = i.subscriber_id\nWHERE i.bill_period = '2026-10'\n  AND i.invoice_type = 'RECURRING'\nGROUP BY s.subscriber_id, s.plan_name\nHAVING COUNT(*) > 1\nORDER BY invoices_in_month DESC;",
      cols: ["Subscriber", "Plan", "Recurring invoices"],
      rows: [["SUB-104233", "Postpaid 599", 2], ["SUB-118902", "Postpaid 999", 2], ["SUB-120417", "Family 1499", 2]],
      sum: "3 subscribers in the sample received two recurring invoices for the October bill period."
    },
    {
      q: "Stores where sell-through dropped more than 15% this month",
      sql: "WITH st AS (\n  SELECT store_id, month,\n         SUM(units_sold) * 1.0 / NULLIF(SUM(units_received), 0) AS sell_through\n  FROM store_inventory\n  WHERE month IN ('2026-10', '2026-11')\n  GROUP BY store_id, month\n)\nSELECT s.store_name,\n       ROUND((cur.sell_through - prev.sell_through) / prev.sell_through * 100, 1) AS change_pct\nFROM st cur\nJOIN st prev ON prev.store_id = cur.store_id AND prev.month = '2026-10'\nJOIN stores s ON s.store_id = cur.store_id\nWHERE cur.month = '2026-11'\n  AND (cur.sell_through - prev.sell_through) / prev.sell_through < -0.15\nORDER BY change_pct;",
      cols: ["Store", "Change in sell-through %"],
      rows: [["Andheri West", -22.6], ["Indiranagar", -18.1], ["Salt Lake", -15.9]],
      sum: "3 stores in the sample saw sell-through fall more than 15% this month. Andheri West fell the most (-22.6%)."
    }
  ];
  var qs = root.querySelector(".t2s-qs");
  var code = root.querySelector(".t2s-sql code");
  var table = root.querySelector(".t2s-table");
  var sum = root.querySelector(".t2s-sum");

  function el(tag, text, cls) { var n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; }
  function show(i) {
    var s = SAMPLES[i];
    qs.querySelectorAll("button").forEach(function (b, j) { b.setAttribute("aria-pressed", String(i === j)); });
    code.textContent = s.sql;
    table.textContent = "";
    var t = el("table"), thead = el("thead"), tr = el("tr");
    s.cols.forEach(function (c) { var th = el("th", c); th.scope = "col"; tr.appendChild(th); });
    thead.appendChild(tr); t.appendChild(thead);
    var tb = el("tbody");
    s.rows.forEach(function (r) {
      var row = el("tr");
      r.forEach(function (v) { row.appendChild(el("td", String(v), typeof v === "number" || /^[\d,.-]+$/.test(String(v)) ? "n" : "")); });
      tb.appendChild(row);
    });
    t.appendChild(tb); table.appendChild(t);
    sum.textContent = s.sum;
  }
  SAMPLES.forEach(function (s, i) {
    var b = el("button", s.q); b.type = "button"; b.setAttribute("aria-pressed", "false");
    b.addEventListener("click", function () { show(i); });
    qs.appendChild(b);
  });
  show(0);
})();
