#!/usr/bin/env python3
"""Build the SyncSense static website into ./public.

Each page is defined below as a title, description, nav key and body HTML.
The shared header, footer and <head> are added here, so a change to the
navigation or contact details only needs to be made once.

Usage:  python3 build.py
Output: public/  (upload this folder, or the zip made by deploy steps)
"""
import shutil
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "src"
OUT = ROOT / "public"

SITE = "https://www.syncsense.in"
PHONE = "+91 9136433008"
PHONE_LINK = "+919136433008"
EMAIL = "sales@syncsense.in"
TAGLINE = "Uniting Intelligence, Empowering Outcomes"
APPROACH_PDF = "/assets/docs/bi-readiness-assessment-approach.pdf"

NAV = [
    ("home", "Home", "/"),
    ("reporting", "Reporting Services", "/reporting-services"),
    ("staffing", "Staffing Solutions", "/staffing-solutions"),
    ("about", "About", "/about", [
        ("contact", "Get In Touch", "/get-in-touch"),
        ("testimonials", "Testimonials", "/testimonials"),
    ]),
    ("blog", "Blog", "/blog-list"),
]


def img(name, alt, w=1400, h=764, lazy=True, cls=""):
    attrs = f' class="{cls}"' if cls else ""
    load = ' loading="lazy" decoding="async"' if lazy else ' fetchpriority="high"'
    return f'<img src="/assets/img/{name}.webp" alt="{alt}" width="{w}" height="{h}"{load}{attrs}>'


def nav_html(active):
    items = []
    for entry in NAV:
        key, label, href = entry[:3]
        if len(entry) == 4:
            children = entry[3]
            current = active == key or active in [c[0] for c in children]
            sub = "".join(
                f'<li><a href="{h}"{" aria-current=\"page\"" if active == k else ""}>{l}</a></li>'
                for k, l, h in [(key, label, href)] + children
            )
            items.append(
                f'<li><details{" class=\"current\"" if current else ""}><summary>{label}</summary><ul>{sub}</ul></details></li>'
            )
        else:
            cur = ' aria-current="page"' if active == key else ""
            items.append(f'<li><a href="{href}"{cur}>{label}</a></li>')
    return "".join(items)


def contact_form(source, full=False, heading=None):
    """Contact form posting to /contact.php. full=True adds company and phone."""
    extra = ""
    if full:
        extra = """
      <div class="row-2">
        <label>Company <input type="text" name="company" placeholder="Enter company name" autocomplete="organization"></label>
        <label>Phone number* <input type="tel" name="phone" placeholder="Enter your contact number" autocomplete="tel" required></label>
      </div>"""
    head = f"<h2>{heading}</h2>" if heading else ""
    name_label = "Name*" if full else "Your first name"
    name_req = " required" if full else ""
    return f"""{head}
    <form class="form" action="/contact.php" method="post">
      <input type="hidden" name="source" value="{source}">
      <div class="hp" aria-hidden="true"><label>Leave this empty <input type="text" name="website" tabindex="-1" autocomplete="off"></label></div>
      <div class="row-2">
        <label>{name_label} <input type="text" name="name" placeholder="Your name" autocomplete="name"{name_req}></label>
        <label>Email address* <input type="email" name="email" placeholder="Your email address" autocomplete="email" required></label>
      </div>{extra}
      <label>Message* <textarea name="message" placeholder="Type your message here" required></textarea></label>
      <div><button class="btn" type="submit">Submit your inquiry</button></div>
      <p class="note">We reply from {EMAIL}, usually within one business day.</p>
    </form>"""


def contact_block(source, intro=True):
    lead = (
        "<p>Contact SyncSense for expert technology consulting and analytics services. "
        "We're here to accelerate your digital transformation journey.</p>" if intro else ""
    )
    return f"""
<section class="section alt" id="contact">
  <div class="wrap contact-grid">
    <div>
      <h2>Get in Touch</h2>
      {lead}
      <div class="contact-item"><h3>Call Us</h3><a href="tel:{PHONE_LINK}">{PHONE}</a></div>
      <div class="contact-item"><h3>Email Us</h3><a href="mailto:{EMAIL}">{EMAIL}</a></div>
      <div class="contact-item"><h3>Address</h3><p>Interface, Mumbai, India</p></div>
    </div>
    <div>
      <div class="notice ok" data-status="sent" hidden>Thank you, your message has been sent. We'll be in touch soon.</div>
      <div class="notice err" data-status="error" hidden>Sorry, your message could not be sent. Please email us at <a href="mailto:{EMAIL}">{EMAIL}</a>.</div>
      {contact_form(source)}
    </div>
  </div>
</section>"""


