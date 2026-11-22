# SEO audit: SyncSense website (22 November 2026)

Scope: the rebuilt site (39 pages) on the preview domain, before launch on www.syncsense.in. There is no Search Console data yet, so this covers technical, on-page and content factors, not rankings or traffic.

## Summary

The technical foundation is strong: static HTML, Lighthouse 100 on mobile, unique titles and descriptions, a self-referencing canonical on every page, structured data, sitemap, robots.txt, llms.txt, and 301 redirects from every old Website Builder URL. The main gaps are launch-related (the new site is not on syncsense.in yet), thin case studies, a very light home page, and little off-site authority.

## Fixed in this audit

| Issue | Impact | Fix |
|---|---|---|
| Preview domain was indexable while every canonical pointed to www.syncsense.in, which still serves the old site | High | `X-Robots-Tag: noindex, nofollow` on any host other than syncsense.in (`src/.htaccess`). The live domain is unaffected. |
| Heading order jumped H1 → H3 on Insights, Products and Contract staffing | Low | Added the missing H2s |
| llms.txt missed the product and service use-case pages, staffing roles and demo videos | Medium (AI search) | Added |
| Insights articles had about one internal link each | Medium | "Further reading" links from AskData, Ontology Studio and consulting pages |

## Findings

### Technical
| Check | Result |
|---|---|
| Crawlability (robots.txt, sitemap, internal links) | Good. All 38 indexable pages in the sitemap; no orphans; no broken links. |
| Canonicals and redirects | Good. One canonical host (www, https), trailing slashes consistent, old URLs 301 in one hop. |
| Speed and Core Web Vitals | Good. Lighthouse 100; LCP 1.0–1.3 s, CLS 0. Pages about 4 KB gzipped HTML. |
| Mobile | Good. Responsive at 375–2560 px, no horizontal scroll. |
| HTTPS | Good on the preview. HSTS header not set; add after launch once HTTPS is confirmed on syncsense.in. |
| Structured data | Organization on every page; ProfessionalService, SoftwareApplication, Service, FAQPage, BreadcrumbList, Article and Person where relevant. Run Google's Rich Results Test after launch. |

### On-page
| Issue | Impact | Recommendation |
|---|---|---|
| Home page H1 is visually hidden and the page has about 300 words | Medium | Google can discount hidden text. Option: a small visible line above “Our products”, e.g. “AI data products and data consulting for business teams”, styled like an eyebrow so the page stays clean. |
| Keyword targets are educated guesses | Medium | Check volumes in Google Keyword Planner or Search Console after launch; adjust titles on pages that get impressions but few clicks. |
| Product pages became shorter in the redesign (540–730 words) | Low | Fine for product pages; depth lives on use-case pages, FAQs and articles. Keep linking them. |

### Content
| Issue | Impact | Recommendation |
|---|---|---|
| Case studies are thin (165–345 words) and have no dates | High for trust and ranking | Add per case: timeline, team size, technology used, what was hard, and one approved quote. These pages are the strongest E-E-A-T signal on the site. |
| Only 3 articles | Medium | The Monday schedule fixes this over time. Prioritise topics with search demand (Text-to-SQL, DPDP Act for AI, GraphRAG, GST invoicing). |
| No author page | Medium | Add Santosh’s photo, bio and personal LinkedIn on About; articles already link there. |
| No comparison or alternative pages | Medium | Consider honest pages such as “AskData vs BI tool Q&A features” or “Ovantaa CRM vs Zoho CRM for GST invoicing”, with facts only. |

### Video
The demo videos load only on click, so search engines see the buttons but not the videos. Video SEO happens on YouTube itself: give each video a keyword-led title, a description with a link to the matching product page, chapters and a custom thumbnail. To add VideoObject structured data on the site, send each video’s upload date.

## Launch and off-site actions (for you)

1. **Switch syncsense.in to the new site.** Until then nothing here can rank. The redirects for old URLs are ready.
2. **Google Search Console**: verify the domain, submit `https://www.syncsense.in/sitemap.xml`, request indexing of Home, the three product pages and the use-case pages.
3. **Bing Webmaster Tools**: import from Search Console. Bing also feeds ChatGPT and Copilot search.
4. **Google Business Profile**: service-area business (no street address), name and phone exactly as on the site.
5. **LinkedIn company page and YouTube channel**: link to the site; send me the YouTube channel URL to add to the Organization schema.
6. **Listings and links**: G2 and Capterra (AskData, Ovantaa CRM), Clutch and GoodFirms (services), partner directories (Alteryx if a partnership exists), and guest articles or talks on Text-to-SQL and ontologies.
7. **After 4–6 weeks**: review Search Console queries; improve titles and add content for queries at positions 8–20.
