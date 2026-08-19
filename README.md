# Search Console skill for Claude Code

A Claude Code skill that reads Google Search Console directly: index coverage for
every URL in your sitemap, sitemap status, and search analytics — plus the
diagnostic playbook for reading the results correctly.

No dependencies. No third-party server. Read-only.

## Why not an MCP server

Google publishes an official MCP server for Analytics but none for Search
Console, so every option is community-built and asks for a long-lived OAuth
grant on your whole Search Console account, brokered by someone else's process.

This is a ~400-line script that calls the official API with the
`webmasters.readonly` scope. The credential is minted by `gcloud` (or your own
service account), stays on your machine, and cannot write.

## Install

As a Claude Code skill:

```bash
git clone https://github.com/yevgavrikov/claude-skill-search-console
mkdir -p ~/.claude/skills/search-console
cp -r claude-skill-search-console/{SKILL.md,scripts} ~/.claude/skills/search-console/
```

Or just run the CLI without installing anything:

```bash
npx github:yevgavrikov/claude-skill-search-console audit --site https://example.com/
```

Project-scoped instead of global: copy into `.claude/skills/search-console/`
inside the repo.

Requires Node 20+ (built-in `fetch` and `base64url`) and the `gcloud` CLI.

## Install gcloud

`gcloud` is what mints the credential. Nothing here works without it unless you
go the service-account route, which also uses `gcloud` to create the key.

```bash
brew install --cask google-cloud-sdk     # macOS
```

Other platforms, including the Linux tarball, apt/yum repos and the Windows
installer: <https://cloud.google.com/sdk/docs/install>

Then log in, if you have not used gcloud before:

```bash
gcloud auth login
```

That is a plain account login. It is not yet the API credential — that is the
next section.

## Authenticate

Both paths need a Google Cloud project with the Search Console API enabled. Any
project you own works, the API is free, and no billing account is required.

```bash
gcloud projects list                              # do you already have one?
gcloud projects create my-gsc-project             # if not (id must be globally unique)

gcloud config set project my-gsc-project
gcloud services enable searchconsole.googleapis.com
```

### Path A — interactive (fastest)

No Search Console permission changes needed, as long as the Google account you
log in with is already an owner or full user of the property.

```bash
gcloud auth application-default login \
  --scopes=openid,https://www.googleapis.com/auth/webmasters.readonly,https://www.googleapis.com/auth/cloud-platform
gcloud auth application-default set-quota-project <your-project>
```

The consent screen asks only to *view* Search Console data. The token lasts
about an hour; re-run the login when you see a 401.

> Being logged into Search Console in your browser does **not** authenticate the
> CLI. That is a website cookie; this needs an API token for the same account.

### Path B — service account (cron, CI, unattended)

```bash
gcloud iam service-accounts create gsc-reader --display-name="Search Console reader"
gcloud iam service-accounts keys create ~/.config/gsc/key.json \
  --iam-account=gsc-reader@<your-project>.iam.gserviceaccount.com

export GSC_SERVICE_ACCOUNT_KEY=~/.config/gsc/key.json
export GSC_QUOTA_PROJECT=<your-project>
```

Then in Search Console: **Settings → Users and permissions → Add user**, paste
the service-account email, permission **Full**.

"Restricted" is not enough — the URL Inspection API returns 403 for restricted
users. Keep the key outside any repo.

## Use

The script lives inside the skill directory, so point at it rather than using a
relative path from wherever you happen to be:

```bash
GSC=~/.claude/skills/search-console/scripts/gsc.mjs
```

First, confirm auth works and see what the account can reach:

```bash
node $GSC sites
```

```
SITE                     PERMISSION
sc-domain:example.com    siteOwner
```

`siteOwner` or `siteFullUser` is what you want. `siteRestrictedUser` will 403 on
URL Inspection. If you get "No credential found", the login above did not
complete — re-run it.

Then:

