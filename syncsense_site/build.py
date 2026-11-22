#!/usr/bin/env python3
"""Build the SyncSense website into ./public.

Content lives in content/:
  content/pages/**.html   one file per page: a JSON header between '---' lines, then HTML
  content/insights/*.html articles (same format)
  content/data.py         industries (use case pages) and case studies, rendered by templates

Tokens usable inside page HTML:
  {{faq}} {{form:demo|assessment|contact}} {{cta}} {{product_cards}} {{industry_tiles}}
  {{product_industry_grid}} {{case_cards}} {{case_cards:<industry-slug>}} {{insight_cards}}
  {{flow}} {{demo_widget}} {{engage_steps}} {{booking_link}}
Placeholders written as [PROOF: ...], [PLACEHOLDER: ...] or [CONFIRM: ...] are highlighted on
the page and listed in docs/placeholders.md.

Usage:  python3 build.py
"""
import hashlib
import html
import json
import re
import shutil
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CONTENT = ROOT / "content"
SRC = ROOT / "src"
OUT = ROOT / "public"
DOCS = ROOT / "docs"
sys.path.insert(0, str(CONTENT))
import data  # noqa: E402  (content/data.py)

# ---------------------------------------------------------------- site facts
SITE = "https://www.syncsense.in"
NAME = "SyncSense"
EMAIL = "sales@syncsense.in"
PHONE = "+91 9136433008"
PHONE_LINK = "+919136433008"
CITY = "Mumbai, India"
LINKEDIN = "https://www.linkedin.com/company/data-syncsense/"
FOUNDER = "Santosh Tiwari"
TAGLINE = "From data to decisions"
BOOKING_URL = ""  # Calendly link. Empty: "Book a demo" opens the contact form with Demo selected.
DEMO_HREF = BOOKING_URL or "/contact/?interest=demo#form"
SHARE_IMAGE = "/assets/img/share.png"
LOGO = "/assets/img/logo.webp"
AREAS = ["India", "Middle East", "Africa", "United Kingdom"]
INDUSTRY_OPTIONS = [i["name"] for i in data.INDUSTRIES] + ["Other"]
INTERESTS = [
    ("demo", "AskData demo (Text-to-SQL)"),
    ("ontology", "Ontology Studio"),
    ("crm", "Ovantaa CRM"),
    ("assessment", "Free data assessment"),
    ("consulting", "Data & AI consulting"),
    ("staffing", "Contract staffing"),
]

NAV = [
    ("products", "Products", "/products/", [
        ("All products", "/products/"),
        ("AskData: Text-to-SQL", "/products/text-to-sql/"),
        ("Ontology Studio", "/products/ontology-builder/"),
        ("Ovantaa CRM", "/products/crm/"),
    ]),
    ("use-cases", "Use Cases", "/use-cases/", [("All use cases", "/use-cases/"),
     ("Products", None), ("AskData", "/use-cases/askdata/"), ("Ontology Studio", "/use-cases/ontology-studio/"),
     ("Ovantaa CRM", "/use-cases/ovantaa-crm/"),
     ("Services", None), ("Consulting & staffing", "/use-cases/consulting/"),
     ("By industry", None), ("All industries", "/use-cases/#by-industry")]),
    ("services", "Services", "/services/data-ai-consulting/", [
        ("Data & AI consulting", "/services/data-ai-consulting/"),
        ("Contract staffing", "/services/data-analytics-staffing/"),
        ("Free data assessment", "/free-data-assessment/"),
    ]),
    ("case-studies", "Case Studies", "/case-studies/", [("All case studies", "/case-studies/"),
     ("Products", None), ("Text-to-SQL", "/case-studies/#askdata"), ("Ontologies & knowledge graphs", "/case-studies/#ontology-studio"),
     ("Services", None), ("Data & AI consulting", "/case-studies/#consulting"), ("Contract staffing", "/case-studies/#staffing")]),
    ("insights", "Insights", "/insights/", None),
    ("about", "About", "/about/", None),
]

# Old Website Builder URLs -> new URLs (also written to .htaccess and docs/redirects.md)
REDIRECTS = [
    ("/about", "/about/"),
    ("/reporting-services", "/services/data-ai-consulting/"),
    ("/staffing-solutions", "/services/data-analytics-staffing/"),
    ("/get-in-touch", "/contact/"),
    ("/testimonials", "/case-studies/"),
    ("/blog-list", "/insights/"),
    ("/ai-and-llm-use-cases", "/use-cases/tax-professional-services/"),
    ("/manufacturing-from-factory-floor-to-pandl", "/use-cases/manufacturing/"),
    ("/financial-analytics", "/use-cases/manufacturing/"),
]

PH_RE = re.compile(r"\[(PROOF|PLACEHOLDER|CONFIRM): ([^\]]+)\]")
PLACEHOLDERS = []  # (page path, kind, text)
PAGES = []  # rendered page records for sitemap and docs


def esc(s):
    return html.escape(str(s), quote=True)


def strip_ph(s):
    """Plain text for meta tags and JSON-LD: drop placeholder markers."""
    return PH_RE.sub(lambda m: m.group(2) if m.group(1) == "PLACEHOLDER" else "", s).strip()


# ---------------------------------------------------------------- components
def booking_link(label="Book a demo", cls="btn"):
    ext = ' target="_blank" rel="noopener"' if BOOKING_URL else ""
    return f'<a class="{cls}" href="{DEMO_HREF}"{ext}>{label}</a>'


def cta_band(title="See AskData on your own questions",
             text="A 30-minute demo, then a four-week pilot on one of your own data sources if it fits."):
    return f"""<section class="cta-band"><div class="wrap">
  <h2>{title}</h2><p>{text}</p>
  <div class="actions center">{booking_link()}<a class="btn ghost-light" href="/free-data-assessment/">Get a free data assessment</a></div>
</div></section>"""


