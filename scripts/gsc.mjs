#!/usr/bin/env node
// Google Search Console CLI — zero dependencies, read-only.
//
// Talks to the official Search Console API with the `webmasters.readonly`
// scope. No third-party server sits in the middle, and the credential never
// leaves the machine.
//
// Auth, in order of preference:
//   1. GSC_SERVICE_ACCOUNT_KEY=/path/key.json   (unattended / cron)
//   2. gcloud Application Default Credentials    (interactive)
// See README.md.
//
// Commands:
//   sites                  list properties and permission level
//   inspect --all          index coverage for every URL in the sitemap
//   inspect <url> [<url>]  index coverage for specific URLs
//   sitemaps               submitted vs indexed counts, errors, last read
//   analytics              clicks/impressions/CTR/position
//   check                  live HTTP sweep of sitemap URLs (no auth needed)

import { createSign } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);

const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const WMX = 'https://www.googleapis.com/webmasters/v3';
const SC = 'https://searchconsole.googleapis.com/v1';

// ---------------------------------------------------------------- arg parsing

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--quiet') opts.quiet = true;
    else if (a === '--all') opts.all = true;
    else if (a.startsWith('--')) opts[a.slice(2)] = argv[++i];
    else opts._.push(a);
  }
  return opts;
}

// ------------------------------------------------------------------- auth

let cachedToken = null;

async function accessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken;
  const keyPath = process.env.GSC_SERVICE_ACCOUNT_KEY;
  cachedToken = keyPath ? await serviceAccountToken(keyPath) : await gcloudAdcToken();
  return cachedToken;
}

async function serviceAccountToken(keyPath) {
  const key = JSON.parse(await readFile(keyPath.replace(/^~/, process.env.HOME), 'utf8'));
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = [
    b64({ alg: 'RS256', typ: 'JWT' }),
    b64({
      iss: key.client_email,
      scope: SCOPE,
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
      ...(process.env.GSC_IMPERSONATE ? { sub: process.env.GSC_IMPERSONATE } : {}),
    }),
  ].join('.');
  const sig = createSign('RSA-SHA256').update(unsigned).sign(key.private_key, 'base64url');

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${sig}`,
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`token exchange failed (${res.status}): ${JSON.stringify(body)}`);
  return {
    token: body.access_token,
    expiresAt: Date.now() + body.expires_in * 1000,
    quotaProject: process.env.GSC_QUOTA_PROJECT || null,
  };
}

async function gcloudAdcToken() {
  let token;
  try {
    const { stdout } = await run('gcloud', ['auth', 'application-default', 'print-access-token']);
    token = stdout.trim();
  } catch (err) {
    throw new Error(
      'No credential found. Either:\n' +
        '  export GSC_SERVICE_ACCOUNT_KEY=/path/to/key.json\n' +
        'or authenticate interactively:\n' +
        `  gcloud auth application-default login --scopes=openid,${SCOPE},https://www.googleapis.com/auth/cloud-platform\n\n` +
        `gcloud said: ${String(err.stderr || err.message).trim()}`,
    );
  }
  let quotaProject = process.env.GSC_QUOTA_PROJECT || null;
  if (!quotaProject) {
    try {
      const { stdout } = await run('gcloud', ['config', 'get-value', 'project']);
      const p = stdout.trim();
      if (p && p !== '(unset)') quotaProject = p;
    } catch { /* optional */ }
  }
  // ADC user tokens last ~1h; re-mint often rather than track expiry precisely.
  return { token, expiresAt: Date.now() + 10 * 60_000, quotaProject };
}

// -------------------------------------------------------------------- fetch