# ---------------------------------------------------------------- pages

HOME = f"""
<section class="section">
  <div class="wrap">
    <div class="split">
      <div class="media">{img("free-assessment", "Team reviewing a business reporting dashboard on a large screen", lazy=False)}</div>
      <div>
        <h1 style="font-size:clamp(1.6rem,3vw,2rem)">Free MIS &amp; Business Reporting Assessment</h1>
        <ul>
          <li><strong>Audit &amp; Gap Analysis:</strong> A deep dive into your current data workflows to identify manual bottlenecks, Excel dependencies, and "single points of failure" in your reporting.</li>
          <li><strong>Modernization Roadmap:</strong> A strategic step-by-step plan to transition from legacy reporting to automated, real-time BI dashboards.</li>
          <li><strong>High-Level Prototype:</strong> A visual mockup or "wireframe" of your future state dashboard, demonstrating how your specific KPIs will be visualized.</li>
          <li><strong>Business Impact Report:</strong> A clear breakdown of potential time savings, reduced human error, and the ROI of moving to a scalable data architecture.</li>
        </ul>
        <div class="actions">
          <a class="btn" href="mailto:{EMAIL}?subject=Request%20for%20Free%20MIS%20%26%20Reporting%20Assessment">Request for Free Assessment</a>
          <a class="btn ghost" href="{APPROACH_PDF}" target="_blank" rel="noopener">Download Approach</a>
        </div>
      </div>
    </div>

    <div class="split reverse">
      <div class="media">{img("ai-llm-skill-engineering", "AI and LLM skill engineering: custom skills, workflows and automation for enterprise models")}</div>
      <div>
        <h2>AI &amp; LLM Skill Engineering</h2>
        <ul>
          <li><strong>Master the art of AI orchestration</strong> by building custom functional and technical skills for models like Claude, GPT, and Gemini.</li>
          <li>We help you develop <strong>advanced prompting frameworks</strong> and automated workflows that transform generic LLMs into specialized, high-performance assets.</li>
          <li>By deploying these <strong>custom-engineered skills</strong> across your enterprise, you can automate complex task sequences and drastically reduce manual operational overhead.</li>
        </ul>
        <div class="actions">
          <a class="btn" href="/ai-and-llm-use-cases">View Use Cases</a>
          <a class="btn ghost" href="{APPROACH_PDF}" target="_blank" rel="noopener">Download Approach</a>
        </div>
      </div>
    </div>
  </div>
</section>

<section class="section alt">
  <div class="wrap">
    <div class="section-title"><p class="eyebrow">Reporting Services</p><h2>Solving your Data Visibility issue</h2></div>
    <div class="grid-3">
      <article class="card">
        {img("management-reporting", "Financial and management reporting: MIS and CFO dashboards")}
        <h3>Management Reporting &amp; Analytics</h3>
        <p class="lead">Transform complex financial data into high-impact, real-time visual narratives that empower executive decision-making.</p>
        <p>Our automated dashboards consolidate fragmented data sources into a single source of truth, delivering critical KPIs—from cash flow liquidity to budget variance—with drill-down precision.</p>
        <div class="actions"><a class="btn" href="/manufacturing-from-factory-floor-to-pandl">View Demo Dashboard</a></div>
      </article>
      <article class="card">
        {img("infosec-analytics", "InfoSec analytics dashboards for security controls and threat monitoring")}
        <h3>InfoSec Analytics</h3>
        <p class="lead">Transform disjointed information security data into actionable intelligence.</p>
        <p>Our Enterprise InfoSec Dashboard standardizes diverse control data into a unified reporting layer, with real-time visibility of security controls and their effectiveness.</p>
        <div class="actions"><a class="btn" href="/reporting-services">Learn More</a></div>
      </article>
      <article class="card">
        {img("data-warehouse-lake", "Data warehousing and data lake architecture with pipelines and storage")}
        <h3>Data Warehousing / Data Lake Services</h3>
        <ul>
          <li><strong>Unified Architecture:</strong> A single source of truth across all enterprise systems.</li>
          <li><strong>High-Speed Pipelines:</strong> Secure ETL/ELT workflows for massive, diverse datasets.</li>
          <li><strong>Hybrid Storage:</strong> Warehouses for BI with scalable lakes for ML.</li>
        </ul>
        <div class="actions"><a class="btn ghost" href="{APPROACH_PDF}" target="_blank" rel="noopener">Download Approach</a></div>
      </article>
    </div>
  </div>
</section>

<section class="section">
  <div class="wrap">
    <div class="section-title"><p class="eyebrow">Staffing Solutions</p><h2>Simplifying Your Hiring Journey</h2></div>
    <div class="grid-3">
      <article class="card">
        {img("project-staffing", "Project-based staffing: tailored talent for focused results")}
        <h3>Project Based Staffing</h3>
        <p>Assemble specialized teams tailored to your specific project milestones and deliverables. From initial scope to final launch, we provide the expertise needed to drive your most critical initiatives to completion.</p>
      </article>
      <article class="card">
        {img("talent-on-demand", "Talent on-demand staffing: professionals collaborating in an office")}
        <h3>Talent On-Demand Staffing</h3>
        <p>Scale your workforce instantly with pre-vetted professionals ready to hit the ground running. Bridge skill gaps and manage fluctuating workloads with flexible, high-caliber talent that integrates seamlessly into your team.</p>
      </article>
      <article class="card">
        {img("offshore-staffing", "Offshore and staffing management across global talent pools")}
        <h3>Offshore &amp; Staffing Management</h3>
        <p>Access global talent pools to reduce operational costs without sacrificing quality or oversight. We handle the recruitment, logistics, and day-to-day management, so you can focus on scaling your business globally.</p>
      </article>
    </div>
  </div>
</section>

<section class="cta-band">
  <div class="wrap">
    <h2>Unlock Insights Today</h2>
    <p>Stay updated on digital transformation solutions.</p>
    <div class="notice ok" data-status="sent" hidden>Thank you, we've received your request.</div>
    <div class="notice err" data-status="error" hidden>Sorry, that didn't go through. Please email {EMAIL}.</div>
    <form class="inline-form" action="/contact.php" method="post">
      <input type="hidden" name="source" value="Home - Unlock Insights">
      <div class="hp" aria-hidden="true" style="position:absolute;left:-5000px"><input type="text" name="website" tabindex="-1" autocomplete="off"></div>
      <label class="hp" for="cta-email" style="position:absolute;left:-5000px">Your email address</label>
      <input id="cta-email" type="email" name="email" placeholder="Enter your email here" autocomplete="email" required>
      <button class="btn" type="submit">Submit Your Inquiry</button>
    </form>
  </div>
</section>
"""