```bash
node $GSC inspect --all            # coverage for every sitemap URL
node $GSC inspect https://example.com/pricing
node $GSC sitemaps                 # submitted vs indexed, errors
node $GSC analytics --days 28 --dimension query --limit 25
node $GSC analytics --dimension page --limit 50
node $GSC check --site https://example.com/   # live HTTP sweep, no credential needed
```

### Auditing what Search Console cannot tell you

`audit` validates the things that cause indexing problems but never appear as a
Search Console error. It uses no credential and no API quota — just HTTP — so it
works before authentication is set up at all.

```bash
node $GSC audit --site https://example.com/
node $GSC audit --sitemap https://example.com/sitemap.xml
node $GSC audit https://example.com/de/page      # specific URLs
```

```
SEVERITY  CHECK                       URL                            DETAIL
ERROR     hreflang-not-reciprocal     https://example.com/de/pricing  en -> https://example.com/pricing does not link back
ERROR     canonical-points-elsewhere  https://example.com/old         canonical -> https://example.com/new
WARN      hreflang-no-x-default       https://example.com/de/pricing  no x-default in the set

2 error(s), 1 warning(s) across 53 sitemap URL(s), 61 page(s) fetched.
```

Checks performed:

| Severity | Check | Why it matters |
| --- | --- | --- |
| ERROR | `sitemap-url-redirects` | A sitemap should list final URLs, not redirect sources |
| ERROR | `sitemap-url-not-200` | Dead URL advertised to Google |
| ERROR | `noindex-in-sitemap` | The sitemap asks for indexing, the page refuses it |
| ERROR | `canonical-points-elsewhere` | The page cannot index on its own |
| ERROR | `canonical-multiple` | Conflicting canonicals; Google picks arbitrarily |
| ERROR | `hreflang-no-self-reference` | A set that omits its own page is invalid and ignored wholesale |
| ERROR | `hreflang-not-reciprocal` | Non-reciprocal links invalidate the whole cluster |
| ERROR | `hreflang-invalid-code` | e.g. `hreflang="uk"` meant as Ukrainian, or an invented code |
| ERROR | `hreflang-conflicting` | One language pointing at two different URLs |
| ERROR | `hreflang-target-broken` | Declared alternate is 404 or unreachable |
| ERROR | `unreachable` | Page did not respond |
| WARN | `hreflang-target-redirects` | Alternate resolves through a redirect |
| WARN | `hreflang-no-x-default` | No fallback for unmatched locales |
| WARN | `canonical-missing`, `canonical-target-not-in-sitemap` | |
| WARN | `title-missing`, `title-duplicate`, `description-missing` | |

`hreflang` targets outside the sitemap are fetched too, since reciprocity cannot
be judged without seeing the page being pointed at.

A caveat worth knowing: head tags are extracted with regular expressions, which
is unsound for HTML in general but adequate for attribute-only elements in
`<head>`. A page whose head is built client-side will look empty to this tool —
which is itself informative, because Google may see the same thing.

### Tracking change over time

Indexing moves slowly, so the useful question is rarely "what is the state" but
"what changed since last time". Save a baseline, compare against it later:

```bash
node $GSC inspect --all --save baseline.json          # today
node $GSC inspect --all --compare baseline.json       # a week later
```

```
3 change(s) against baseline.json:

CHANGE                FROM                      TO                        URL
LOST INDEXING         Submitted and indexed     URL is unknown to Google  https://example.com/pricing
DROPPED FROM SITEMAP  Submitted and indexed     -                         https://example.com/old
GAINED                URL is unknown to Google  Submitted and indexed     https://example.com/guides/x
```

Only changes are printed, regressions first. Coverage strings are classified into
buckets before comparison, so Google rewording a message is not reported as a
change. This catches the failure that a one-off check never will: a page that was
indexed quietly dropping out.

Pair `--save` with `--compare` to roll the baseline forward as you go.

`check` is the one command that works before any authentication, as long as the
site is named — `--site`, `--sitemap`, or explicit URLs. Useful for separating
"the site is broken" from "Search Console is reporting something confusing".
Auto-detecting the property is the only part that needs a credential.

