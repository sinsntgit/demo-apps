# Ovantaa CRM vs Zoho CRM vs HubSpot: the gaps

*Prepared 2026-11-24 against Ovantaa CRM 1.27.1 (checked in the code). Zoho and HubSpot details come from their public product pages and 2026 third-party pricing guides. Their own pricing pages couldn't be opened from this environment, so check tier placement and prices there before quoting them to a customer.*

Companion to [`ROADMAP-SALESFOKUZ-GAPS.md`](ROADMAP-SALESFOKUZ-GAPS.md), which covers the field-sales gaps (G1–G31: mobile, attendance, visits, beat plans, targets, expenses, orders). This document lists the **additional** gaps that Zoho and HubSpot expose (Z1–Z40) and points back to a G-number where a gap overlaps.

## 1. The three products in one line each

| | Ovantaa CRM | Zoho CRM | HubSpot (Sales Hub + Smart CRM) |
|---|---|---|---|
| What it is | Self-hosted, single-company sales CRM with email marketing and tax invoicing built in | Cloud CRM with deep customisation and automation, inside the 50-app Zoho suite (Books, Desk, Campaigns, Analytics…) | Cloud "customer platform": a free CRM plus paid Sales, Marketing, Service, Content, Data and Commerce hubs, with Breeze AI throughout |
| Hosting | Your server, a single SQLite file | Zoho cloud (an Indian data centre is available) | HubSpot cloud |
| Price (per user) | No licence fee (self-hosted) | Free up to 3 users; then ₹800 / ₹1,400 / ₹2,400 / ₹2,600 a month (Standard / Professional / Enterprise / Ultimate, billed annually, plus GST) | Free (limited); Starter about $15–20 a seat a month; Professional about $90–100 plus a $1,500 onboarding fee; Enterprise about $150 plus $3,500 onboarding. Marketing Hub is priced separately by number of contacts |
| Strongest at | GST/ZATCA invoicing, collections, campaign deliverability, MBR/QBR forecast, data ownership | Customisation (custom modules, Blueprint, Canvas, Deluge scripting), automation, price | Ease of use, inbound marketing, sequences and email tracking, AI agents, 1,500+ app marketplace |

## 2. Where Ovantaa is ahead or level

| Area | Ovantaa | Zoho | HubSpot |
|---|---|---|---|
| **India GST tax invoices** (HSN/SAC, units, QR code), credit/debit notes, ZATCA (Saudi) / UAE / UK / US regimes | Built in | Needs Zoho Books or Zoho Invoice (a separate app) | Commerce Hub invoices; no GST e-invoicing or ZATCA |
| **Collections**: receivables ageing, automatic reminders, customer payment claims that an accountant confirms | Built in | Zoho Books | Commerce Hub (payments in a few countries only) |
| **Email campaigns with deliverability checks** (SPF/DKIM/DMARC, sending through your own mailboxes, copies in Sent) | Included at no cost | Zoho Campaigns / Marketing Automation (paid add-on) | Marketing Hub, priced by contacts (expensive at scale) |
| **Business review (MBR/QBR) report** with worst / projected / best case against a target | Built in | Forecasts module (Professional+) | Forecasting (Professional+) |
| **Permanent deal-stage history** with time in stage, owner and comment | Yes | Stage history (yes) | Deal stage history properties (yes) |
| **Live presence and edit-conflict warnings** | Yes | Partial (record locking) | No |
| **Data ownership and running offline from the vendor**: backups, restore, no per-seat fee | Yes | No | No |
| Custom fields and layouts, custom roles, 2FA, audit log, duplicate merge, Excel import | Yes | Yes | Yes |
| AI copy for campaigns, plain-language AI search | Yes (Claude) | Zia | Breeze |

**Position:** for an Indian or Gulf company that wants invoicing and collections in the CRM, owns its data, and doesn't want per-seat fees, Ovantaa already has a story that neither Zoho CRM nor HubSpot offers in one product. The gaps below are what stop it from replacing them for a growing sales team.

## 3. The gaps

**Who has it:** **Z** = Zoho has it, **H** = HubSpot has it, with the tier where it starts (Free, Std = Standard, Pro = Professional, Ent = Enterprise). **Priority:** P1 means buyers comparing against Zoho or HubSpot reject a CRM without it; P2 means expected by mid-size teams; P3 means advanced or nice to have.

### 3.1 Email, calendar and calling (the biggest everyday gap)