REPORTING = f"""
<section class="page-head"><div class="wrap">
  <h1>Reporting Services</h1>
  <p>Automated dashboards, security analytics and modern data platforms that turn fragmented data into decisions.</p>
</div></section>

<section class="section">
  <div class="wrap grid-3">
    <article class="card">
      {img("management-reporting", "Financial and management reporting: MIS and CFO dashboards", lazy=False)}
      <h2 style="font-size:1.45rem">Management Reporting &amp; Analytics</h2>
      <p class="lead">Transform complex financial data into high-impact, real-time visual narratives that empower executive decision-making.</p>
      <p>Our automated dashboards consolidate fragmented data sources into a single source of truth, delivering critical KPIs—from cash flow liquidity to budget variance—with drill-down precision.</p>
      <p>By eliminating manual reporting cycles, we provide the <strong>financial agility</strong> needed to pivot strategies and optimize capital allocation instantly.</p>
      <div class="actions"><a class="btn" href="/manufacturing-from-factory-floor-to-pandl">View Demo Dashboard</a></div>
    </article>
    <article class="card">
      {img("infosec-analytics", "InfoSec analytics dashboards for security controls and threat monitoring", lazy=False)}
      <h2 style="font-size:1.45rem">InfoSec Analytics</h2>
      <p class="lead">Transform disjointed information security data into actionable intelligence.</p>
      <p>Our <strong>Enterprise InfoSec Dashboard solution</strong> standardizes diverse control data formats, integrating them into a unified reporting layer. Using automated dashboard workflows, we eliminate manual reporting bottlenecks and siloed views.</p>
      <p>Through <strong>real-time visualization of security controls &amp; their effectiveness</strong> we provide clear visibility into the <strong>return on your investments.</strong></p>
    </article>
    <article class="card">
      {img("data-warehouse-lake", "Data warehousing and data lake architecture with pipelines and storage", lazy=False)}
      <h2 style="font-size:1.45rem">Data Warehousing / Data Lake Services</h2>
      <ul>
        <li><strong>Unified Architecture:</strong> Build a single source of truth by integrating fragmented data from all enterprise systems.</li>
        <li><strong>High-Speed Pipelines:</strong> Deploy secure ETL/ELT workflows to process massive, diverse datasets with ease.</li>
        <li><strong>Hybrid Storage:</strong> Combine structured warehouses for BI with scalable lakes for ML and data exploration.</li>
        <li><strong>Predictive Readiness:</strong> Establish the core foundation for real-time analytics and advanced AI innovation.</li>
      </ul>
      <div class="actions"><a class="btn ghost" href="{APPROACH_PDF}" target="_blank" rel="noopener">Download Approach</a></div>
    </article>
  </div>
</section>

<section class="section alt">
  <div class="wrap">
    <div class="split">
      <div class="media">{img("procurement-analytics", "Procurement analytics: transforming supplier assessment from manual and biased to data-driven")}</div>
      <div>
        <h2>Procurement Analytics</h2>
        <p>Our Procurement Analytics solution transforms conventional supplier assessments into a data-driven, objective process. By integrating end-to-end performance visibility—from KPI design to intuitive dashboards—we eliminate manual bottlenecks and bias.</p>
        <p>We empower organizations to optimize procurement strategies, negotiate better terms, and identify actionable improvements, ultimately fostering sustainable growth through comprehensive, real-time insights into your entire supplier ecosystem.</p>
      </div>
    </div>
    <div class="split reverse">
      <div class="media">{img("dash-revenue-b", "Financial dashboard showing revenue, gross profit, operating profit and net profit trends", 1737, 818)}</div>
      <div>
        <h2>CFO Analytics</h2>
        <p>Our CFO analytics solutions empower leadership to drive bottom-line growth through fact-based, cross-functional insights. We translate complex revenue and cost data into actionable intelligence, covering everything from profitability and liquidity to risk management.</p>
        <p>By providing granular, global-to-local visibility, we enable finance teams to optimize margins, streamline operations, and make strategic decisions with precision and speed.</p>
        <div class="actions"><a class="btn" href="/manufacturing-from-factory-floor-to-pandl">View Demo Dashboard</a></div>
      </div>
    </div>
  </div>
</section>
"""

