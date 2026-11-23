# Weekly Insights article: playbook

A scheduled task runs every Monday and follows this file to publish one new article on the Insights page and draft a LinkedIn post for it. Edit this file to change topics, rules or where the site is deployed. The task always reads the latest version.

## Where things are

- Repository: `sinsntgit/demo-apps`, branch `claude/adoring-archimedes-l2qy18`, folder `syncsense_site/`.
- Articles: `content/insights/<slug>.html` (copy the header format of an existing article).
- Topic list: `content/insights/TOPICS.md`. Take the first unchecked topic, then tick it.
- LinkedIn draft: `docs/linkedin/<YYYY-MM-DD>-<slug>.md`.
- **Deploy target**: Hostinger website `syncsense.in`, hosting username `u820401878` (live site, www.syncsense.in).
  The preview site `close-antiquewhite-walrus-53.hostingersite.com` is for testing only; do not deploy articles there.

## Steps

1. Pick the first unchecked topic in `TOPICS.md`. If a topic is clearly out of date, skip it and note why.
2. Optionally run one or two web searches for a timely angle (a regulation, a widely reported trend). Use only reputable, verifiable sources and link to them in the article.
3. Write the article (rules below) to `content/insights/<slug>.html` with today's date in `date`.
4. Run `python3 build.py` (fix any warning about title or description length), then `python3 -I tools/check_site.py public`. It must print `NO ISSUES`.
5. Write the LinkedIn post draft (rules below).
6. Tick the topic in `TOPICS.md`, adding the date and URL.
7. Commit with a message like `Insights: <title>` and push to the branch.
8. Deploy: zip the contents of `public/` (including `.htaccess`) into `site.zip`, get upload credentials with the Hostinger tool `hosting_files_generate-upload-url` for the deploy target, upload with TUS (POST then PATCH, as described in the tool's result), then run `hosting_websites_deploy-static-site-archive` with `archive_path: site.zip`. Check the new article URL returns 200.
9. Reply with: the article title and URL, the LinkedIn draft text, and anything that failed.

If any step fails (for example the deploy), still commit and push the article, and say clearly what did not happen.

## Article rules

- 1,000 to 1,500 words, practical, for business and data leaders (CFO, CIO, CDO, heads of analytics, finance, operations and sales) in India and beyond.
- Start with a 2 to 3 sentence direct answer. Use question-style H2s with direct answers under them. Include one checklist, table or worked example.
- **Never invent facts**: no made-up statistics, client names, quotes or results. Facts about SyncSense and its products come only from this repository's content (`content/data.py`, product and case study pages). External facts need a source link.
- Plain language. No buzzwords (leverage, synergy, best-in-class, cutting-edge, unlock, revolutionise, seamless, empower, game-changing, leading provider). No "It's not X, it's Y" patterns. At most two em dashes.
- Link to at least two relevant pages on the site (a product, a product use-case page, an industry page or a case study) and end with a CTA to book a demo or request the free data assessment.
- Header fields: `path` (`/insights/<slug>/`), `schema: ["Article"]`, `title` (under 60 characters, ending `| SyncSense`), `description` (140 to 155 characters), `keyword`, `h1`, `short` (breadcrumb label), `date`, `read` (minutes).
- Author is Santosh Tiwari (added automatically by the build).

## LinkedIn post rules

- 150 to 250 words. First line is a hook that works on its own in the feed: a sharp question or a concrete, true observation.
- 3 to 5 short takeaways as separate lines, then the article link (`https://www.syncsense.in/insights/<slug>/`).
- End with a question that invites comments, and 3 to 5 relevant hashtags (for example #DataAnalytics #GenAI #TextToSQL #DataGovernance #CFO).
- Same no-invented-facts and no-buzzword rules as the article.
