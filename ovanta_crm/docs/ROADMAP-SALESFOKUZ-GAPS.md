# Gap analysis: Ovantaa CRM vs Salesfokuz, and the plan to close the gaps

*Prepared 2026-11-24 against Ovantaa CRM 1.27.1 and the public Salesfokuz website (salesfokuz.com: home, all 11 product pages, pricing, FAQ, the Zoho comparison page, three case studies).*

## 1. What Salesfokuz is

Salesfokuz (Trinitymascot Consultancy Services, Kochi, since 2015) sells a **mobile-first sales-team CRM for Indian SMBs**. Every product is the same core: a web dashboard for managers plus an Android/iOS app for field executives. It is sold in industry editions:

| Edition | For | Edition-specific features |
|---|---|---|
| Leadfokuz | Lead management (generic) | Facebook lead integration, nearest-executive lead assignment, targets & rewards, product demo library, expense claims |
| Fastfokuz | FMCG distribution | Personal Journey Plan (PJP), routes, distributor/retailer management, stock, dispatch, competitor data capture, complaints, feedback |
| Factfokuz / Textilefokuz | Manufacturing / textile dealers | Dealer visits, orders and dispersals, product returns, product variants, ledger, nearby shops, cheque-photo collections |
| Vanfokuz | Van sales | Punch-in with live location every 15 min, route management, shop visits, sale list, collections |
| Realfokuz | Real estate | Online/offline inquiries, property inventory with a live *Available / Sold / Blocked* chart |
| Bankfokuz | BFSI / NBFC | Teams, beat plans, cross-sell view, product/campaign documents, EMI calculator |
| Servicefokuz | After-sales service | Complaint registration and distribution to the nearest technician, visit punch-in, photo proof, re-visit scheduling, recurring-issue report |
| Pharmafokuz | Healthcare | Clinic/doctor visits, X-ray and voice-note upload, warranty QR scan, push reminders |
| Labfokuz | Clinical labs | Patient booking, technician punch-in, sample collection, barcode mapping |
| Dealers App | Dealers | Dealers place their own orders and track *Pending → Approved → Dispatched → Delivered* |

**Every plan includes:** dashboard, user management, attendance, location tracking, **battery monitor**, leaves, expenses, targets, messages, "Master" (lookup tables), MIS reports, iOS + Android apps, and support over WhatsApp, email and phone.

**Pricing (INR, billed annually, per user):** ₹7,500 (Leadfokuz) to ₹10,000 (FMCG/manufacturing), plus a one-time set-up and training fee of ₹15,000–25,000. They market this as "about ₹19.88 a day" and "50 % cheaper than other CRMs in India", with a 7-day free trial. Customisation is charged extra.

**What they stress:** real-time tracking and push notifications, industry fit, simple to use without training, free lifetime updates, and a "35,000+ users" claim. On their Zoho comparison page they also claim lead assignment and routing, rules-based lead scoring, web-to-lead, duplicate blocking, mass email, campaigns, Google Calendar and multi-currency.

## 2. Where Ovantaa already leads (keep and market these)

Salesfokuz either doesn't advertise these or only lists them as a checkbox:

- **Email marketing at depth:** segments, templates, merge tags, scheduling, multi-sender SMTP, open/click tracking, deliverability checks, copies in the Sent folder.
- **AI:** campaign copy written by Claude, and AI search.
- **Tax invoicing:** India GST by default (HSN/SAC, units), plus ZATCA/UAE/UK/US/Thailand regimes, credit and debit notes, QR codes, a customer invoice portal, payment receipts and reversals.
- **Collections:** receivables, automated reminders, and payment claims that an accountant confirms or rejects.
- **Forecasting:** a business-review report (MBR/QBR) with commit, best-case and projected scenarios against a target, plus permanent deal-stage history.
- **Customisation:** custom fields, form layouts, custom deal stages and probabilities, custom roles with own/all scope.
- **Security and operations:** two-factor login, revocable sessions, audit log, backups and restore, migrations.
- **Collaboration:** live presence and edit-conflict warnings, lead conversion, duplicate merge, Excel/CSV import, and in-app help.

**Positioning:** Ovantaa is the stronger *office* CRM (pipeline, marketing, billing), while Salesfokuz is the stronger *field* CRM (mobile, GPS, orders, attendance). Closing the field gap, and keeping the office strengths, gives a product Salesfokuz cannot match.

## 3. The gaps

Priority: **P1** means Salesfokuz customers expect it on day one. **P2** means it's expected in most editions. **P3** means it only matters for a vertical or is nice to have.