STAFFING = f"""
<section class="page-head"><div class="wrap">
  <p class="eyebrow">What We Bring To The Table</p>
  <h1>Staffing Solutions</h1>
  <p>Simplifying your hiring journey with specialist data, analytics and technology talent.</p>
</div></section>

<section class="section">
  <div class="wrap">
    <div class="split">
      <div class="media">{img("project-staffing", "Project-based staffing: tailored talent for focused results", lazy=False)}</div>
      <div>
        <h2>Project Based Staffing</h2>
        <p>Assemble specialized teams tailored to your specific project milestones and deliverables. From initial scope to final launch, we provide the expertise needed to drive your most critical initiatives to completion.</p>
      </div>
    </div>
    <div class="split reverse">
      <div class="media">{img("talent-on-demand", "Talent on-demand staffing: professionals collaborating in an office")}</div>
      <div>
        <h2>Talent On-Demand Staffing</h2>
        <p>Scale your workforce instantly with pre-vetted professionals ready to hit the ground running. Bridge skill gaps and manage fluctuating workloads with flexible, high-caliber talent that integrates seamlessly into your team.</p>
      </div>
    </div>
    <div class="split">
      <div class="media">{img("offshore-staffing", "Offshore and staffing management across global talent pools")}</div>
      <div>
        <h2>Offshore &amp; Staffing Management</h2>
        <p>Access global talent pools to reduce operational costs without sacrificing quality or oversight. We handle the recruitment, logistics, and day-to-day management, so you can focus on scaling your business globally.</p>
        <div class="actions"><a class="btn" href="/get-in-touch">Talk to us about your team</a></div>
      </div>
    </div>
  </div>
</section>
"""