def form(kind="contact"):
    preset = {"demo": "demo", "assessment": "assessment"}.get(kind, "")
    heading = {
        "demo": "Book a demo",
        "assessment": "Request your free data assessment",
        "contact": "Send us a message",
    }[kind]
    industries = "".join(f'<option value="{esc(o)}">{esc(o)}</option>' for o in INDUSTRY_OPTIONS)
    boxes = "".join(
        f'<label class="check"><input type="checkbox" name="interest[]" value="{v}"{" checked" if v == preset else ""}> {esc(l)}</label>'
        for v, l in INTERESTS
    )
    msg_label = "What would you like to look at? (optional)" if kind != "contact" else "Message (optional)"
    return f"""<div class="form-wrap" id="form">
  <h2>{heading}</h2>
  <div class="notice err" data-status="error" hidden role="alert">That didn't go through. Please check the highlighted fields, or email <a href="mailto:{EMAIL}">{EMAIL}</a>.</div>
  <form class="form" action="/contact.php" method="post">
    <input type="hidden" name="source" value="{kind}">
    <div class="hp" aria-hidden="true"><label>Leave this empty <input type="text" name="website" tabindex="-1" autocomplete="off"></label></div>
    <div class="row-2">
      <label>Name* <input type="text" name="name" autocomplete="name" required maxlength="120"></label>
      <label>Work email* <input type="email" name="email" autocomplete="email" required maxlength="200"></label>
    </div>
    <div class="row-2">
      <label>Company* <input type="text" name="company" autocomplete="organization" required maxlength="160"></label>
      <label>Role <input type="text" name="role" autocomplete="organization-title" maxlength="120" placeholder="e.g. Head of Finance"></label>
    </div>
    <label>Industry*
      <select name="industry" required><option value="">Choose your industry</option>{industries}</select>
    </label>
    <fieldset><legend>Interested in</legend><div class="checks">{boxes}</div></fieldset>
    <label>{msg_label} <textarea name="message" maxlength="5000" rows="5"></textarea></label>
    <p class="note">We use these details only to reply to you. See our <a href="/privacy-policy/">privacy policy</a>.</p>
    <div><button class="btn" type="submit">{'Request the assessment' if kind == 'assessment' else 'Send'}</button></div>
  </form>
</div>"""


def faq_html(faq):
    if not faq:
        return ""
    items = "".join(f"<details class=\"faq\"><summary><h3>{esc(q)}</h3></summary><div>{a}</div></details>" for q, a in faq)
    return f'<section class="section" id="faq"><div class="wrap narrow"><h2>Frequently asked questions</h2>{items}</div></section>'


PRODUCTS = [
    {"name": "AskData", "short": "Ask questions of your own data in plain English and get answers in seconds.", "tag": "Text-to-SQL", "href": "/products/text-to-sql/",
     "img": "askdata-card", "alt": "AskData answer explaining how net sales by customer country were calculated, with a bar chart of the result",
     "text": "Plain-English questions answered from your own databases, with a table, chart and summary.",
     "points": ["Read-only; results never go to the AI", "Learns your terms; answers can be corrected", "Forecasts and scheduled PDF/PowerPoint reports"]},
    {"name": "Ontology Studio", "short": "One shared model of what your business data means, for reports and AI.", "tag": "Ontology & knowledge graph", "href": "/products/ontology-builder/",
     "img": "ontology-card", "alt": "Ontology Studio showing the class hierarchy diagram of a retail order management ontology",
     "text": "One shared model of what your business terms mean, used for reports and cited AI answers.",
     "points": ["22 ready-made ontologies, 19 industries", "Diagram, test bed, knowledge graph, versions", "Built on FIBO, HL7 FHIR, Schema.org and more"]},
    {"name": "Ovantaa CRM", "short": "Leads, deals, GST invoices and collections on one customer record.", "tag": "Lead to cash", "href": "/products/crm/",
     "img": "crm-card", "alt": "Ovantaa CRM dashboard with open pipeline, closed won, contacts and won revenue for the last six months in rupees",
     "text": "Leads, deals, campaigns, GST invoices and collections on one record, in your own environment.",
     "points": ["Deal board with stage history", "GST invoicing, reminders, receivables", "AI search that never sees your records"]},
]


def shot(name, alt, w=1600, h=900, eager=False, cls="shot"):
    load = ' fetchpriority="high"' if eager else ' loading="lazy" decoding="async"'
    return f'<img class="{cls}" src="/assets/img/{name}.webp" alt="{esc(alt)}" width="{w}" height="{h}"{load}>'


IMG_SIZES = {"askdata-card": (960, 541), "ontology-card": (960, 541), "crm-card": (960, 541)}
FULL_IMG = {"askdata-card": "askdata-chat", "ontology-card": "ontology-diagram", "crm-card": "crm-dashboard"}


def product_cards():
    cards = ""
    for p in PRODUCTS:
        w, h = IMG_SIZES[p["img"]]
        pts = "".join(f"<li>{esc(x)}</li>" for x in p["points"])
        cards += (f'<a class="pcard" href="{p["href"]}"><div class="pshot">{shot(p["img"], p["alt"], w, h, cls="")}</div>'
                  f'<span class="tag">{p["tag"]}</span><h3>{p["name"]}</h3><p>{p["short"]}</p>'
                  f'<span class="more">Learn more →</span></a>')
    return f'<div class="grid-3">{cards}</div>'


FOLD_CASES = [
    ("consumer-goods-campaign-text-to-sql", "90%", "faster campaign insight", "Consumer goods · Text-to-SQL"),
    ("actuarial-text-to-sql-reports", "<30 min", "per actuarial report, from 4+ hours", "Actuarial · Text-to-SQL"),
    ("gst-dispute-legal-ai", "75%", "faster GST dispute filing", "Tax & legal · AI"),
    ("genai-email-support-assistant", "50%", "lower product support cost", "Software · GenAI"),
    ("insurer-managed-bi-team", "8 people", "run an insurer’s whole BI unit", "Insurance · Managed BI"),
    ("tax-research-knowledge-graph-slm", "5,000", "case laws in a cited tax knowledge graph", "Tax · Ontology"),
]


def fold():
    cards = ""
    for i, p in enumerate(PRODUCTS):
        w, h = IMG_SIZES[p["img"]]
        full = FULL_IMG[p["img"]]
        cards += (f'<div class="fcard"><button type="button" class="fshot" data-zoom="/assets/img/{full}.webp" aria-label="Enlarge {esc(p["name"])} screenshot">'
                  f'<span class="frame">{shot(p["img"], p["alt"], w, h, eager=(i == 0), cls="")}</span><span class="zoom-hint" aria-hidden="true">⤢</span></button>'
                  f'<a class="fbody" href="{p["href"]}"><p class="tag">{p["tag"]}</p><h2>{p["name"]}</h2><p class="fdesc">{p["short"]}</p>'
                  f'<span class="more">Learn more →</span></a></div>')
    cases = "".join(
        f'<a class="fcase" href="/case-studies/{slug}/"><strong>{esc(stat)}</strong><span>{esc(label)}</span></a>'
        for slug, stat, label, sector in FOLD_CASES
    )
    return f"""<section class="fold" aria-label="Products and case studies">
  <div class="wrap">
    <h1 class="sr">SyncSense: AI data products, data and AI consulting, and contract staffing</h1>
    <p class="fold-label">Our products <a href="/products/">Compare products →</a></p>
    <div class="fold-products">{cards}</div>
    <p class="fold-label">Case studies <a href="/case-studies/">All 9 →</a></p>
    <div class="fcases">{cases}</div>
  </div>
</section>"""