| # | Capability (Salesfokuz name) | Ovantaa today | Gap | Priority |
|---|---|---|---|---|
| G1 | **Mobile app** for executives (iOS + Android) | Responsive web layout only; no installable app, no offline use, no push | Full | P1 |
| G2 | **Attendance / punch-in-out** with location | None | Full | P1 |
| G3 | **Visit / meeting punch-in** at customer location, with outcome and photos | Activities (`note/call/email/meeting`) without location, time-on-site or photos | Large | P1 |
| G4 | **Live location tracking** and a manager map; distance travelled | None (no coordinates stored anywhere) | Full | P1 |
| G5 | **Beat plan / PJP / route management**, plus covered vs not-covered report | None | Full | P1 |
| G6 | **Nearby shops / customers**, and assigning leads to the nearest executive | Accounts have city/state only, with no coordinates | Full | P2 |
| G7 | **Battery monitor** (rep's phone battery and GPS status) | None | Full | P3 (native app only) |
| G8 | **Facebook lead integration**, web-to-lead, online/offline inquiry segregation | Contact `source` is free text; import only; no inbound capture | Large | P1 |
| G9 | **Lead assignment and routing** (rules, round-robin, nearest rep) | Manual owner; rules engine is on the existing roadmap (Phase 3) | Large | P1 |
| G10 | **Hot / warm / cold** deal and lead rating, rules-based lead scoring | Possible today with a custom field, but not built in, not scored, and not on the dashboard | Medium | P2 |
| G11 | **Follow-up reminders** with push notifications | Tasks with due dates; email on assign/update; overdue *count* only, no due-time reminders | Medium | P1 |
| G12 | **Targets & rewards** per executive and team (sales, visits, collections) and leaderboards | One optional target figure in the business-review report | Large | P1 |
| G13 | **Team management** (teams, reporting manager, team scope) | Roles with own/all scope; no teams or hierarchy | Large | P2 |
| G14 | **Expense management** (claims, receipt photos, approval) | None | Full | P1 |
| G15 | **Leave management** | None | Full | P2 |
| G16 | **Product management** (catalogue, variants, price, stock status, brochures) | None; invoice lines are free text (products and price books are on the roadmap's Phase 2) | Full | P1 |
| G17 | **Order management** (field order capture, approval, dispatch, delivered status) | Invoices only; no quotes or sales orders | Full | P1 |
| G18 | **Collections in the field** (cheque/UPI photo, by visit) | Payments and payment claims exist on the office side; no rep-side capture with a photo | Small | P1 |
| G19 | **Ledger** per dealer/customer | Receivables per invoice; no account statement view | Small | P2 |
| G20 | **Stock / inventory, dispatch, product returns** | Credit notes exist; no stock or returns flow | Large | P3 (distribution vertical) |
| G21 | **Dealer app / portal** for self-service ordering | Invoice portal link only | Large | P3 |
| G22 | **Complaint management** (registration, nearest technician, re-visit, photos, recurring issues) | Tasks have an "issue" status only | Full | P2 (service vertical) |
| G23 | **Documents / product demo library** for reps | Files are attached to records only; no shared library | Medium | P2 |
| G24 | **Messages** (team announcements, chat) | None (live updates exist internally) | Full | P3 |
| G25 | **Meetings management and Google Calendar** | None (`.ics` invites are on the roadmap's Phase 4) | Large | P2 |
| G26 | **MIS reports**: daily activity, attendance, visits, distance, target vs achievement, collections, expenses; scheduled email | Dashboard plus the business review; no field-activity reports, no scheduled digests | Large | P1 |
| G27 | **WhatsApp and calling**: WhatsApp support channel, click-to-chat, call logging | WhatsApp/SMS gateway hook for invoice reminders only; no click-to-call/chat, no call log | Medium | P1 |
| G28 | **Competitor data capture, feedback** (FMCG) | None (could be custom fields on visits) | Small | P3 |
| G29 | **Vertical packs**: property availability chart, EMI calculator, warranty QR scan, lab barcode | None | Per pack | P3 |
| G30 | **Multi-language** ("customised to the language of your country") | English only (Arabic only on invoices) | Large | P2 (Hindi first) |
| G31 | **SaaS go-to-market**: free trial, self sign-up, price calculator, multi-company hosting | Self-hosted, single company (a decision taken 2026-11-10) | Strategic | Decision needed |

**Not worth copying:** the FOKUZ video-conferencing app (use Google Meet/Zoom links), separate products per industry (use one product with industry templates, see Phase 8), and their "AI/ML/Blockchain/IoT" claims, which have no product feature behind them.

## 4. The plan

**How the phases are ordered:** mobile and field work come first, because that is what Salesfokuz is bought for. The existing roadmap's remaining phases are folded in where they belong: products and quotes (old Phase 2) move into Phase 4, the rules engine (old Phase 3) into Phases 3 and 6, and calendar/IMAP (old Phase 4) into Phase 7. The house rules from `ROADMAP-CRITICAL-GAPS.md` still apply to every phase: in-place migrations, a backup before migrating, new tests, the full suite green, help pages and screenshots updated, and few dependencies.

Estimates are for one developer and are rough.

### Phase 0: quick wins (about 1 week)
Small changes that close visible gaps immediately:
1. **Click-to-call and WhatsApp buttons** on contacts and accounts (`tel:` and `https://wa.me/<number>?text=`), each logging a `call`/`whatsapp` activity with an outcome prompt when the rep returns (G27). Add `whatsapp` to the activity types.
2. **Built-in lead rating** (`hot / warm / cold`) on contacts and deals: a badge on lists and the board, a dashboard filter, and a segment field (G10).
3. **Lead source picklist** with an online/offline group (Website, Facebook, IndiaMART, JustDial, Referral, Walk-in, Event…), plus a dashboard "Leads by source" tile (G8).
4. **Due-date reminders** for tasks: a choice of time on the task, a reminder email at that time, and a daily "due today and overdue" digest (G11, email now and push in Phase 1).
5. **Map link** on accounts (opens Google Maps or OpenStreetMap for the address).
6. **Leaderboard tile** on the dashboard: won value and deal count per owner this month (a first step to G12).

### Phase 1: mobile foundation as a PWA (3–4 weeks), closes G1 and supports everything after it
1. A **"Field" mobile UI** in the same SPA: a bottom tab bar (Today, Customers, Visit, Orders, Me), large touch targets, a quick-add sheet. It reuses the existing API and permissions.
2. An **installable PWA**: web manifest, icons and a service worker (no build step, in keeping with the current vanilla-JS approach).
3. **Offline mode**: cache the rep's own accounts, contacts, products and today's plan; keep an **outbox** queue for visits, activities, orders, expenses and photos that syncs when the phone is back online. Conflicts reuse the existing edit-conflict checks.
4. **Camera capture**: `<input capture>` for photos with client-side compression before upload, stored in the existing `files` table.
5. **Web Push notifications** (VAPID) for task reminders, lead assigned, order approved and expense approved, with a per-user on/off setting. Implement with `node:crypto`, or add the `web-push` package if that proves simpler (to be decided in the phase).
6. **Phone sign-in comfort**: "Remember this device" and an optional PIN unlock on top of the existing session/2FA model.

### Phase 2: field force (4–5 weeks), closes G2, G3, G4 (foreground part), G5 and G6
1. **Locations on records**: `lat`, `lng`, `geo_accuracy` and `geo_source` on accounts and contacts (and an address line and pincode if missing). These are captured on the first visit or picked on a map, and existing addresses can be geocoded in bulk if a geocoder is configured.
2. **Attendance**: punch in and out with GPS, time and an optional selfie, and a work-day status (present, half day, on leave, holiday). Admins set the office geofence and allowed hours. There is also an attendance register for managers.
3. **Visits**: check in at a customer (GPS distance from the stored location is shown and flagged if it's over a threshold), then check out with a purpose, outcome, next action, photos, notes and custom fields per visit type. Each visit creates an activity on the timeline, so office users see it.
4. **Beat plan / PJP**: named routes (ordered lists of accounts), a weekly or one-off plan per rep, and a "Today" list on mobile. Managers see a planned-vs-visited coverage report with missed shops.
5. **Manager map**: today's punch-ins, visits and the last known position of each rep, using Leaflet with OpenStreetMap tiles, or Google Maps if a key is configured.
6. **Nearby customers**: a "within N km of me" list on mobile, and "assign to nearest executive" (by last known position) for new leads.
7. **Privacy**: a location-consent screen, tracking *only while punched in*, data retention settings, and audit entries. India's DPDP Act 2023 needs notice and consent.

*Browser limit:* a PWA can only read location while the app is open. Continuous tracking "every 15 minutes", distance travelled and the battery monitor need the native wrapper in Phase 9.

### Phase 3: lead capture and distribution (2–3 weeks), closes G8 and G9 and finishes G10
1. **Web-to-lead**: a form builder that generates an embeddable HTML snippet with a public endpoint, honeypot, rate limit, optional CAPTCHA, field mapping, duplicate check and a thank-you redirect.
2. **Facebook / Instagram Lead Ads**: a Meta webhook (`leadgen`) with verify token and signature check, fetching the lead through the Graph API with a page access token saved in Settings. Form fields map to contact fields.
3. **Generic inbound API**: `POST /api/v1/leads` with per-integration API keys. This covers IndiaMART and JustDial (their push/pull APIs), Google Ads lead forms (webhook) and Zapier/Make.
4. **Assignment rules**: this is the first slice of the old Phase 3 rules engine, limited to the "lead created" trigger. Rules are by source, territory (state/city/pincode), product interest, round-robin within a team, or the nearest rep (Phase 2), with a fallback owner, a notification plus push, and SLA escalation if the lead isn't touched in X hours.
5. **Rules-based lead scoring**: points from field values and activity (an opened email, a visit, a reply) that set hot/warm/cold automatically. Manual override is kept.

### Phase 4: products, quotes, orders and field collections (4–5 weeks), closes G16, G17, G18 and G19
This was the old Phase 2 "products, price books, quotes → invoice drafts", widened to orders.
1. **Product catalogue**: SKU, name, category and sub-category, variants (size/colour), unit, HSN/SAC, GST rate, MRP and price, images and brochure file, and an active flag. CSV/xlsx import reuses the importer. Invoice lines can pick a product, which fills HSN, unit, price and tax.
2. **Price lists** per customer group or dealer tier, plus discount limits per role.
3. **Quotes → sales orders → invoices**: line items with taxes, PDF/print using the invoice renderer, emailed from the CRM, and an order status flow of *Draft → Pending approval → Approved → Dispatched → Delivered / Cancelled*, with an approval threshold. Then "Create invoice" from the order.
4. **Order taking on mobile**: a product picker with search, recent and favourite items, quantity steppers and an offline outbox.
5. **Field collections**: the rep records cash/cheque/UPI/NEFT against an invoice or on account, with a photo of the cheque or receipt. This becomes a `payment_claim` (the table already exists) for the accountant to confirm or reject.
6. **Account ledger / statement**: invoices, payments, credit notes and running balance, as a PDF and by email. Built on the receivables code.

### Phase 5: team performance, expenses and leaves (3–4 weeks), closes G12, G13, G14 and G15
1. **Teams and hierarchy**: teams, a reporting manager per user, and a new **"team" record scope** next to own/all in the permissions matrix. Managers see their team's records and approvals.
2. **Targets**: per user or team per month, quarter or year, on metrics such as won revenue, orders value, collections, new leads, visits and calls. Achievement is computed from live data. There's a **leaderboard**, simple rewards and badges, and target-vs-achievement on the dashboard and the business review.
3. **Expenses**: claims with category, amount, date, receipt photo, linked visit or day, and travel allowance per km (distance from visits, or a manual odometer). Then manager approval, then finance approval with a paid status, plus policy limits per category and an export for payroll or accounts.
4. **Leaves**: leave types and balances, apply and approve, a holiday calendar, and links to the attendance register.

### Phase 6: MIS reports and automation (3 weeks), closes G26 and the rest of the rules engine
1. **Field reports**: daily activity report (per rep: punch-in/out, visits, orders, collections, distance), attendance register, visit coverage vs beat plan, target vs achievement, collections, expenses, leads by source/owner/status, and conversion funnel. All support filters, CSV/xlsx export and saved views (re-using `report_views`).
2. **Scheduled report emails**: daily, weekly and monthly digests to managers and admins.
3. **Rules engine (old Phase 3)**: triggers × conditions × actions (set field, assign, create task, send email/WhatsApp, push notification, signed webhook, create invoice draft), approvals and stage gates, run log and loop protection.

### Phase 7: communication (3–4 weeks), closes G23, G24, G25 and finishes G27
1. **WhatsApp Business Cloud API** (optional; needs Meta business verification): approved template messages from contacts, deals and invoices, inbound replies logged to the timeline, and opt-in tracking. Click-to-chat from Phase 0 stays as the no-set-up option.
2. **Cloud telephony** (optional: Exotel, MyOperator or Knowlarity): click-to-call bridging, call logs and recordings attached to the contact through webhooks.
3. **Meetings and calendar (old Phase 4)**: meetings with attendees and `.ics` invites, reminders and push, then Google Calendar and Outlook sync (OAuth). IMAP email logging comes after that.
4. **Sales library**: shared folders of brochures, price lists, demo videos and training documents, available offline on mobile, with view tracking.
5. **Announcements**: admin or manager broadcasts to teams with read receipts. Full chat is out of scope.

### Phase 8: service desk and industry templates (4–6 weeks, can be split), closes G20–G22, G28 and G29
1. **Complaints / service tickets**: registration from web form, email, WhatsApp or manual entry, assigned to the nearest or area technician, then visit check-in, photo proof, resolved/unresolved, re-visit scheduling, SLA timers, a recurring-issue report, and warranty lookup by serial number or QR code.
2. **Industry templates**: one click applies preset custom fields, layouts, stages, visit types, report packs and demo data:
   - **Distribution / FMCG / manufacturing**: distributor → retailer hierarchy, simple stock per warehouse with a dispatch note, product returns linked to credit notes, competitor capture on visits, and dealer feedback.
   - **Real estate**: projects → units inventory with a colour-coded **Available / Blocked / Sold** board, unit hold expiry, and a booking that creates the deal.
   - **BFSI**: loan products, an EMI calculator widget on mobile, and cross-sell suggestions from product holdings.
   - **Healthcare / pharma**: doctor and clinic master, call frequency by doctor class, and sample tracking.
3. **Dealer portal**: extend the existing invoice portal into a dealer login with a catalogue and price list, order placement, order status, ledger and invoices.

### Phase 9: native wrapper and background tracking (3–4 weeks), closes G4 (background part) and G7
1. Wrap the Phase 1 PWA with **Capacitor**: Android first, iOS after.
2. **Background location** every N minutes *only while punched in*, with a route replay on the manager map, distance travelled feeding travel allowance, and alerts for GPS off or mock location.
3. A **battery and GPS status monitor**.
4. Optional Android **call-log sync**, which matches calls to contacts and logs them (with consent).
5. Play Store and App Store listing, push notifications through FCM/APNs, and over-the-air web updates.

### Phase 10: localisation and go-to-market (2–3 weeks, alongside other work), closes G30 and G31
1. **Internationalisation**: move UI strings into message files, then Hindi and one regional language (Malayalam, Tamil or Marathi) for the mobile UI first. Number, date and currency formats already come from settings.
2. **SaaS (decision needed)**: matching Salesfokuz's free trial and per-user pricing needs multi-company hosting. The 2026-11-10 decision was single company and self-hosted. Options: (a) stay self-hosted and sell installation plus a support contract; (b) run one instance per customer, with automated provisioning and backups; or (c) true multi-tenancy (tenant id on every table, a different database). Option (b) needs the least code.

## 5. Timeline at a glance

| Order | Phase | Weeks | Gaps closed |
|---|---|---|---|
| 1 | Phase 0: quick wins | 1 | G8 (part), G10 (part), G11 (email), G12 (part), G27 (part) |
| 2 | Phase 1: mobile PWA | 3–4 | G1 |
| 3 | Phase 2: field force | 4–5 | G2, G3, G4 (foreground), G5, G6 |
| 4 | Phase 3: lead capture and routing | 2–3 | G8, G9, G10 |
| 5 | Phase 4: products, orders, collections | 4–5 | G16, G17, G18, G19 |
| 6 | Phase 5: teams, targets, expenses, leaves | 3–4 | G12, G13, G14, G15 |
| 7 | Phase 6: MIS reports and automation | 3 | G26 |
| 8 | Phase 7: communication | 3–4 | G23, G24, G25, G27 |
| 9 | Phase 8: service and industry templates | 4–6 | G20, G21, G22, G28, G29 |
| 10 | Phase 9: native app | 3–4 | G4 (background), G7 |
| — | Phase 10: localisation and SaaS | 2–3 | G30, G31 |

That is about **32–42 developer-weeks** in total. After Phases 0–4 (about 14–18 weeks), Ovantaa matches the Salesfokuz Leadfokuz, Factfokuz and Vanfokuz editions on core features and exceeds them on pipeline, marketing and invoicing.

## 6. Decisions needed before starting

1. **Mobile approach**: PWA first, then a Capacitor wrapper (recommended, one codebase), or a native app from the start?
2. **Maps**: OpenStreetMap and Leaflet (free, no key), or Google Maps (better geocoding in India, needs a billing key)?
3. **First industry focus**: distribution/manufacturing (largest Salesfokuz segment, judging by their case studies and blog), real estate, or services?
4. **Inventory**: a simple built-in stock module, or integrate with Tally/Zoho Books and keep Ovantaa as the order front-end?
5. **WhatsApp**: click-to-chat only, or the Cloud API with templates (needs Meta business verification and per-message charges)?
6. **Hosting model** (G31): stay self-hosted, run one instance per customer, or go multi-tenant?