ABOUT = f"""
<section class="page-head"><div class="wrap">
  <h1>About SyncSense</h1>
  <p>Enterprise-grade technology and reporting capabilities, at lower cost and faster time to market.</p>
</div></section>

<section class="section">
  <div class="wrap prose">
    <p>SyncSense is founded by professionals with experience at organizations such as SAS, Oracle, Deloitte, BDO, and leading analytics firms, with a shared goal of bringing enterprise-grade technology and reporting capabilities to businesses at lower cost and faster time to market.</p>
    {img("syncsense-services", "Our experience and expertise: technology consulting, analytics and data strategy", 1165, 436)}
    <h2>What We Believe</h2>
    <p>Reporting should not be a monthly pain-point or a black box. Our philosophy is to make insights accessible, explainable, and owned by business users, while still maintaining strong data governance.</p>
    <p>We blend functional understanding of finance and risk with implementation experience on modern data and BI platforms so that solutions are both technically sound and practically useful.</p>
    <h2>Where We Operate</h2>
    <p>Headquartered in Mumbai, we serve clients across India, the Middle East, Africa, and the UK, with a mix of onsite and remote delivery models.</p>
    <p>Typical clients include financial services groups, insurers, technology and SaaS companies, and professional services firms building or scaling analytics and reporting capabilities.</p>
    <h2>Our Location</h2>
    <p><strong>Address</strong><br>Interface, Mumbai, India</p>
    <div class="actions"><a class="btn" href="/get-in-touch">Get in Touch</a><a class="btn ghost" href="/testimonials">Client Stories</a></div>
  </div>
</section>
"""

CONTACT = f"""
<section class="page-head"><div class="wrap">
  <h1>Get in Touch</h1>
  <p>Contact SyncSense for expert technology consulting and analytics services. We're here to accelerate your digital transformation journey.</p>
</div></section>
{contact_block("Get In Touch page", intro=False)}
"""

TESTIMONIALS = f"""
<section class="page-head"><div class="wrap">
  <h1>Testimonials</h1>
  <p>How we've helped finance, security and professional services teams.</p>
</div></section>

<section class="section">
  <div class="wrap grid-2">
    <figure class="quote">
      <h3>India based Cyber Security Company</h3>
      <p>SyncSense partnered with a multi-entity finance team to automate Tally data extraction across numerous companies, streamlining the consolidation process. We built a centralized data warehouse in MS SQL Server, enabling unified, accurate financial data storage. Leveraging Power BI, we delivered consolidated and comparative dashboards for cashflow, inventory, receivables, payables, and P&amp;L, empowering stakeholders with real-time, cross-company financial insights.</p>
    </figure>
    <figure class="quote">
      <h3>India based Financial and Investment firm</h3>
      <p>SyncSense supported an India-based Chartered Accountancy firm by providing skilled Power BI professionals through our technical staffing services. Our experts quickly integrated with the firm’s team, developing tailored dashboards and reports to enhance financial and operational visibility. The engagement accelerated analytics delivery, improved decision-making, and freed up internal resources for higher-value client work.</p>
    </figure>
  </div>
</section>
{contact_block("Testimonials page")}
"""

BLOG = """
<section class="page-head"><div class="wrap">
  <h1>Blog</h1>
  <p>Insights on reporting, analytics, data platforms and AI. New articles are on the way.</p>
</div></section>
<section class="section">
  <div class="wrap prose" style="text-align:center">
    <p>There are no articles yet. In the meantime, explore our <a href="/ai-and-llm-use-cases">AI use case gallery</a> or the <a href="/manufacturing-from-factory-floor-to-pandl">manufacturing analytics demo</a>.</p>
  </div>
</section>
"""