def product_usecase_cards():
    out = ""
    for key, u in data.PRODUCT_USE_CASES.items():
        inds = ", ".join(dict.fromkeys(c["industry"] for c in u["cases"]))
        out += (f'<a class="pcard" href="/use-cases/{u["slug"]}/"><span class="tag">{len(u["cases"])} use cases</span>'
                f'<h3>{u["product"]} use cases</h3><p>{esc(inds)}.</p><span class="more">See {u["product"]} use cases →</span></a>')
    return f'<div class="grid-3">{out}</div>'


def usecase_teaser(key):
    u = data.PRODUCT_USE_CASES[key]
    inds = list(dict.fromkeys(c["industry"] for c in u["cases"]))
    chips = "".join(f"<li>{esc(x)}</li>" for x in inds)
    return (f'<section class="section alt"><div class="wrap center-text"><h2>{u["product"]} use cases</h2>'
            f'<p class="lead-in">{len(u["cases"])} examples across these industries:</p>'
            f'<ul class="chips chips-center">{chips}</ul><p class="actions center"><a class="btn ghost" href="/use-cases/{u["slug"]}/">See {u["product"]} use cases →</a></p></div></section>')


def industry_tiles():
    tiles = "".join(
        f'<a class="tile" href="/use-cases/{i["slug"]}/"><h3>{i["name"]}</h3><p class="q">“{esc(i["questions"][0])}”</p><span class="more">See the use case →</span></a>'
        for i in data.INDUSTRIES
    )
    return f'<div class="tiles">{tiles}</div>'


def product_industry_grid():
    head = "<tr><th scope=\"col\">Industry</th><th scope=\"col\">AskData (Text-to-SQL)</th><th scope=\"col\">Ontology Studio</th><th scope=\"col\">CRM &amp; consulting</th></tr>"
    rows = "".join(
        f'<tr><th scope="row"><a href="/use-cases/{i["slug"]}/">{i["name"]}</a></th><td>“{esc(i["grid"][0])}”</td><td>{esc(i["grid"][1])}</td><td>{esc(i["grid"][2])}</td></tr>'
        for i in data.INDUSTRIES
    )
    return f'<div class="table-scroll" role="region" aria-label="Product and industry grid" tabindex="0"><table class="grid-table">{head}{rows}</table></div>'


def case_cards(industry=None):
    featured = ["consumer-goods-campaign-text-to-sql", "tax-research-knowledge-graph-slm", "insurer-managed-bi-team"]
    if industry == "featured":
        items = [c for f in featured for c in data.CASE_STUDIES if c["slug"] == f]
    else:
        items = [c for c in data.CASE_STUDIES if industry is None or industry in c["industries"]]
    if not items:
        return ""
    cards = "".join(
        f'<a class="ccard" href="/case-studies/{c["slug"]}/"><span class="tag">Case study · {esc(c["sector"])}</span><h3>{esc(c["title"])}</h3>'
        f'<p>{esc(c["summary"])}</p>{"<p class=stat>" + esc(c["headline_stat"]) + "</p>" if c.get("headline_stat") else ""}<span class="more">Read the case study →</span></a>'
        for c in items
    )
    return f'<div class="grid-3">{cards}</div>'


def insight_cards():
    cards = "".join(
        f'<a class="ccard" href="{a["path"]}"><span class="tag">Article · {a["date_label"]}</span><h3>{esc(a["h1"])}</h3><p>{esc(a["description"])}</p><span class="more">Read →</span></a>'
        for a in ARTICLES
    )
    return f'<div class="grid-3">{cards}</div>'


def flow():
    return """<figure class="flow" aria-label="How SyncSense products fit together">
  <div class="flow-col"><p class="flow-label">Your systems</p>
    <ul><li>ERP and finance</li><li>Core banking, policy or billing systems</li><li>CRM and sales data</li><li>Documents, Excel and CSV</li></ul></div>
  <div class="flow-arrow" aria-hidden="true">→</div>
  <div class="flow-col hl"><p class="flow-label">Ontology Studio</p>
    <ul><li>One meaning for “customer”, “policy”, “order”</li><li>How they relate</li><li>Lineage and metadata</li></ul></div>
  <div class="flow-arrow" aria-hidden="true">→</div>
  <div class="flow-col"><p class="flow-label">Ways to use it</p>
    <ul><li><strong>AskData</strong>: questions in plain English</li><li><strong>Ovantaa CRM</strong>: customer work</li><li>Dashboards and reports</li><li>AI assistants with cited answers</li></ul></div>
  <div class="flow-arrow" aria-hidden="true">→</div>
  <div class="flow-col"><p class="flow-label">Business users</p>
    <ul><li>Finance</li><li>Sales and service</li><li>Operations</li><li>Leadership</li></ul></div>
  <figcaption>Consulting designs and implements this; contract staff help run and extend it.</figcaption>
</figure>"""


def engage_steps():
    steps = [
        ("1", "Demo", "30 minutes. We show AskData on sample data and talk through your top questions.", DEMO_HREF, "Book a demo"),
        ("2", "Free data assessment", "Fixed scope. We review one data area and finish with a working prototype on your data.", "/free-data-assessment/", "About the assessment"),
        ("3", "Implement and scale", "A four-week pilot, then roll-out by consulting, with contract staff to run and extend it.", "/services/data-ai-consulting/", "Consulting"),
    ]
    items = "".join(f'<li><span class="num">{n}</span><h3>{t}</h3><p>{d}</p><a href="{h}">{l} →</a></li>' for n, t, d, h, l in steps)
    return f'<ol class="steps">{items}</ol>'


def demo_widget():
    return """<div class="t2s" data-t2s>
  <div class="t2s-head"><span class="dot"></span><span class="dot"></span><span class="dot"></span><span class="t2s-title">AskData · sample data</span></div>
  <div class="t2s-body">
    <p class="t2s-label" id="t2s-pick">Pick a question</p>
    <div class="t2s-qs" role="group" aria-labelledby="t2s-pick"></div>
    <div class="t2s-out" aria-live="polite">
      <p class="t2s-label">Generated SQL (read-only)</p><pre class="t2s-sql"><code></code></pre>
      <p class="t2s-label">Result</p><div class="t2s-table"></div>
      <p class="t2s-sum"></p>
    </div>
  </div>
  <p class="t2s-note">Illustration on made-up sample data. In AskData the SQL runs on your database, inside your network.</p>
  <noscript><p class="t2s-note">Turn on JavaScript to try the sample questions.</p></noscript>
</div>"""


def breadcrumb_html(crumbs):
    if not crumbs:
        return ""
    parts = ['<a href="/">Home</a>'] + [
        f'<a href="{h}">{esc(n)}</a>' if h else f'<span aria-current="page">{esc(n)}</span>' for n, h in crumbs
    ]
    return f'<nav class="crumbs wrap" aria-label="Breadcrumb">{" <span aria-hidden=true>/</span> ".join(parts)}</nav>'