async function api(url, { method = 'GET', body } = {}) {
  for (let attempt = 0; ; attempt++) {
    const auth = await accessToken();
    const res = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${auth.token}`,
        'content-type': 'application/json',
        ...(auth.quotaProject ? { 'x-goog-user-project': auth.quotaProject } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (res.ok) return res.json();

    const text = await res.text();
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
      continue;
    }
    if (res.status === 403 && text.includes('quota')) {
      throw new Error(
        `${res.status} on ${url}\n${text}\n\n` +
          'A 403 mentioning quota usually means no quota project is set. Run:\n' +
          '  gcloud auth application-default set-quota-project <project>\n' +
          'or export GSC_QUOTA_PROJECT=<project>',
      );
    }
    throw new Error(`${method} ${url} -> ${res.status}\n${text}`);
  }
}

// -------------------------------------------------------- property resolution

let resolvedSite = null;

async function resolveSite(opts) {
  if (resolvedSite) return resolvedSite;
  if (opts.site) return (resolvedSite = opts.site);
  if (process.env.GSC_SITE) return (resolvedSite = process.env.GSC_SITE);

  const data = await api(`${WMX}/sites`);
  const entries = data.siteEntry || [];
  if (entries.length === 0) {
    throw new Error('This account has no Search Console properties.');
  }
  if (entries.length > 1) {
    throw new Error(
      'Multiple properties found — pick one with --site or GSC_SITE:\n' +
        entries.map((e) => `  ${e.siteUrl}  (${e.permissionLevel})`).join('\n'),
    );
  }
  resolvedSite = entries[0].siteUrl;
  if (!opts.quiet && !opts.json) process.stderr.write(`Using property ${resolvedSite}\n`);
  return resolvedSite;
}

// A property is either `sc-domain:example.com` or `https://example.com/`.
function siteOrigin(site) {
  return site.startsWith('sc-domain:')
    ? `https://${site.slice('sc-domain:'.length)}`
    : site.replace(/\/$/, '');
}

async function resolveSitemap(opts, site) {
  if (opts.sitemap) return opts.sitemap;
  if (process.env.GSC_SITEMAP) return process.env.GSC_SITEMAP;

  // Prefer what Search Console already knows about.
  try {
    const data = await api(`${WMX}/sites/${encodeURIComponent(site)}/sitemaps`);
    const first = (data.sitemap || []).find((s) => !s.isSitemapsIndex) || (data.sitemap || [])[0];
    if (first?.path) return first.path;
  } catch { /* fall through to the credential-free lookup */ }

  return resolveSitemapWithoutAuth(opts, site);
}

// robots.txt then the conventional path. Touches no API, so `check` stays usable
// with no credential at all.
async function resolveSitemapWithoutAuth(opts, site) {
  if (opts.sitemap) return opts.sitemap;
  if (process.env.GSC_SITEMAP) return process.env.GSC_SITEMAP;

  const origin = siteOrigin(site);
  try {
    const res = await fetch(`${origin}/robots.txt`);
    if (res.ok) {
      const line = (await res.text()).match(/^\s*sitemap:\s*(\S+)/im);
      if (line) return line[1];
    }
  } catch { /* fall through to the conventional path */ }

  return `${origin}/sitemap.xml`;
}

async function sitemapUrls(sitemapUrl) {
  const res = await fetch(sitemapUrl);
  if (!res.ok) throw new Error(`sitemap fetch failed: ${res.status} ${sitemapUrl}`);
  const xml = await res.text();
  const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);

  // A sitemap index points at other sitemaps; follow one level.
  if (/<sitemapindex/i.test(xml)) {
    const nested = await Promise.all(locs.map((u) => sitemapUrls(u).catch(() => [])));
    return [...new Set(nested.flat())];
  }
  return locs;
}

// ------------------------------------------------------------------ helpers

async function mapLimited(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

const pad = (s, n) => String(s ?? '').padEnd(n).slice(0, n);

// ----------------------------------------------------------------- commands

async function cmdSites() {
  const data = await api(`${WMX}/sites`);
  return (data.siteEntry || []).map((s) => ({ site: s.siteUrl, permission: s.permissionLevel }));
}

async function cmdInspect(opts) {
  const site = await resolveSite(opts);
  const urls = opts.all ? await sitemapUrls(await resolveSitemap(opts, site)) : opts._.slice(1);
  if (urls.length === 0) throw new Error('Pass URLs, or --all to read them from the sitemap.');

  if (!opts.quiet && !opts.json) {
    process.stderr.write(`Inspecting ${urls.length} URL(s) against ${site}\n`);
  }

  // URL Inspection quota is 2000/day and 600/min per property. Four in flight
  // with a short spacer stays inside both.
  return mapLimited(urls, 4, async (url, i) => {
    if (i > 0) await new Promise((r) => setTimeout(r, 150));
    try {
      const data = await api(`${SC}/urlInspection/index:inspect`, {
        method: 'POST',
        body: { inspectionUrl: url, siteUrl: site, languageCode: 'en-US' },
      });
      const r = data.inspectionResult || {};
      const idx = r.indexStatusResult || {};
      return {
        url,
        verdict: idx.verdict,
        coverage: idx.coverageState,
        robots: idx.robotsTxtState,
        indexing: idx.indexingState,
        canonicalGoogle: idx.googleCanonical,
        canonicalUser: idx.userCanonical,
        lastCrawl: idx.lastCrawlTime,
        pageFetch: idx.pageFetchState,
        sitemaps: idx.sitemap,
        referringUrls: idx.referringUrls,
        mobile: r.mobileUsabilityResult?.verdict,
        richResults: r.richResultsResult?.verdict,
      };
    } catch (err) {
      return { url, verdict: 'ERROR', coverage: String(err.message).split('\n')[0] };
    }
  });
}

async function cmdSitemaps(opts) {
  const site = await resolveSite(opts);
  const data = await api(`${WMX}/sites/${encodeURIComponent(site)}/sitemaps`);
  const rows = (data.sitemap || []).map((s) => ({
    path: s.path,
    lastSubmitted: s.lastSubmitted?.slice(0, 10),
    lastDownloaded: s.lastDownloaded?.slice(0, 10),
    isPending: s.isPending,
    errors: s.errors,
    warnings: s.warnings,
    submitted: s.contents?.[0]?.submitted,
    indexed: s.contents?.[0]?.indexed,
  }));
  if (rows.length === 0 && !opts.json) {
    process.stderr.write(
      '\nNo sitemap is registered for this property.\n' +
        'Google may still find one via robots.txt, but discovery is slower and patchier.\n' +
        'Submit it in Search Console -> Sitemaps. (This tool is read-only on purpose.)\n',
    );
  }
  return rows;
}

async function cmdAnalytics(opts) {
  const site = await resolveSite(opts);
  const days = Number(opts.days || 28);
  const end = new Date(Date.now() - 2 * 86400_000); // Search Console data lags ~2 days
  const start = new Date(end.getTime() - days * 86400_000);
  const iso = (d) => d.toISOString().slice(0, 10);

  const data = await api(`${WMX}/sites/${encodeURIComponent(site)}/searchAnalytics/query`, {
    method: 'POST',
    body: {
      startDate: opts.start || iso(start),
      endDate: opts.end || iso(end),
      dimensions: (opts.dimension || 'query').split(','),
      rowLimit: Number(opts.limit || 25),
      type: opts.type || 'web',
    },
  });
  return (data.rows || []).map((r) => ({
    key: r.keys.join(' | '),
    clicks: r.clicks,
    impressions: r.impressions,
    ctr: `${(r.ctr * 100).toFixed(2)}%`,
    position: r.position.toFixed(1),
  }));
}

// Live serving check. Needs no credential — useful for confirming that a
// Search Console complaint is about the site rather than about which URL was
// inspected.
async function cmdCheck(opts) {
  // Auth-free as long as the property (or a sitemap) is named. Auto-detecting
  // the property is the one step that needs the API, so failing there must not
  // read as "this command needs credentials".
  let site = opts.site || process.env.GSC_SITE || null;
  if (!site && !opts.sitemap && !process.env.GSC_SITEMAP && opts._.length <= 1) {
    try {
      site = await resolveSite(opts);
    } catch {
      throw new Error(
        'check needs to know what to sweep. Either name the site or skip auth entirely:\n' +
          '  gsc.mjs check --site https://example.com/\n' +
          '  gsc.mjs check --sitemap https://example.com/sitemap.xml\n' +
          '  gsc.mjs check https://example.com/page\n' +
          'Auto-detecting the property is the only part that needs a credential.',
      );
    }
  }
  const urls =
    opts._.length > 1
      ? opts._.slice(1)
      : await sitemapUrls(await resolveSitemapWithoutAuth(opts, site));
  return mapLimited(urls, 8, async (url) => {
    try {
      const res = await fetch(url, { redirect: 'manual' });
      return {
        status: res.status,
        redirectsTo: res.headers.get('location') || '',
        robotsTag: res.headers.get('x-robots-tag') || '',
        url,
      };
    } catch (err) {
      return { status: 'ERR', redirectsTo: err.message.slice(0, 40), robotsTag: '', url };
    }
  });
}

// -------------------------------------------------------------------- render

function renderInspect(rows) {
  const lines = [
    `${pad('VERDICT', 10)}${pad('COVERAGE', 42)}${pad('LAST CRAWL', 13)}URL`,
    '-'.repeat(104),
  ];
  for (const r of rows) {
    lines.push(
      pad(r.verdict, 10) +
        pad(r.coverage, 42) +
        pad(r.lastCrawl ? r.lastCrawl.slice(0, 10) : '-', 13) +
        r.url,
    );
  }
  const counts = rows.reduce((acc, r) => {
    const k = r.coverage || r.verdict || 'unknown';
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});
  lines.push('', 'Summary:');
  for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${String(v).padStart(4)}  ${k}`);
  }
  return lines.join('\n');
}

function renderTable(rows) {
  if (rows.length === 0) return '(no rows)';
  const cols = Object.keys(rows[0]);
  const width = (c) =>
    Math.min(52, Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)) + 2);
  const w = Object.fromEntries(cols.map((c) => [c, width(c)]));
  const head = cols.map((c) => pad(c.toUpperCase(), w[c])).join('');
  return [
    head,
    '-'.repeat(head.length),
    ...rows.map((r) => cols.map((c) => pad(r[c], w[c])).join('')),
  ].join('\n');
}

// ---------------------------------------------------------------------- main

const opts = parseArgs(process.argv.slice(2));

try {
  let rows;
  let render = renderTable;
  switch (opts._[0]) {
    case 'sites': rows = await cmdSites(opts); break;
    case 'inspect': rows = await cmdInspect(opts); render = renderInspect; break;
    case 'sitemaps': rows = await cmdSitemaps(opts); break;
    case 'analytics': rows = await cmdAnalytics(opts); break;
    case 'check': rows = await cmdCheck(opts); break;
    default:
      process.stderr.write(
        'Usage: node scripts/gsc.mjs <command> [flags]\n\n' +
          '  sites                    properties and permission level\n' +
          '  inspect --all            index coverage for every sitemap URL\n' +
          '  inspect <url> [<url>]    index coverage for specific URLs\n' +
          '  sitemaps                 submitted vs indexed, errors, last read\n' +
          '  analytics                clicks/impressions/CTR/position\n' +
          '  check                    live HTTP sweep of sitemap URLs (no auth)\n\n' +
          'Flags: --site <property> --sitemap <url> --json --quiet\n' +
          '       analytics: --days N --dimension query|page|country|device --limit N\n',
      );
      process.exit(2);
  }
  console.log(opts.json ? JSON.stringify(rows, null, 2) : render(rows));
} catch (err) {
  process.stderr.write(`${err.message}\n`);
  process.exit(1);
}