AI_CASES = f"""
<section class="page-head"><div class="wrap">
  <h1>AI Automation Use Case Gallery</h1>
  <p>Custom-engineered LLM skills that take real work off your team's plate.</p>
</div></section>

<section class="section">
  <div class="wrap prose">
    {img("contract-review-ai", "AI-powered contract review and analysis workflow, from ingestion to risk dashboard", lazy=False, cls="media-img")}
    <h2>Use Case: AI-Powered Contract Review &amp; Analysis</h2>
    <p class="lead">From Manual Paperwork to Strategic Insights in Seconds</p>

    <h3>The Challenge</h3>
    <p>Legal and procurement teams are often buried under a mountain of contracts, spending hours manually flagging indemnity clauses, tracking expiration dates, and extracting key data into spreadsheets. This "manual grind" leads to human error, missed deadlines, and high operational costs.</p>

    <h3>Our AI Solution</h3>
    <p>We engineer custom functional skills for LLMs (like Claude or GPT) to act as an <strong>Advanced AI Review Engine</strong>. This isn't just a search tool; it is a specialized analyst capable of semantic understanding.</p>

    <h3>The Intelligent Workflow</h3>
    <ul>
      <li><strong>Digital Ingestion Pipeline:</strong> Instantly upload batches of contracts in any format (PDF, Word, Scans).</li>
      <li><strong>Deep Clause Analysis:</strong> The AI identifies and interprets complex clauses like Liability, Indemnification, and Termination with near-perfect accuracy.</li>
      <li><strong>Automated Tracking:</strong> Key dates and renewal deadlines are extracted and automatically synced to your alerts or calendars.</li>
      <li><strong>Risk Scoring &amp; Flags:</strong> A centralized dashboard instantly highlights high-risk terms and compliance gaps, allowing your team to prioritize where their expertise is needed most.</li>
    </ul>

    <h3>Business Impact</h3>
    <ul>
      <li><strong>85% Reduction in Review Time:</strong> Scale your legal review capacity without increasing headcount.</li>
      <li><strong>Elimination of Human Error:</strong> Consistent analysis across thousands of documents.</li>
      <li><strong>Strategic Re-focus:</strong> Your legal experts stop doing data entry and start focusing on high-stakes negotiation and complex interpretation.</li>
    </ul>
    <div class="actions"><a class="btn" href="/get-in-touch">Discuss your use case</a><a class="btn ghost" href="{APPROACH_PDF}" target="_blank" rel="noopener">Download Approach</a></div>
  </div>
</section>
"""


def dash(name, alt, w, h, title, objective, capability, questions):
    qs = "".join(f"<li>{q}</li>" for q in questions)
    return f"""
    <article class="dash">
      {img(name, alt, w, h)}
      <h2>{title}</h2>
      <p><strong>Objective:</strong> {objective}</p>
      <p><strong>Analytical Capability:</strong> {capability}</p>
      <p><strong>Key Questions Answered:</strong></p>
      <ul>{qs}</ul>
    </article>"""


MANUFACTURING = f"""
<section class="page-head"><div class="wrap">
  <h1>End-to-End Manufacturing Visibility: From Factory Floor to P&amp;L</h1>
  <p>Effective financial planning requires more than just high-level summaries. Below is a demonstration of our deep-dive analytics framework designed for the manufacturing sector. By integrating production data with financial reporting, we provide a unified view of your business health—tracking variable costs, analyzing overhead allocation, and pinpointing the exact drivers of revenue growth across all product lines and sales channels.</p>
</div></section>

<section class="section">
  <div class="wrap prose" style="max-width:1000px">
    {dash("dash-revenue-b", "Executive overview dashboard: total revenue, gross profit, operating profit, net profit and monthly revenue and cost trends", 1737, 818,
          "1. Executive Performance Overview",
          "To provide an at-a-glance health check of the organization’s top-line and bottom-line performance against prior periods.",
          "This view demonstrates high-level variance analysis. It aggregates complex transactional data into clear, actionable KPIs, allowing leadership to instantly assess whether the company is growing (Green) or contracting, and visualizes the correlation between revenue trends and cost fluctuations over the fiscal year.",
          ["Are we hitting our growth targets YoY?", "Is our Net Profit growing at the same pace as Revenue?", "What are the macro trends for Revenue vs. Total Cost month-over-month?"])}
    {dash("dash-revenue-a", "Revenue segmentation dashboard: revenue by product category and sales channel, growth rates and profitability", 1736, 863,
          "2. Revenue &amp; Profitability Segmentation",
          "To dissect revenue streams and identify the most profitable segments across products and sales channels.",
          "This dashboard showcases segmentation and margin analysis. By breaking down revenue by Product Category (e.g., E-Bikes vs. Accessories) and Sales Channel (e.g., Online vs. Retail), we uncover where the \"quality revenue\" comes from. It highlights not just volume, but profitability, helping strategists pivot resources toward high-margin areas like Online Sales and Premium E-Bikes.",
          ["Which product lines are driving the fastest YoY growth?", "Which sales channel offers the highest Gross Profit margin?", "How does the cost structure differ across product lines?"])}
    {dash("dash-cost-overhead", "Cost and overhead dashboard: cost per unit, fixed vs variable costs, overhead by department and contribution margin", 1737, 859,
          "3. Cost &amp; Overhead Analysis",
          "To analyze production efficiency, manage overheads, and understand unit economics.",
          "This view demonstrates cost accounting and operational intelligence. It digs into the \"Cost of Goods Sold\" to separate Fixed vs. Variable costs and tracks the \"Cost per Unit\" over time. This level of granularity is essential for manufacturing clients to identify supply chain inefficiencies, seasonal cost spikes, or production bottlenecks that are eroding margins.",
          ["Is the Cost per Unit stabilizing or increasing?", "Which departments are consuming the most overhead allocation?", "Which specific products have the healthiest Contribution Margin after variable costs?"])}
    {dash("dash-profit-loss", "Profit and loss dashboard: P&amp;L waterfall from revenue to net profit with detailed metrics and cost breakdown tables", 1740, 802,
          "4. Profit &amp; Loss Statement Analysis",
          "To explain the journey from Revenue to Net Profit through a detailed statement analysis.",
          "This dashboard focuses on financial transparency and variance explanation. Using a waterfall chart, it visualizes exactly how costs (COGS, Taxes, Operating Expenses) reduce topline revenue. The accompanying detailed tables offer a forensic view of line items (like Direct Labor, Raw Materials, and Depreciation), allowing finance teams to pinpoint exactly which expense lines are deviating from the budget or prior year.",
          ["What are the primary drivers reducing our Gross Profit to Net Profit?", "How have specific expense line items (e.g., Maintenance, Packaging) changed YoY?", "What is the efficiency ratio of our Labor and Raw Materials relative to Revenue?"])}
  </div>
</section>

<section class="section alt" id="contact">
  <div class="wrap" style="max-width:820px">
    <div class="notice ok" data-status="sent" hidden>Thank you, your message has been sent. We'll be in touch soon.</div>
    <div class="notice err" data-status="error" hidden>Sorry, your message could not be sent. Please email us at <a href="mailto:{EMAIL}">{EMAIL}</a>.</div>
    {contact_form("Manufacturing demo page", full=True, heading="Get in touch")}
  </div>
</section>
"""

