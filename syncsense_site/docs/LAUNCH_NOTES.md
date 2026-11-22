# SyncSense website rebuild: launch notes

Preview: https://resolute-mediumturquoise-seahorse-79.hostingersite.com (www.syncsense.in is unchanged).

Generated alongside this file by `python3 build.py`:

- [`pages.md`](pages.md): every page with its title tag, meta description, H1 and target keyword.
- [`placeholders.md`](placeholders.md): every `[PROOF]`, `[PLACEHOLDER]` and `[CONFIRM]` still to fill. These are highlighted in yellow on the preview.
- [`redirects.md`](redirects.md): old URL → new URL map (301s).

## QA results (22 November 2026)

| Check | Result |
|---|---|
| Lighthouse mobile: Home, Text-to-SQL, Ontology Builder, Insurance | 100 / 100 / 100 / 100 on Performance, Accessibility, Best Practices and SEO. LCP 1.0–1.2 s, CLS 0, TBT 0–80 ms |
| Layout at 375, 768 and 1440 px | All 35 pages: no horizontal scroll, one H1 each |
| Links and anchors | No broken internal links or anchors |
| JSON-LD | Valid JSON on every page; Organization, ProfessionalService, SoftwareApplication, Service, FAQPage, BreadcrumbList, Article and Person types used |
| Copy rules | No banned words; no page with more than 2 em dashes; use cases labelled "Example scenario" |
| Forms | Valid submission emails sales@syncsense.in and redirects to /thank-you/; missing fields or an unknown industry return to the form with an error; honeypot sends nothing; header injection blocked |
| Redirects | All 9 old URLs return 301 to their new pages on the preview |

Not done from here: Google's Rich Results Test (needs a browser session). Run it after launch on Home, `/products/text-to-sql/`, `/use-cases/insurance/` and an Insights article. Real email delivery: the server accepts and sends the message, but whether it reaches the inbox depends on SPF/DKIM for syncsense.in. Send a test from the preview's contact form.

## Claims to confirm before launch

These come from your decks and the earlier website. They are published as given, and each is also marked in `placeholders.md` where relevant.

1. **Case studies from the AI Service Offerings deck** are published as SyncSense work, with client names withheld (confirmed).
2. **Client names removed**: Godrej Industries → "a large Indian consumer goods group"; K.A. Pandit → "an actuarial consulting firm in India".
3. **Security statements on the home page**, including "We do not use client data to train models".
4. **Team background**: "SAS, Oracle, Deloitte, BDO and leading analytics firms" (from the old About page) and "25+ years / 15+ years on SAS-based programmes" (from your brief).
5. **Alteryx** is listed under "Technologies we work with". Say whether it is a formal partnership.
6. **The old "85% reduction in review time" claim** on the contract review use case was removed because it could not be tied to a project.
7. **Privacy policy**: a DPDP Act draft for legal review.

## Off-site SEO checklist (tasks for you)

1. **Google Search Console**: verify `syncsense.in` as a domain property (DNS TXT record at your registrar), submit `https://www.syncsense.in/sitemap.xml`, request indexing for Home, the three product pages and the Use Cases hub.
2. **Bing Webmaster Tools**: import from Search Console, submit the sitemap. Bing also feeds ChatGPT search.
3. **Analytics**: add Google Analytics 4 or Plausible. Track `/thank-you/` page views as the conversion, and the "Book a demo" link clicks. Plausible needs no cookie banner; GA4 in India and for EU/UK visitors needs a consent banner. Update the privacy policy when added.
4. **Google Business Profile**: with no office, set it up as a service-area business (Mumbai and the areas you serve) with the address hidden. Name and phone must match the website exactly: "SyncSense", +91 9136433008.
5. **LinkedIn company page** (linkedin.com/company/data-syncsense): complete the About section with the website's positioning statement, add the website URL, logo and the three products as showcase content. Add your personal LinkedIn URL so the About page can link to it.
6. **Directories**:
   - For the products: G2, Capterra, Product Hunt (AskData is the strongest candidate for a Product Hunt launch).
   - For services: Clutch, GoodFirms.
   - Indian directories: IndiaMART, Justdial, NASSCOM member listing if applicable.
   - Use identical name, phone, email and description everywhere.
7. **Email deliverability** for the contact form: make sure syncsense.in has SPF, DKIM and DMARC records that allow Hostinger's mail servers to send as `no-reply@syncsense.in`.
8. **After launch**: run Google's Rich Results Test and PageSpeed Insights on the live domain, and check Search Console's Page indexing report after 2–3 weeks.

## Insights content plan

The first three articles are written and published. Outlines for the next three:

### 4. Text-to-SQL use cases in banking, insurance and telecom
- Answer first: where plain-English questions save the most time in each industry.
- Banking: overdue EMIs, exposure by customer, branch disbursement vs plan; branch-level access rules; masking account numbers.
- Insurance: claims ratio by product, claims open past 60 days, renewal rate; lineage for IFRS 17 / Ind AS 117.
- Telecom: double billing, churn by plan, tickets past SLA; linking charges to outages through an ontology.
- What to prepare: the top 20 questions per team, a read-only account, a data steward.
- Link to the actuarial case study and the three industry pages. CTA: demo.

### 5. Using knowledge graphs for tax and regulatory research
- Why keyword search and generic AI fail in tax: overruled rulings, superseded circulars, invented authorities.
- What the ontology captures: section, holding, circular, treaty article; overruled/followed/amended/superseded; 1961 ↔ 2025 Act mapping.
- GraphRAG explained with a worked example.
- Keeping client opinions inside the firm: private small language models.
- Release gates: zero fabricated citations, 85%+ authority recall.
- Link to the tax case study. CTA: assessment.

### 6. Data privacy for AI projects in India: DPDP Act basics
- What the DPDP Act 2023 covers, for whom, and key terms (data fiduciary, consent, data principal rights) in plain language.
- What changes for AI projects: purpose limitation, sending data to external AI services, cross-border transfer.
- Design patterns: send schema not rows, masking, row-level access, self-hosted models, audit logs.
- A checklist for a DPDP-aware AI pilot.
- Not legal advice; recommend legal review. CTA: demo (AskData privacy boundary).

## How the site is built

See `../README.md`.
