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

```bash
git clone https://github.com/<you>/claude-skill-search-console
mkdir -p ~/.claude/skills/search-console
cp -r claude-skill-search-console/{SKILL.md,scripts} ~/.claude/skills/search-console/
```

Project-scoped instead of global: copy into `.claude/skills/search-console/`
inside the repo.

Requires Node 20+ (uses built-in `fetch` and `base64url`) and, for the
interactive auth path, the `gcloud` CLI.

## Authenticate

Both paths need a Google Cloud project with the API enabled. Any project you own
works; the API is free.

```bash
gcloud config set project <your-project>
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

```bash
node scripts/gsc.mjs sites                    # properties + permission level
node scripts/gsc.mjs inspect --all            # coverage for every sitemap URL
node scripts/gsc.mjs inspect https://example.com/pricing
node scripts/gsc.mjs sitemaps                 # submitted vs indexed, errors
node scripts/gsc.mjs analytics --days 28 --dimension query --limit 25
node scripts/gsc.mjs analytics --dimension page --limit 50
node scripts/gsc.mjs check                    # live HTTP sweep, no auth needed
```

Or just ask Claude: *"why isn't /pricing indexed?"* — the skill supplies the
diagnostic order and the `coverageState` mapping.

Example:

```
$ node scripts/gsc.mjs inspect --all
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