NOT_FOUND = """
<section class="page-head"><div class="wrap">
  <h1>Page not found</h1>
  <p>The page you were looking for doesn't exist or has moved.</p>
</div></section>
<section class="section"><div class="wrap" style="text-align:center">
  <div class="actions" style="justify-content:center"><a class="btn" href="/">Go to the home page</a><a class="btn ghost" href="/get-in-touch">Contact us</a></div>
</div></section>
"""

PAGES = [
    # path, nav key, title, description, body
    ("", "home", "SyncSense - Technology & Analytics Consulting Redefined",
     "SyncSense is a technology consulting firm in Mumbai, specializing in analytics services, digital transformation, and generative AI solutions. We provide expert staffing and seamless BI integration to drive actionable insights.", HOME),
    ("reporting-services", "reporting", "Reporting Services | SyncSense",
     "Management reporting and analytics, InfoSec analytics, data warehousing, procurement and CFO analytics from SyncSense.", REPORTING),
    ("staffing-solutions", "staffing", "Staffing Solutions | SyncSense",
     "Project-based staffing, talent on-demand and offshore staffing management for data, analytics and technology teams.", STAFFING),
    ("about", "about", "About | SyncSense",
     "SyncSense brings enterprise-grade technology and reporting capabilities to businesses at lower cost and faster time to market. Headquartered in Mumbai.", ABOUT),
    ("get-in-touch", "contact", "Get in Touch | SyncSense",
     "Contact SyncSense for expert technology consulting and analytics services. Call +91 9136433008 or email sales@syncsense.in.", CONTACT),
    ("testimonials", "testimonials", "Testimonials | SyncSense",
     "Client stories: Power BI dashboards, data warehousing and analytics staffing delivered by SyncSense.", TESTIMONIALS),
    ("blog-list", "blog", "Blog | SyncSense",
     "Insights on reporting, analytics, data platforms and AI from SyncSense.", BLOG),
    ("ai-and-llm-use-cases", "home", "AI Automation Use Case Gallery | SyncSense",
     "AI-powered contract review and analysis: custom LLM skills that cut review time by 85%.", AI_CASES),
    ("manufacturing-from-factory-floor-to-pandl", "reporting", "Manufacturing Analytics: From Factory Floor to P&L | SyncSense",
     "Demo of SyncSense's manufacturing analytics framework: executive overview, revenue segmentation, cost and overhead, and P&L analysis dashboards.", MANUFACTURING),
]