TOKENS = {
    "{{product_cards}}": product_cards,
    "{{fold}}": fold,
    "{{product_usecase_cards}}": product_usecase_cards,
    "{{usecase_groups}}": lambda: usecase_groups(),
    "{{case_groups}}": lambda: case_groups(),
    "{{industry_tiles}}": industry_tiles,
    "{{product_industry_grid}}": product_industry_grid,
    "{{case_cards}}": lambda: case_cards(),
    "{{insight_cards}}": insight_cards,
    "{{flow}}": flow,
    "{{engage_steps}}": engage_steps,
    "{{demo_widget}}": demo_widget,
    "{{booking_link}}": booking_link,
}


def render_tokens(body, meta):
    body = re.sub(r'\{\{cta(?: "([^"]+)")?\}\}', lambda m: cta_band(m.group(1)) if m.group(1) else cta_band(), body)
    for tok, fn in TOKENS.items():
        if tok in body:
            body = body.replace(tok, fn())
    body = re.sub(r"\{\{form:(\w+)\}\}", lambda m: form(m.group(1)), body)
    body = re.sub(r"\{\{case_cards:([\w-]+)\}\}", lambda m: case_cards(m.group(1)), body)
    body = re.sub(r"\{\{usecases:([\w-]+)\}\}", lambda m: usecase_teaser(m.group(1)), body)
    body = body.replace("{{faq}}", faq_html(meta.get("faq")))
    left = re.findall(r"\{\{[^}]+\}\}", body)
    if left:
        raise SystemExit(f"Unknown token(s) {left} in {meta['path']}")
    return body


# ---------------------------------------------------------------- JSON-LD
ORG_ID = SITE + "/#organization"
FOUNDER_ID = SITE + "/about/#founder"


def org_ld():
    return {
        "@type": "Organization", "@id": ORG_ID, "name": NAME, "url": SITE + "/",
        "logo": SITE + "/assets/img/logo-512.png", "email": EMAIL, "telephone": PHONE,
        "address": {"@type": "PostalAddress", "addressLocality": "Mumbai", "addressRegion": "Maharashtra", "addressCountry": "IN"},
        "founder": {"@id": FOUNDER_ID}, "sameAs": [LINKEDIN],
    }