Or just ask Claude: *"why isn't /pricing indexed?"* — the skill supplies the
diagnostic order and the `coverageState` mapping.

Example:

```
$ node $GSC inspect --all
Using property sc-domain:example.com
Inspecting 53 URL(s) against sc-domain:example.com
VERDICT   COVERAGE                                  LAST CRAWL   URL
--------------------------------------------------------------------------------
PASS      Submitted and indexed                     2026-08-18   https://example.com/
NEUTRAL   URL is unknown to Google                  -            https://example.com/guides/x

Summary:
    37  Submitted and indexed
    16  URL is unknown to Google
```

### Configuration

Everything is optional — the property is auto-detected when the account has
exactly one, and the sitemap is found from Search Console or `robots.txt`.

| Variable | Purpose |
| --- | --- |
| `GSC_SITE` | Property, e.g. `sc-domain:example.com` or `https://example.com/` |
| `GSC_SITEMAP` | Sitemap URL, if not discoverable |
| `GSC_SERVICE_ACCOUNT_KEY` | Path to a service-account key JSON |
| `GSC_QUOTA_PROJECT` | Google Cloud project for quota |
| `GSC_IMPERSONATE` | Workspace user to impersonate (domain-wide delegation) |

Flags: `--site`, `--sitemap`, `--json`, `--quiet`; `analytics` also takes
`--days`, `--start`, `--end`, `--dimension` (comma-separated), `--limit`,
`--type`.

`--json` emits the full API fields — `googleCanonical`, `userCanonical`,
`robotsTxtState`, `pageFetchState`, `referringUrls`, mobile usability and rich
results — not just the summary columns.

## What this does not do

Stated up front so nothing here is a surprise after you install it.

**Not implemented**

- **No sitemap submission and no "request indexing".** Both need the read-write
  scope. See below — this is a deliberate choice, not an oversight.
- **No `hreflang` or structured-data validation.** A broken `hreflang` set or
  invalid schema is a common real cause of indexing trouble and this tool cannot
  see either. Search Console's own reports still cover them.
- **No search-analytics filtering or pagination.** `--dimension` and `--limit`
  work, but there is no `dimensionFilterGroups` support and no paging past the
  API's per-request row cap, so large sites cannot be fully exported.
- **No Core Web Vitals, no crawl-stats, no security-issues reports.** Only
  indexing, sitemaps, and search analytics.
- **`check` follows one redirect hop.** A multi-hop chain shows its first hop
  only, by design — the point is spotting an unexpected redirect, not tracing it.
- **No tests.** The script is verified by hand against a live property. If you
  rely on it in CI, add your own checks first.

**Practical limits**

- **URL Inspection allows 2000 requests/day per property.** `inspect --all` costs
  one per URL, so a site with thousands of pages cannot be swept in a day.
  Inspect a sample plus the pages that matter.
- **Search Console data lags roughly two days**, and index state lags crawling by
  longer. Re-running a sweep the next day tells you almost nothing; a week is a
  sensible interval.
- **Interactive tokens last about an hour.** A 401 means re-run the
  `application-default login`. Use a service account for anything unattended.
- **Service accounts need Full permission**, not Restricted, or URL Inspection
  returns 403.
- **Node 20+.** Developed and tested on macOS; the code is plain Node with no
  platform-specific calls, but Linux and Windows are untested.
- **`inspect` output is only as good as your sitemap.** `--all` reads the
  sitemap, so a URL missing from it is invisible to a sweep. Pass such URLs
  explicitly.

Issues and pull requests welcome, particularly for `hreflang` validation and
analytics paging — those are the two most useful missing pieces.

## Deliberately read-only

Submitting a sitemap or requesting indexing needs the read-write `webmasters`
scope. That is left out on purpose: the common case is diagnosis, and a
diagnostic tool should not be able to change your property. Do those two things
in the Search Console UI.

## Quota

URL Inspection: 2000 requests/day, 600/minute per property. The script runs 4 in
flight with a spacer and backs off on 429/5xx.

## Licence

MIT