STATUS_JS = """<script>
(function(){var s=new URLSearchParams(location.search).get('status');if(!s)return;
document.querySelectorAll('[data-status="'+s+'"]').forEach(function(e){e.hidden=false;e.scrollIntoView({block:'center'});});})();
</script>"""


def layout(path, active, title, description, body, noindex=False):
    url = f"{SITE}/{path}" if path else f"{SITE}/"
    esc = lambda s: s.replace("&", "&amp;").replace('"', "&quot;")
    robots = '<meta name="robots" content="noindex">\n' if noindex else ""
    year = date.today().year
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{esc(title)}</title>
<meta name="description" content="{esc(description)}">
{robots}<link rel="canonical" href="{url}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="SyncSense">
<meta property="og:title" content="{esc(title)}">
<meta property="og:description" content="{esc(description)}">
<meta property="og:url" content="{url}">
<meta property="og:image" content="{SITE}/assets/img/free-assessment.webp">
<meta name="theme-color" content="#0b1166">
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="apple-touch-icon" href="/assets/img/apple-touch-icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600&family=PT+Sans+Caption:wght@400;700&display=swap">
<link rel="stylesheet" href="/assets/styles.css?v={STYLE_VERSION}">
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<p class="banner">{TAGLINE}</p>
<header class="site-header">
  <div class="wrap">
    <a class="logo" href="/" aria-label="SyncSense home">{img("logo", "SyncSense", 240, 240, lazy=False)}</a>
    <input class="nav-toggle" type="checkbox" id="nav-toggle" aria-label="Open menu">
    <label class="nav-toggle-label" for="nav-toggle"><span></span></label>
    <nav class="main-nav" aria-label="Main"><ul>{nav_html(active)}</ul></nav>
  </div>
</header>
<main id="main">
{body}
</main>
<footer class="site-footer">
  <div class="wrap">
    <div class="footer-grid">
      <div class="footer-brand">
        {img("logo", "SyncSense", 240, 240)}
        <p>{TAGLINE}. Technology consulting, analytics and staffing from Mumbai, serving India, the Middle East, Africa and the UK.</p>
      </div>
      <div>
        <h2>Explore</h2>
        <ul>
          <li><a href="/reporting-services">Reporting Services</a></li>
          <li><a href="/staffing-solutions">Staffing Solutions</a></li>
          <li><a href="/ai-and-llm-use-cases">AI Use Cases</a></li>
          <li><a href="/about">About</a></li>
          <li><a href="/testimonials">Testimonials</a></li>
        </ul>
      </div>
      <div>
        <h2>Contact</h2>
        <ul>
          <li><a href="tel:{PHONE_LINK}">{PHONE}</a></li>
          <li><a href="mailto:{EMAIL}">{EMAIL}</a></li>
          <li>Interface, Mumbai, India</li>
          <li><a href="/get-in-touch">Send us a message</a></li>
        </ul>
      </div>
    </div>
    <p class="copyright">© {year} SyncSense. All rights reserved.</p>
  </div>
</footer>
{STATUS_JS}
</body>
</html>
"""


STYLE_VERSION = ""


def main():
    global STYLE_VERSION
    import hashlib

    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir()
    shutil.copytree(ROOT / "assets", OUT / "assets")
    css = (SRC / "styles.css").read_bytes()
    (OUT / "assets" / "styles.css").write_bytes(css)
    STYLE_VERSION = hashlib.sha1(css).hexdigest()[:8]
    for name in ("favicon.ico", ".htaccess", "contact.php", "robots.txt"):
        shutil.copy2(SRC / name, OUT / name)

    for path, active, title, desc, body in PAGES:
        dest = OUT / f"{path}.html" if path else OUT / "index.html"
        dest.write_text(layout(path, active, title, desc, body), encoding="utf-8")
    (OUT / "404.html").write_text(
        layout("404", "", "Page not found | SyncSense", "Page not found.", NOT_FOUND, noindex=True),
        encoding="utf-8",
    )

    urls = "".join(f"  <url><loc>{SITE}/{p}</loc></url>\n" for p, *_ in PAGES)
    (OUT / "sitemap.xml").write_text(
        f'<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n{urls}</urlset>\n'
    )
    files = sum(1 for f in OUT.rglob("*") if f.is_file())
    print(f"Built {len(PAGES) + 1} pages, {files} files -> {OUT}")


if __name__ == "__main__":
    main()