| # | Capability | Zoho | HubSpot | Ovantaa today | Priority |
|---|---|---|---|---|---|
| Z1 | **Send a 1:1 email from a contact or deal**, with templates and merge fields, logged on the timeline | Std | Free | Not possible. Email only goes out as campaigns, invoices or task/notification mail | **P1** |
| Z2 | **Two-way inbox sync** (Gmail / Microsoft 365): replies and incoming mail matched to contacts | Std (IMAP/POP, plus Gmail/Outlook) | Free | No (IMAP logging is on the old roadmap's Phase 4) | **P1** |
| Z3 | **Open and click tracking on 1:1 emails**, with "they opened it" alerts | Std | Free | Campaigns only | P1 |
| Z4 | **Gmail / Outlook add-in**: see and log the CRM contact from the inbox | Std | Free | No | P2 |
| Z5 | **Calendar sync and meeting booking links** (the prospect picks a slot) | Std (calendar booking) | Free (meetings scheduler) | No (see G25) | **P1** |
| Z6 | **Built-in calling** (calling from the browser, recording, call logging) or telephony integrations | Std (PhoneBridge, telephony marketplace) | Free (limited minutes) to Ent | No (see G27) | P2 |
| Z7 | **WhatsApp and SMS** conversations on the record | Std (WhatsApp, SMS integrations) | Pro (WhatsApp in the inbox) | Invoice reminders through a gateway only (see G27) | P1 for India |
| Z8 | **Shared team inbox, live chat and chatbot on the website** | SalesIQ (add-on) | Free (live chat), Pro (bots) | No | P2 |

### 3.2 Sales process and automation

| # | Capability | Zoho | HubSpot | Ovantaa today | Priority |
|---|---|---|---|---|---|
| Z9 | **Workflow rules** (when X happens → update field, create task, send email, call a webhook) | Std (with limits), Pro | Pro | Email notification rules only (the rules engine is in old Phase 3 and Salesfokuz-plan Phase 6) | **P1** |
| Z10 | **Sequences / cadences**: timed multi-step email and task series that stop on a reply | Std (cadences) | Starter/Pro (sequences) | No | **P1** |
| Z11 | **Assignment rules and round-robin** for leads and deals | Std | Pro | No (see G9) | P1 |
| Z12 | **Lead scoring** (rules-based, then predictive) | Std (rules), Ent (multiple scoring rules, Zia) | Pro (rules), Ent (predictive) | No (see G10) | P1 |
| Z13 | **Guided sales process / stage gates**: required fields or steps before a stage can change (Zoho calls this Blueprint) | Pro/Ent (Blueprint) | Pro (pipeline rules, playbooks) | Stages have probabilities but no rules | P2 |
| Z14 | **Approval processes** (discount, quote, deal) | Pro | Ent (quote approvals) | No | P2 |
| Z15 | **Multiple pipelines** (e.g. new business, renewals, partners) | Std | Starter (several pipelines) | One pipeline with custom stages | **P1** |
| Z16 | **Playbooks / guided selling**: call scripts and qualification questions shown on the deal | Ent (guided selling) | Pro (playbooks) | No | P3 |
| Z17 | **Macros and bulk actions** across modules (update owner, stage, fields in bulk) | Std (macros, mass update) | Free/Pro | Bulk actions on contacts only | P2 |
| Z18 | **Customer journey orchestration** (CommandCenter) / marketing journeys | Ent | Marketing Hub Pro | No | P3 |

### 3.3 Records, products and data model

| # | Capability | Zoho | HubSpot | Ovantaa today | Priority |
|---|---|---|---|---|---|
| Z19 | **Products, price books, quotes** (PDF, e-signature, accept online) | Std/Pro (inventory modules, CPQ) | Free (quotes), Pro (e-signature, product library) | None; invoice lines are free text (see G16, G17) | **P1** |
| Z20 | **Sales orders, purchase orders, vendors** | Pro (inventory) | Commerce Hub (partial) | None (see G17) | P2 |
| Z21 | **Several contacts on a deal, with roles** (decision maker, influencer), and contacts linked to several companies | Std (contact roles) | Free (associations, labels) | One contact per deal | P2 |
| Z22 | **Custom modules / custom objects** (e.g. Projects, Vehicles, Properties) | Ent | Ent (custom objects) | Not planned (2026-11-10 decision: fields and layouts only) | P2 |
| Z23 | **Formula, roll-up, validation and conditional-layout rules** (show field B only if A = …) | Std–Pro | Pro (calculated properties, conditional logic) | Field types with validation only; no formulas or conditions | P2 |
| Z24 | **Field-change history** on every record, plus a **recycle bin** to restore deleted records | Std (audit, recycle bin) | Free (property history, 90-day restore) | Stage history only; the audit log records the action without old and new values; deletes are permanent | **P1** |
| Z25 | **Export of every module** (accounts, deals, tasks, activities) | Std | Free | Contacts CSV only | P1 |
| Z26 | **Data enrichment**: company and contact details filled in automatically from email or domain | Ent (Zia enrichment) | Free/Starter (Breeze Intelligence, credits) | No | P3 |
| Z27 | **Multi-currency**, more than two currencies, with daily rates | Std/Pro | Pro | Two currencies with yearly rates | P3 |
| Z28 | **Territory management** with territory-based forecasts and quotas | Ent | Ent (teams; partial) | No (see G13) | P2 |

### 3.4 Reporting and AI

| # | Capability | Zoho | HubSpot | Ovantaa today | Priority |
|---|---|---|---|---|---|
| Z29 | **Custom report builder** (any module, joins, grouping, chart types) and **custom dashboards** per user or team | Std (unlimited reports), Ult (Zoho Analytics) | Starter/Pro (custom report builder) | Fixed dashboard plus the business review; saved views of the business review | **P1** |
| Z30 | **Scheduled report emails** | Std | Pro | No (see G26) | P2 |
| Z31 | **Per-rep quotas and forecast roll-up by team or territory** | Pro/Ent (targets cascade territory → team → rep) | Pro (forecasting, goals) | One optional target per business review (see G12) | P1 |
| Z32 | **Predictive AI**: deal win probability, churn prediction, anomaly detection, best time to contact | Ent (Zia) | Ent (predictive scoring), Pro (deal insights) | No | P3 |
| Z33 | **AI assistant that acts**: summarise a record, draft a reply, update fields or create tasks on command, meeting notetaker, call and deal summaries, prospecting and customer agents | Ent/Ult (Zia generative and agentic) | Starter–Ent (Breeze Assistant, Prospecting, Data and Customer agents, notetaker) | AI campaign copy and AI search only | P2 |
| Z34 | **Conversation intelligence**: call recording, transcription, coaching | Ent (via telephony) | Pro | No | P3 |

### 3.5 Marketing, service and platform

| # | Capability | Zoho | HubSpot | Ovantaa today | Priority |
|---|---|---|---|---|---|
| Z35 | **Web forms, landing pages, website visitor tracking** | Std (webforms), Zoho PageSense/Sites | Free (forms, landing pages, tracking code) | No (see G8) | **P1** |
| Z36 | **Help desk tickets, knowledge base, customer portal, CSAT/NPS surveys** | Zoho Desk (separate app), Ent (portals) | Service Hub (tickets free, help desk Pro) | Invoice portal only (see G22) | P2 |
| Z37 | **Public REST API with API keys or OAuth, outbound webhooks** | All paid | Free (private apps), webhooks Pro | Browser-session API only; no keys, tokens or outbound webhooks (apart from the invoice provider) | **P1** |
| Z38 | **App marketplace and Zapier/Make connectors**; low-code scripting (Deluge, custom-code workflow steps) | 1,000+ extensions, Deluge | 1,500+ apps, custom code (Ops Hub Pro) | None | P2 |
| Z39 | **Native mobile apps** (offline, business-card scanner, check-in, nearby customers) | Free | Free | Responsive web only (see G1–G6) | P1 |
| Z40 | **Enterprise admin**: SSO (SAML/OIDC), field-level permissions, record sharing rules and role hierarchy, IP restrictions, sandbox, data-privacy tools (consent, export or erase on request), UI in many languages | Pro–Ent (SAML, field-level security, sandbox, roughly 28 languages) | Pro–Ent (SSO, field-level permissions, sandbox, GDPR tools) | 2FA, custom roles with own/all scope, audit log. No SSO, field-level permissions, sharing rules, sandbox, privacy tools, or UI languages beyond English (see G13, G30) | P2 |

## 4. What this means: the top 10 to close first

Ranked by how often they'd decide a comparison against Zoho or HubSpot, and how cheaply they build on what exists:

1. **Z1 + Z3: 1:1 email from records with tracking.** The SMTP senders, templates, merge tags and open/click tracking already exist for campaigns, so this mostly reuses them. About 1–2 weeks.
2. **Z24 + Z25: field history, recycle bin, export everything.** These are trust features evaluators check on day one. The audit log and CSV export are already there to extend. About 1 week.
3. **Z15: multiple pipelines.** Stages are already customisable; this adds a `pipeline_id` to stages and deals, plus a pipeline switcher on the board and reports. About 1 week.
4. **Z37: public API keys and outbound webhooks.** Unlocks Zapier/Make, website forms and the integrations in the Salesfokuz plan's Phase 3. Route permissions already cover every endpoint. About 1–2 weeks.
5. **Z35: web-to-lead forms** (same as G8). About 1 week.
6. **Z9 + Z11 + Z12: workflow rules, assignment rules and lead scoring.** This is the rules engine already planned; move it earlier. About 3–4 weeks.
7. **Z10: sequences.** Built on Z1 and the rules engine, with campaign scheduling reused. About 2 weeks.
8. **Z19: products and quotes** (G16/G17). Feeds the existing invoicing. About 3 weeks.
9. **Z29 + Z30 + Z31: custom report builder, scheduled emails, per-rep quotas.** About 3–4 weeks.
10. **Z2 + Z5: inbox and calendar sync with booking links.** Gmail and Microsoft OAuth is the least predictable item, so start with IMAP and `.ics`. About 3–4 weeks.

Items 1–5 are quick and close the most embarrassing gaps in a demo (about 5–7 developer-weeks). Items 6–10 overlap with the Salesfokuz plan (Phases 3, 4, 6 and 7), so the combined roadmap should put **Z1, Z24, Z25, Z15 and Z37 into Phase 0 or 1** and keep the rest in their phases.

**Not worth chasing now:** custom objects (Z22, against the 2026-11-10 decision), predictive AI (Z32, needs data volume), conversation intelligence (Z34), journey orchestration (Z18) and a marketplace (Z38). Webhooks and an API (Z37) give most of the integration value at a fraction of the cost.

## 5. Decisions needed

1. **Pull the five quick wins (Z1, Z24, Z25, Z15, Z37) ahead of the mobile work?** Recommended: yes. They're about 5–7 weeks and remove the most common objections in a Zoho/HubSpot comparison.
2. **Email sync:** IMAP first (works with any mailbox), or Gmail/Microsoft OAuth directly (better experience, needs Google and Microsoft app verification)?
3. **Custom objects:** keep the "fields and layouts only" decision, or reopen it? Real-estate properties or service assets would be the first use.
4. **AI:** extend the Claude integration into an assistant that summarises records and drafts replies (Z33, cheap with the existing API key setting), or wait?

## Sources

- Zoho CRM India pricing (2026): [Maxwize](https://maxwize.in/blog/zoho-crm-pricing-india), [Devmixa](https://devmixa.com/software/zoho-crm/), [Salesfresh](https://www.salesfresh.com/blog/zoho-crm-pricing-india), [Tatva CRM](https://tatvacrm.com/resources/zoho-crm-pricing-india)
- Zoho CRM editions and features: [Zoho edition and role guide](https://help.zoho.com/portal/en/kb/crm/getting-started/articles/choose-your-path-edition-and-role-guide), [Zoho edition comparison](https://www.zoho.com/crm/comparison.html), [ZoomInfo: Zoho CRM features 2026](https://pipeline.zoominfo.com/sales/zoho-crm-features), [Zoho blog: Blueprint](https://www.zoho.com/blog/crm/sell-smarter-better-faster.html)
- HubSpot pricing (2026): [Sybill](https://www.sybill.ai/blogs/hubspot-sales-hub-pricing), [Trellus](https://www.trellus.ai/post/hubspot-sales-hub-pricing), [SpotSaaS](https://www.spotsaas.com/blog/hubspot-pricing), [Markaicode](https://markaicode.com/pricing/hubspot-crm-pricing/)
- HubSpot features and AI: [HubSpot free CRM](https://hubspot.com/products/crm/free), [HubSpot Fall 2026 spotlight](https://www.hubspot.com/company-news/fall-26-spotlight), [HubSpot Spring 2026 spotlight](https://www.hubspot.com/company-news/spring-2026-spotlight), [ZoomInfo: HubSpot features 2026](https://pipeline.zoominfo.com/sales/hubspot-features), [MarTech: HubSpot rebuilds around AI agents](https://martech.org/hubspot-rebuilds-its-platform-around-ai-agents/)
