---
name: search-console
description: Query Google Search Console and diagnose indexing problems — "URL is not on Google", "page with redirect", "crawled/discovered but not indexed", sitemap errors, coverage sweeps across every sitemap URL, and search query/impression data. Use whenever a Search Console screenshot, URL Inspection result, indexing question, or organic-ranking question comes up.
---

# Search Console

Read-only Google Search Console access via `scripts/gsc.mjs` (zero dependencies,
official API, `webmasters.readonly` scope). Setup: `README.md`.

**Resolve the script path first.** It lives beside this file, and the working
directory is usually somewhere else entirely, so a bare `scripts/gsc.mjs` will
fail with `Cannot find module`. Set `GSC` to whichever of these exists:

```bash
GSC=~/.claude/skills/search-console/scripts/gsc.mjs      # personal install
GSC=.claude/skills/search-console/scripts/gsc.mjs        # project install
```

```bash
node $GSC sites                    # properties + permission level
node $GSC inspect --all            # coverage for every sitemap URL
node $GSC inspect <url> [<url>]    # specific URLs
node $GSC sitemaps                 # submitted vs indexed, errors
node $GSC analytics --days 28 --dimension query --limit 25
node $GSC check --site <property>  # live HTTP sweep, needs no credential

node $GSC inspect --all --save baseline.json      # record today's state
node $GSC inspect --all --compare baseline.json   # report only what changed
```

For any recurring check, prefer `--compare` over re-reading a full table. It
prints regressions first and catches a page silently losing indexing, which a
fresh sweep read in isolation will not show.

If the script reports "No credential found", send the user to `README.md`. Setup
is a one-time human step (installing `gcloud`, then a browser consent flow — or a
service-account key added as a **Full** user in Search Console). Do not try to
work around it, and do not attempt the browser login on the user's behalf: it
needs their Google account and their consent.

`check` is the exception — it needs no credential as long as the site is named
(`--site`, `--sitemap`, or explicit URLs), so it can answer "is the site serving
correctly?" before auth is set up at all.

## Diagnose in this order

Most "not indexed" reports are not site bugs. Rule those out first.

1. **Which URL was actually inspected?** If the user pasted `http://…` or a
   `www.` variant into URL Inspection and the site redirects to a canonical
   host, "Page with redirect" is the **correct** verdict — Google indexes the
   target, not the source. Re-inspect the canonical URL before changing anything.
2. **What property type is it?** A URL-prefix property on `http://` reports
   every page as "Page with redirect". Domain properties look like
   `sc-domain:example.com`; URL-prefix like `https://example.com/`.
3. **Is the site actually serving correctly?** `node $GSC check --site <property>`
   sweeps every sitemap URL and shows status, redirect target, and any
   `X-Robots-Tag`. Wanted: 200, no redirect, no noindex.
4. **Is a sitemap registered?** `sitemaps` returning no rows is a real and very
   common finding. Google can discover a sitemap from `robots.txt`, but
   discovery is slower and patchier, which shows up as scattered
   "URL is unknown to Google" on deep or locale pages while shallow pages index
   fine. Submitting the sitemap in the Search Console UI is usually the single
   highest-value fix.
5. **Only now read `coverageState`.**

## coverageState → what to do

| Value | Meaning | Action |
| --- | --- | --- |
| `Submitted and indexed` | Working | None |
| `Indexed, not submitted in sitemap` | Indexed but missing from sitemap | Add it to the sitemap |
| `Page with redirect` | URL is a redirect source | None if intended — the target is what indexes |
| `URL is unknown to Google` | Never discovered | Submit sitemap; add internal links |
| `Discovered - currently not indexed` | Known, not crawled | Crawl budget / low authority. Not technical |
| `Crawled - currently not indexed` | Crawled, judged not worth indexing | Content depth and authority. Not technical |
| `Alternate page with proper canonical tag` | Duplicate resolved to canonical | Expected for intentional duplicates; a bug if the page should stand alone |
| `Duplicate without user-selected canonical` | Google picked a different canonical | Add an explicit `<link rel=canonical>` |
| `Excluded by 'noindex' tag` | Blocked by the page itself | Real bug unless deliberate |
| `Blocked by robots.txt` | Blocked before fetch | Fix `robots.txt` |
| `Soft 404` | Thin or empty-looking page | Content problem, or a client-rendered page Google saw empty |
| `Not found (404)` / `Server error (5xx)` | Broken | Fix serving, or drop it from the sitemap |

## Do not confuse these

- **Redirects are not a defect.** Canonicalising scheme and host is correct.
  Never "fix" intentional 301s because Search Console flagged the source.
- **`Crawled/Discovered - currently not indexed` is not a technical problem.**
  Serving is fine and Google is declining to index. That is content depth,
  internal linking, and authority. Route it to content and link-building work,
  not to server config.
- **A `Temporary processing error` under Discovery → Sitemaps** is often just
  that no sitemap is registered. Confirm with the `sitemaps` command instead of
  guessing.
- **Search Console data lags ~2 days**, and index state lags crawling by longer.
  A page published today reporting "unknown" means nothing yet.
- **`lastCrawlTime` is the ground truth for "is Google still visiting".**
  A recent crawl plus a non-indexed state is a judgement call by Google, not a
  fetch failure.

## Client-rendered sites

If the page is a SPA and `inspect` reports `Soft 404` or an unexpected
canonical, check what Google actually received: `curl` the URL and look for real
content in the HTML. A shell that renders client-side can index inconsistently.
Pre-rendering or SSR is the fix, not a Search Console setting.

## Limits — say so rather than improvising

If a user asks for one of these, tell them it is not covered instead of
approximating an answer from what the tool does return:

- **Sitemap submission and "request indexing"** need the read-write scope, which
  this tool does not hold. Direct the user to the Search Console UI.
- **`hreflang` correctness, structured data, Core Web Vitals, crawl stats,
  security issues** — not exposed here at all. Search Console's own reports cover
  them.
- **Search-analytics filtering and paging past the row cap** are not implemented,
  so a full export of a large site is not possible with this tool.
- **A URL missing from the sitemap is invisible to `inspect --all`.** Pass it
  explicitly rather than concluding it does not exist.
- **`check` reports one redirect hop only.** Do not present its output as a full
  redirect chain.
- **Data lag is real.** Search Console lags ~2 days and index state lags crawling
  by longer, so a sweep re-run the next day proves nothing. Say that instead of
  reading noise as a trend.

## Quota

URL Inspection allows 2000 requests/day and 600/minute per property. The script
runs 4 in flight with a spacer and retries 429/5xx with backoff, so a few
hundred URLs is safe. For a site with thousands of pages, inspect a sample plus
the pages that matter rather than everything.