def jsonld(meta, path):
    url = SITE + path
    graph = [org_ld()]
    kinds = meta.get("schema", [])
    if "ProfessionalService" in kinds:
        graph.append({
            "@type": "ProfessionalService", "@id": SITE + "/#service", "name": NAME, "url": SITE + "/",
            "image": SITE + SHARE_IMAGE, "telephone": PHONE, "email": EMAIL, "parentOrganization": {"@id": ORG_ID},
            "address": {"@type": "PostalAddress", "addressLocality": "Mumbai", "addressRegion": "Maharashtra", "addressCountry": "IN"},
            "areaServed": AREAS,
        })
    if "SoftwareApplication" in kinds:
        p = meta["product"]
        graph.append({
            "@type": "SoftwareApplication", "name": p["name"], "url": url, "applicationCategory": "BusinessApplication",
            "operatingSystem": "Web browser; server runs in your environment", "description": strip_ph(meta["description"]),
            "featureList": p["features"], "publisher": {"@id": ORG_ID},
        })
    if "Service" in kinds:
        s = meta["service"]
        graph.append({
            "@type": "Service", "name": s["name"], "serviceType": s["type"], "url": url, "provider": {"@id": ORG_ID},
            "areaServed": AREAS, "description": strip_ph(meta["description"]),
        })
    if "Person" in kinds:
        graph.append({"@type": "Person", "@id": FOUNDER_ID, "name": FOUNDER, "jobTitle": "Founder",
                      "worksFor": {"@id": ORG_ID}, "url": SITE + "/about/"})
    if "Article" in kinds:
        graph.append({
            "@type": "Article", "headline": strip_ph(meta["h1"]), "description": strip_ph(meta["description"]),
            "datePublished": meta["date"], "dateModified": meta.get("modified", meta["date"]), "url": url,
            "mainEntityOfPage": url, "image": SITE + SHARE_IMAGE,
            "author": {"@type": "Person", "@id": FOUNDER_ID, "name": FOUNDER, "url": SITE + "/about/"},
            "publisher": {"@id": ORG_ID},
        })
    if meta.get("faq"):
        graph.append({"@type": "FAQPage", "mainEntity": [
            {"@type": "Question", "name": strip_ph(q), "acceptedAnswer": {"@type": "Answer", "text": strip_ph(re.sub("<[^>]+>", "", a))}}
            for q, a in meta["faq"]]})
    crumbs = meta.get("breadcrumbs")
    if crumbs:
        items = [("Home", "/")] + [(n, h or path) for n, h in crumbs]
        graph.append({"@type": "BreadcrumbList", "itemListElement": [
            {"@type": "ListItem", "position": i + 1, "name": strip_ph(n), "item": SITE + h} for i, (n, h) in enumerate(items)]})
    doc = {"@context": "https://schema.org", "@graph": graph}
    return json.dumps(doc, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")


# ---------------------------------------------------------------- layout
def nav_html(active):
    out = []
    for key, label, href, children in NAV:
        cur = ' aria-current="page"' if active == key else ""
        if children:
            sub = "".join(f'<li><a href="{h}">{esc(l)}</a></li>' if h else f'<li class="grp" aria-hidden="true">{esc(l)}</li>' for l, h in children)
            out.append(f'<li class="has-sub"><details{" class=current" if active == key else ""}><summary>{label}</summary><ul>{sub}</ul></details></li>')
        else:
            out.append(f'<li><a href="{href}"{cur}>{label}</a></li>')
    return "".join(out)


STYLE_V = ""
JS_V = ""


def layout(meta, body):
    path = meta["path"]
    title = strip_ph(meta["title"])
    desc = strip_ph(meta["description"])
    url = SITE + path
    noindex = meta.get("noindex")
    year = date.today().year
    preload = '<link rel="preload" as="image" href="' + meta["preload"] + '">\n' if meta.get("preload") else ""
    footer_inds = "".join(f'<li><a href="/use-cases/{i["slug"]}/">{i["name"]}</a></li>' for i in data.INDUSTRIES)
    return f"""<!doctype html>
<html lang="en-IN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{esc(title)}</title>
<meta name="description" content="{esc(desc)}">
{'<meta name="robots" content="noindex">' if noindex else ''}
<link rel="canonical" href="{url}">
<meta property="og:type" content="{'article' if 'Article' in meta.get('schema', []) else 'website'}">
<meta property="og:site_name" content="{NAME}">
<meta property="og:locale" content="en_IN">
<meta property="og:title" content="{esc(title)}">
<meta property="og:description" content="{esc(desc)}">
<meta property="og:url" content="{url}">
<meta property="og:image" content="{SITE}{SHARE_IMAGE}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="SyncSense: trusted answers from your business data">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="{esc(title)}">
<meta name="twitter:description" content="{esc(desc)}">
<meta name="twitter:image" content="{SITE}{SHARE_IMAGE}">
<meta name="theme-color" content="#0b1166">
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="apple-touch-icon" href="/assets/img/apple-touch-icon.png">
{preload}<link rel="stylesheet" href="/assets/styles.css?v={STYLE_V}">
<script type="application/ld+json">{jsonld(meta, path)}</script>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="site-header">
  <div class="wrap bar">
    <a class="logo" href="/" aria-label="SyncSense home"><img src="{LOGO}" alt="" width="56" height="56"><span class="brand"><span class="name">SyncSense</span><span class="tagline">{TAGLINE}</span></span></a>
    <input class="nav-toggle" type="checkbox" id="nav-toggle">
    <label class="nav-toggle-label" for="nav-toggle"><span class="sr">Menu</span><span class="burger" aria-hidden="true"></span></label>
    <nav class="main-nav" aria-label="Main"><ul>{nav_html(meta.get("nav"))}</ul></nav>
    {booking_link("Book a demo", "btn btn-sm header-cta")}
  </div>
</header>
{breadcrumb_html(meta.get("breadcrumbs"))}
<main id="main">
{body}
</main>
<footer class="site-footer">
  <div class="wrap footer-grid">
    <div class="footer-brand">
      <img src="{LOGO}" alt="" width="48" height="48" loading="lazy">
      <p><strong>SyncSense</strong>: AI data products and senior data consulting. Based in {CITY}; working with clients in India, the Middle East, Africa and the UK.</p>
      <p><a href="mailto:{EMAIL}">{EMAIL}</a><br><a href="tel:{PHONE_LINK}">{PHONE}</a><br><a href="{LINKEDIN}" rel="noopener" target="_blank">SyncSense on LinkedIn</a></p>
    </div>
    <div><h2>Products</h2><ul><li><a href="/products/text-to-sql/">AskData: Text-to-SQL</a></li><li><a href="/products/ontology-builder/">Ontology Studio</a></li><li><a href="/products/crm/">Ovantaa CRM</a></li></ul>
      <h2>Services</h2><ul><li><a href="/services/data-ai-consulting/">Data &amp; AI consulting</a></li><li><a href="/services/data-analytics-staffing/">Contract staffing</a></li><li><a href="/free-data-assessment/">Free data assessment</a></li></ul></div>
    <div><h2>Use cases</h2><ul>{footer_inds}</ul></div>
    <div><h2>Company</h2><ul><li><a href="/about/">About</a></li><li><a href="/case-studies/">Case studies</a></li><li><a href="/insights/">Insights</a></li><li><a href="/contact/">Contact</a></li><li><a href="/privacy-policy/">Privacy policy</a></li></ul></div>
  </div>
  <div class="wrap copyright">© {year} SyncSense. All rights reserved.</div>
</footer>
<script src="/assets/site.js?v={JS_V}" defer></script>
</body>
</html>
"""


def emit(meta, body):
    path = meta["path"]
    body = render_tokens(body, meta)
    for kind, text in PH_RE.findall(body):
        PLACEHOLDERS.append((path, kind, text.strip()))
    body = PH_RE.sub(lambda m: f'<mark class="ph" title="To be completed before launch">[{m.group(1)}: {m.group(2)}]</mark>', body)
    page = layout(meta, body)
    dest = OUT / path.strip("/") / "index.html" if path != "/" else OUT / "index.html"
    if path == "/404.html":
        dest = OUT / "404.html"
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(page, encoding="utf-8")
    h1 = re.findall(r"<h1[^>]*>(.*?)</h1>", body, re.S)
    if len(h1) != 1:
        raise SystemExit(f"{path}: expected exactly one <h1>, found {len(h1)}")
    PAGES.append({**meta, "h1_text": re.sub("<[^>]+>", "", h1[0]).strip()})
    if not meta.get("noindex"):
        t, d = strip_ph(meta["title"]), strip_ph(meta["description"])
        if len(t) > 60 or not t.endswith("| SyncSense"):
            print(f"  WARN title {len(t)} chars: {path}: {t}")
        if not 140 <= len(d) <= 155:
            print(f"  WARN description {len(d)} chars: {path}")


def read_page(f):
    raw = f.read_text(encoding="utf-8")
    m = re.match(r"---\n(.*?)\n---\n(.*)", raw, re.S)
    if not m:
        raise SystemExit(f"{f}: missing --- header ---")
    meta = json.loads(m.group(1))
    return meta, m.group(2)


ARTICLES = []


def load_articles():
    for f in sorted((CONTENT / "insights").glob("*.html")):
        meta, body = read_page(f)
        d = date.fromisoformat(meta["date"])
        meta["date_label"] = d.strftime("%d %b %Y").lstrip("0")
        ARTICLES.append({**meta, "body": body})
    ARTICLES.sort(key=lambda a: a["date"], reverse=True)


# ---------------------------------------------------------------- generated pages
def industry_page(ind):
    path = f"/use-cases/{ind['slug']}/"
    scen = "".join(
        f"""<article class="scenario"><p class="tag">Example scenario · {esc(s['product'])}</p><h3>{esc(s['title'])}</h3>{s['body']}</article>"""
        for s in ind["scenarios"]
    )
    qs = "".join(f"<li>“{esc(q)}”</li>" for q in ind["questions"])
    ents = "".join(f"<li>{esc(e)}</li>" for e in ind["entities"])
    probs = "".join(f"<li>{p}</li>" for p in ind["problems"])
    cases = case_cards(ind["slug"])
    proof = (f'<section class="section alt"><div class="wrap"><h2>Our work in {esc(ind["name"].lower())}</h2>'
             f'<p>Real projects, anonymized.</p>{cases}</div></section>') if cases else ""
    if ind.get("proof_note"):
        proof += f'<section class="section"><div class="wrap narrow"><p>{ind["proof_note"]}</p></div></section>'
    others = "".join(f'<li><a href="/use-cases/{o["slug"]}/">{o["name"]}</a></li>' for o in data.INDUSTRIES if o["slug"] != ind["slug"])
    extra = ind.get("extra", "")
    body = f"""
<section class="page-head"><div class="wrap narrow">
  <p class="eyebrow">Use case</p>
  <h1>{ind['h1']}</h1>
  <p class="answer">{ind['answer']}</p>
  <div class="actions">{booking_link()}<a class="btn ghost" href="/free-data-assessment/">Get a free data assessment</a></div>
</div></section>

<section class="section"><div class="wrap two-col">
  <div><h2>Data problems {esc(ind['name'].lower())} teams tell us about</h2><ul class="ticks">{probs}</ul></div>
  <div class="panel"><h2>Questions you could ask AskData</h2><ul class="qlist">{qs}</ul>
  <p class="small">Examples only. In a pilot we replace them with your own top questions.</p></div>
</div></section>

<section class="section alt"><div class="wrap">
  <h2>How the products apply: example scenarios</h2>
  <p class="lead-in">These are illustrations of how SyncSense products can be used in {esc(ind['name'].lower())}. They are not client results.</p>
  <div class="grid-3">{scen}</div>
</div></section>

<section class="section"><div class="wrap two-col">
  <div><h2>What the Ontology Studio would connect</h2><p>{ind['ontology_intro']}</p><ul class="chips">{ents}</ul></div>
  <div><h2>Kept under control</h2><ul class="ticks">{''.join(f'<li>{c}</li>' for c in ind['controls'])}</ul></div>
</div></section>
{extra}
{proof}
{faq_html(ind.get('faq'))}
<section class="section"><div class="wrap two-col"><div><h2>Use cases by product</h2><ul class="inline-links"><li><a href="/use-cases/askdata/">AskData use cases</a></li><li><a href="/use-cases/ontology-studio/">Ontology Studio use cases</a></li><li><a href="/use-cases/ovantaa-crm/">Ovantaa CRM use cases</a></li></ul></div>
<div><h2>Other industries</h2><ul class="inline-links">{others}</ul></div></div></section>
{cta_band()}
"""
    meta = {"path": path, "title": ind["title"], "description": ind["description"], "keyword": ind["keyword"],
            "nav": "use-cases", "breadcrumbs": [["Use Cases", "/use-cases/"], [ind["name"], None]],
            "faq": ind.get("faq"), "schema": []}
    emit(meta, body)


def group_cases(key):
    for _, groups in data.CASE_GROUPS:
        for k, *_rest, slugs in groups:
            if k == key:
                return [c for sl in slugs for c in data.CASE_STUDIES if c["slug"] == sl]
    return []


def case_card(c):
    return (f'<a class="ccard" href="/case-studies/{c["slug"]}/"><span class="tag">Case study · {esc(c["sector"])}</span><h3>{esc(c["title"])}</h3>'
            f'<p>{esc(c["summary"])}</p>{"<p class=stat>" + esc(c["headline_stat"]) + "</p>" if c.get("headline_stat") else ""}<span class="more">Read the case study →</span></a>')


def product_usecase_page(u):
    path = f"/use-cases/{u['slug']}/"
    cases_by_slug = {c["slug"]: c for c in data.CASE_STUDIES}

    def card(i, c):
        if u["slug"] == "askdata":
            qs = "".join(f"<li>“{esc(q)}”</li>" for q in c["questions"])
            more = f' <a href="{c["link"]}">More for {esc(c["industry"].lower())} →</a>' if c.get("link") else ""
            inner = (f'<p class="who"><strong>Who asks:</strong> {esc(c["who"])}</p><p class="mini">Questions on day one</p><ul class="qlist">{qs}</ul>'
                     f'<p><strong>Looking ahead:</strong> {esc(c["ahead"])}</p><p class="small"><strong>Kept under control:</strong> {esc(c["control"])}{more}</p>')
        elif u["slug"] == "ontology-studio":
            std = "".join(f"<li>{esc(x)}</li>" for x in c["standards"])
            uses = "".join(f"<li>{esc(x)}</li>" for x in c["uses"])
            link = f'<p class="small"><a href="{c["link"]}">Read the case study →</a></p>' if c.get("link") else ""
            inner = (f'<p class="size">{esc(c["size"])}</p><p><strong>What it models:</strong> {esc(c["models"])}</p>'
                     + (f'<p class="mini">Built on</p><ul class="chips">{std}</ul>' if std else "")
                     + f'<p class="mini">Typical uses</p><ul class="ticks">{uses}</ul>{link}')
        elif u["slug"] == "consulting":
            steps = "".join(f"<li>{esc(x)}</li>" for x in c["steps"])
            cs = cases_by_slug.get(c.get("case"))
            link = f'<p class="small"><a href="/case-studies/{cs["slug"]}/">Case study: {esc(cs["short"])} →</a></p>' if cs else ""
            inner = (f'<p class="who"><strong>For:</strong> {esc(c["who"])}</p><p class="mini">What we do</p><ul class="ticks">{steps}</ul>'
                     f'<p class="small"><strong>Industries:</strong> {esc(c["industries"])}</p>{link}')
        else:
            steps = "".join(f"<li>{esc(x)}</li>" for x in c["steps"])
            inner = (f'<p class="who"><strong>Who uses it:</strong> {esc(c["who"])}</p><p class="mini">How it works</p><ul class="ticks">{steps}</ul>'
                     f'<p class="small">{esc(c["fit"])}</p>')
        return f'<article class="uc" id="uc-{i + 1}"><p class="tag">{esc(c["industry"])}</p><h2>{esc(c["title"])}</h2>{inner}</article>'

    if u["slug"] == "consulting":
        blocks = ""
        idx = 0
        for grp, key, href in (("Data & AI consulting", "consulting", "/services/data-ai-consulting/"), ("Contract staffing", "staffing", "/services/data-analytics-staffing/")):
            items = ""
            for c in u["cases"]:
                if c["group"] == grp:
                    items += card(idx, c)
                idx += 1 if c["group"] == grp else 0
            blocks += (f'<div class="uc-group" id="{key}"><div class="uc-group-head"><h2>{grp}</h2><a href="{href}">About {grp} →</a></div>'
                       f'<div class="uc-grid">{items}</div></div>')
        related_keys = ["consulting", "staffing"]
    else:
        blocks = '<div class="uc-grid">' + "".join(card(i, c) for i, c in enumerate(u["cases"])) + "</div>"
        related_keys = [u["slug"]]
    related = [c for k in related_keys for c in group_cases(k)]
    related_html = (f'<section class="section alt"><div class="wrap"><h2>Case studies</h2><p class="lead-in">Real projects behind these use cases, with client names withheld.</p>'
                    f'<div class="grid-3">{"".join(case_card(c) for c in related)}</div></div></section>') if related else ""
    if u.get("image"):
        img, w, h, alt = u["image"]
        hero_media = f'<figure class="screen"><img src="/assets/img/{img}.webp" alt="{esc(alt)}" width="{w}" height="{h}" fetchpriority="high"></figure>'
        grid = "hero-grid"
    else:
        hero_media, grid = "", "narrow"
    others = "".join(f'<li><a href="/use-cases/{o["slug"]}/">{o["product"]} use cases</a></li>'
                     for o in data.PRODUCT_USE_CASES.values() if o["slug"] != u["slug"])
    kind = "Services" if u["slug"] == "consulting" else "Products"
    body = f"""
<section class="page-head"><div class="wrap {grid}">
  <div>
    <p class="eyebrow">Use cases · {kind} · <a href="{u['product_href']}">{u['product']}</a></p>
    <h1>{u['h1']}</h1>
    <p class="answer">{u['answer']}</p>
    <div class="actions">{booking_link()}<a class="btn ghost" href="{u['product_href']}">About {u['product']}</a></div>
  </div>
  {hero_media}
</div></section>
<section class="section"><div class="wrap">
  <p class="lead-in">These are examples of how {u['product']} applies, not client results. Real projects are listed under case studies below.</p>
  {blocks}
  {f'<p class="small" style="margin-top:20px">{esc(u["more"])}</p>' if u.get("more") else ""}
</div></section>
{related_html}
<section class="section"><div class="wrap"><h2>More use cases</h2><ul class="inline-links">{others}</ul>
<p>Or browse <a href="/use-cases/#by-industry">use cases by industry</a>.</p></div></section>
{cta_band()}
"""
    meta = {"path": path, "title": u["title"], "description": u["description"], "keyword": u["keyword"],
            "nav": "use-cases", "breadcrumbs": [["Use Cases", "/use-cases/"], [f"{u['product']} use cases", None]], "schema": []}
    emit(meta, body)


def usecase_groups():
    """Use Cases hub: Products and Services, each with its use-case pages and case studies."""
    pu = data.PRODUCT_USE_CASES
    def block(key, title, desc, inds):
        n = len(group_cases(key)) + (len(group_cases("staffing")) if key == "consulting" else 0)
        cs = f" · {n} case stud{'y' if n == 1 else 'ies'}" if n else ""
        return (f'<a class="pcard" href="/use-cases/{key}/"><span class="tag">{len(pu[key]["cases"])} use cases{cs}</span>'
                f'<h3>{title}</h3><p>{esc(desc)}</p><p class="small">{esc(inds)}</p><span class="more">See use cases →</span></a>')
    ind = lambda k: ", ".join(dict.fromkeys(c["industry"] for c in pu[k]["cases"]))
    prod = (block("askdata", "AskData", "Text-to-SQL: plain-English questions answered from your own databases.", ind("askdata"))
            + block("ontology-studio", "Ontology Studio", "Shared business models and knowledge graphs, built on industry standards.", ind("ontology-studio"))
            + block("ovantaa-crm", "Ovantaa CRM", "Lead to cash for B2B teams: deals, campaigns, GST invoicing and collections.", ind("ovantaa-crm")))
    serv = block("consulting", "Consulting & staffing", "Data readiness, MIS automation, AI to production, private language models, managed BI teams, and technical, functional and AI specialists.",
                 "Data & AI consulting · Contract staffing")
    return (f'<div class="group-block"><h2 class="group-title">Products</h2><div class="grid-3">{prod}</div></div>'
            f'<div class="group-block"><h2 class="group-title">Services</h2><div class="grid-3">{serv}'
            f'<a class="pcard" href="/case-studies/"><span class="tag">All case studies</span><h3>Case studies</h3><p>Real projects grouped by product and service, with client names withheld.</p><span class="more">See case studies →</span></a></div></div>')


def case_groups():
    """Case Studies hub: grouped under Products and Services."""
    by = {c["slug"]: c for c in data.CASE_STUDIES}
    out = ""
    for top, groups in data.CASE_GROUPS:
        out += f'<div class="group-block"><h2 class="group-title">{top}</h2>'
        for key, label, href, product, slugs in groups:
            link = f'<a href="{href}">{"About " + (product or label)} →</a>'
            if slugs:
                cards = "".join(case_card(by[sl]) for sl in slugs)
                out += f'<div class="uc-group" id="{key}"><div class="uc-group-head"><h3>{label}{" (" + product + ")" if product else ""}</h3>{link}</div><div class="grid-3">{cards}</div></div>'
            else:
                out += (f'<div class="uc-group" id="{key}"><div class="uc-group-head"><h3>{label}{" (" + product + ")" if product else ""}</h3>{link}</div>'
                        f'<p class="small">No published case study yet. See <a href="/use-cases/{key}/">{product} use cases</a>.</p></div>')
        out += "</div>"
    return out


def case_page(c):
    path = f"/case-studies/{c['slug']}/"
    ch = "".join(f"<li>{x}</li>" for x in c["challenge"])
    steps = "".join(f'<li><h3>{esc(t)}</h3><p>{d}</p></li>' for t, d in c["approach"])
    why = ""
    if c.get("why"):
        why = f'<section class="section alt"><div class="wrap"><h2>{esc(c["why_title"])}</h2><div class="grid-3">' + "".join(
            f'<div class="card-plain"><h3>{esc(t)}</h3><p>{d}</p></div>' for t, d in c["why"]) + "</div></div></section>"
    results = ""
    if c.get("results"):
        results = f'<section class="section"><div class="wrap"><h2>{esc(c.get("results_title", "Results"))}</h2><div class="stats">' + "".join(
            f'<div class="stat-box"><p class="big">{esc(s)}</p><p class="lbl">{esc(l)}</p><p>{d}</p></div>' for s, l, d in c["results"]) + "</div></div></section>"
    status = ""
    if c.get("status"):
        status = '<section class="section alt"><div class="wrap"><h2>Engagement status</h2><div class="grid-3">' + "".join(
            f'<div class="card-plain"><p class="tag">{esc(k)}</p><h3>{esc(t)}</h3><p>{d}</p></div>' for k, t, d in c["status"]) + "</div></div></section>"
    used = "".join(f'<li><a href="{h}">{esc(n)}</a></li>' for n, h in c["related"])
    body = f"""
<section class="page-head"><div class="wrap narrow">
  <p class="eyebrow">Case study · {esc(c['sector'])}</p>
  <h1>{esc(c['title'])}</h1>
  <p class="answer">{c['intro']}</p>
</div></section>
<section class="section"><div class="wrap two-col">
  <div><h2>The challenge</h2><ul class="ticks">{ch}</ul></div>
  <div><h2>What we built</h2><ol class="numbered">{steps}</ol></div>
</div></section>
{why}{results}{status}
<section class="section"><div class="wrap narrow">
  <p class="small">{c['disclosure']}</p>
  <h2>Related</h2><ul class="inline-links">{used}</ul>
</div></section>
{cta_band("Have a similar problem?", "Tell us about it. We start with a demo or a fixed-scope assessment on your own data.")}
"""
    meta = {"path": path, "title": c["meta_title"], "description": c["description"], "keyword": c["keyword"],
            "nav": "case-studies", "breadcrumbs": [["Case Studies", "/case-studies/"], [c["short"], None]], "schema": []}
    emit(meta, body)


def article_page(a):
    meta = {k: v for k, v in a.items() if k != "body"}
    meta.setdefault("schema", ["Article"])
    meta["nav"] = "insights"
    meta["breadcrumbs"] = [["Insights", "/insights/"], [a["short"], None]]
    byline = (f'<p class="byline">By <a href="/about/">{FOUNDER}</a>, Founder, SyncSense · '
              f'<time datetime="{a["date"]}">{a["date_label"]}</time> · {a["read"]} min read</p>')
    body = f"""<article class="article"><div class="wrap narrow">
<p class="eyebrow">Insights</p>
<h1>{a['h1']}</h1>
{byline}
{a['body']}
</div></article>
{cta_band()}"""
    emit(meta, body)


# ---------------------------------------------------------------- outputs
def write_htaccess():
    lines = "\n".join(f"  RewriteRule ^{re.escape(o.strip('/'))}/?$ {n} [R=301,L]" for o, n in REDIRECTS if o != "/about")
    lines += "\n" + "\n".join(f"  RewriteRule ^{re.escape(o.strip('/'))}\\.html$ {n} [R=301,L]" for o, n in REDIRECTS)
    tpl = (SRC / ".htaccess").read_text()
    (OUT / ".htaccess").write_text(tpl.replace("# {{REDIRECTS}}", lines))


def write_sitemap():
    urls = "".join(
        f"  <url><loc>{SITE}{p['path']}</loc><lastmod>{p.get('modified', p.get('date', TODAY))}</lastmod></url>\n"
        for p in PAGES if not p.get("noindex")
    )
    (OUT / "sitemap.xml").write_text(
        f'<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n{urls}</urlset>\n')


def write_llms():
    inds = "\n".join(f"- [{i['name']}]({SITE}/use-cases/{i['slug']}/): {i['llms']}" for i in data.INDUSTRIES)
    cases = "\n".join(f"- [{c['title']}]({SITE}/case-studies/{c['slug']}/)" for c in data.CASE_STUDIES)
    arts = "\n".join(f"- [{a['h1']}]({SITE}{a['path']})" for a in ARTICLES)
    txt = f"""# SyncSense

> SyncSense is a data and AI company in Mumbai, India. It builds AI products (AskData for Text-to-SQL, Ontology Studio, Ovantaa CRM) and provides data management, BI and AI consulting and contract staffing. It helps organisations get trusted answers from data spread across many systems, in plain English, without waiting on IT. Founded by {FOUNDER}; the team has 25+ years of enterprise data, BI and data integration delivery.

## Products
- [AskData: Text-to-SQL]({SITE}/products/text-to-sql/): business users ask questions of their own databases in plain English and get SQL, a table, a chart and a summary. Runs in the customer's environment; the AI model receives only the question and table descriptions, never result data. Read-only by design.
- [Ontology Studio]({SITE}/products/ontology-builder/): builds a domain ontology and knowledge graph (classes, relations, properties, metadata) from documents and systems, used for cited AI answers (GraphRAG) and shared definitions.
- [Ovantaa CRM]({SITE}/products/crm/): CRM, campaigns, GST-ready invoicing and collections for small and mid-size B2B teams in India and the GCC, hosted in the customer's own environment.

## Services
- [Data & AI consulting]({SITE}/services/data-ai-consulting/): data readiness, architecture, BI and reporting, data warehousing, taking AI from pilot to production, private small language models.
- [Contract staffing]({SITE}/services/data-analytics-staffing/): data engineers, BI developers, data scientists, architects, forward deployed engineers.
- [Free data assessment]({SITE}/free-data-assessment/): fixed scope, ends with a working prototype on the client's data.

## Use cases by industry
{inds}

## Case studies (anonymized)
{cases}

## Insights
{arts}

## Contact
- Email: {EMAIL}
- Phone: {PHONE}
- Location: {CITY}
- LinkedIn: {LINKEDIN}
"""
    (OUT / "llms.txt").write_text(txt)


def write_docs():
    DOCS.mkdir(exist_ok=True)
    rows = "\n".join(
        f"| `{p['path']}` | {strip_ph(p['title'])} ({len(strip_ph(p['title']))}) | {strip_ph(p['description'])} ({len(strip_ph(p['description']))}) | {p['h1_text']} | {p.get('keyword', '')} |"
        for p in PAGES if not p.get("noindex")
    )
    (DOCS / "pages.md").write_text(
        "# Pages: titles, descriptions, H1s and keywords\n\nGenerated by `build.py`. Numbers in brackets are character counts.\n\n"
        "| URL | Title | Meta description | H1 | Target keyword |\n|---|---|---|---|---|\n" + rows + "\n")
    seen, lines = set(), []
    for path, kind, text in PLACEHOLDERS:
        key = (path, kind, text)
        if key not in seen:
            seen.add(key)
            lines.append(f"| `{path}` | {kind} | {text} |")
    (DOCS / "placeholders.md").write_text(
        "# Placeholders still to fill\n\nGenerated by `build.py` from the `[PROOF: …]`, `[PLACEHOLDER: …]` and `[CONFIRM: …]` markers. "
        "They show highlighted on the preview site until replaced.\n\n| Page | Type | What is needed |\n|---|---|---|\n" + "\n".join(lines) + "\n")
    red = "\n".join(f"| `{o}` | `{n}` |" for o, n in REDIRECTS)
    (DOCS / "redirects.md").write_text("# Redirect map (301)\n\nOld Website Builder URL → new URL. Implemented in `src/.htaccess`.\n\n| Old URL | New URL |\n|---|---|\n" + red + "\n")


TODAY = date.today().isoformat()


def main():
    global STYLE_V, JS_V
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir()
    shutil.copytree(ROOT / "assets", OUT / "assets")
    for name, var in (("styles.css", "STYLE_V"), ("site.js", "JS_V")):
        b = (SRC / name).read_bytes()
        (OUT / "assets" / name).write_bytes(b)
        globals()[var] = hashlib.sha1(b).hexdigest()[:8]
    for name in ("favicon.ico", "contact.php", "robots.txt"):
        shutil.copy2(SRC / name, OUT / name)

    load_articles()
    for f in sorted((CONTENT / "pages").rglob("*.html")):
        meta, body = read_page(f)
        emit(meta, body)
    for u in data.PRODUCT_USE_CASES.values():
        product_usecase_page(u)
    for ind in data.INDUSTRIES:
        industry_page(ind)
    for c in data.CASE_STUDIES:
        case_page(c)
    for a in ARTICLES:
        article_page(a)

    write_htaccess()
    write_sitemap()
    write_llms()
    write_docs()
    paths = [p["path"] for p in PAGES]
    dupes = {p for p in paths if paths.count(p) > 1}
    if dupes:
        raise SystemExit(f"Duplicate paths: {dupes}")
    print(f"Built {len(PAGES)} pages -> {OUT}  ({len(PLACEHOLDERS)} placeholder markers)")


if __name__ == "__main__":
    main()
