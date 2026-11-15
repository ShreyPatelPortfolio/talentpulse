#!/usr/bin/env node
// TalentPulse scanner - runs in GitHub Actions every day (or on any computer with Node 18+).
//
// Reads employers.csv (2,100+ employers) and finds each employer's job board. For employers without a
// careers link it looks up the official website, finds the careers page and works out which job board
// it uses. Then it reads every opening located in Canada (or remote), works out its level (new grad /
// entry level / years of experience asked) and posting date, and writes jobs.json for the website.
// The website then matches YOUR job titles against these openings.
//
//   node scan.js                 # everything
//   node scan.js --part 3/10     # only the 3rd of 10 parts (GitHub runs the 10 parts at the same time)
//   node scan.js --merge         # combine part-1.json ... part-10.json into jobs.json
//   node scan.js --only "Brock"  # one employer (name contains text)

import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCSV, isCanada, regionOf, provinceOf, yearsRequired, hasNewGradWording, isSeniorTitle } from './core.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36 TalentPulse/1.0';
const MAX_DETAILS_PER_EMPLOYER = Number(process.env.TALENTPULSE_MAX_DETAILS || 250);
const TIME_BUDGET_MS = Number(process.env.TALENTPULSE_BUDGET_MIN || 270) * 60000;   // stop starting new employers after this
const HARD_STOP_MS = Number(process.env.TALENTPULSE_HARD_STOP_MIN || 305) * 60000;   // save whatever is done and finish, no matter what
const DISCOVERY_LIMIT_MS = Number(process.env.TALENTPULSE_DISCOVERY_MIN || 4) * 60000;
const EMPLOYER_LIMIT_MS = Number(process.env.TALENTPULSE_EMPLOYER_MIN || 8) * 60000; // one employer may take at most this long
const STARTED = Date.now();
// Wikimedia's User-Agent policy asks for a contact URL or email; the repository URL is the contact.
const WIKI_UA = `TalentPulse/1.1 (https://github.com/${process.env.GITHUB_REPOSITORY || 'ShreyPatelPortfolio/talentpulse'}; job-search tool) Node.js/${process.versions.node}`;
const MAX_LISTINGS = 2500;
const WORKERS = Number(process.env.TALENTPULSE_WORKERS || 12);
const RETRY_NOT_FOUND_DAYS = 7;
const args = process.argv.slice(2);
const onlyIdx = args.indexOf('--only');
const ONLY = onlyIdx >= 0 ? String(args[onlyIdx + 1] || '').toLowerCase() : '';
const partIdx = args.indexOf('--part');
const PART = partIdx >= 0 ? (String(args[partIdx + 1] || '').match(/^(\d+)\/(\d+)$/) || []).slice(1).map(Number) : null; // [n, of]
const MERGE = args.includes('--merge');
if (partIdx >= 0 && !(PART?.length === 2 && PART[0] >= 1 && PART[0] <= PART[1])) { console.error('Use --part N/M, for example --part 3/10'); process.exit(1); }
const WIKI_SLOTS = Number(process.env.TALENTPULSE_WIKI_SLOTS || 1); // one lookup at a time (Wikimedia asks for 3 or fewer)
// Wikimedia allows anonymous tools a few hundred lookups an hour, so each scan uses only a share and the rest wait for the next scan.
const WIKI_MAX = Number(process.env.TALENTPULSE_WIKI_MAX || (PART ? 120 : 450));

// ---------------- HTTP helpers ----------------
// At most a few requests to the same website at once, and wait/retry when a site says "too many requests".
const hostBusy = new Map();
const HOST_SLOTS = Number(process.env.TALENTPULSE_HOST_SLOTS || 4);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function http(url, opts = {}) {
  let host = '';
  try { host = new URL(url).hostname; } catch { /* checked below */ }
  if (!host || !/^https?:/i.test(String(url))) throw new Error(`Not a web address: ${String(url).slice(0, 80)}`);
  while ((hostBusy.get(host) || 0) >= HOST_SLOTS) await sleep(50);
  hostBusy.set(host, (hostBusy.get(host) || 0) + 1);
  try {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(opts.timeout || 25000),
        ...opts,
        headers: { 'User-Agent': UA, 'Accept-Language': 'en-CA,en;q=0.9', ...(opts.headers || {}) },
      });
      if (res.status === 429 && attempt < 3) {
        try { await res.body?.cancel(); } catch { /* ignore */ }
        await sleep(1000 * Math.min(20, Number(res.headers.get('retry-after')) || 3 * (attempt + 1)));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return res;
    }
  } finally { hostBusy.set(host, hostBusy.get(host) - 1); }
}
const getJSON = async (url, opts) => (await http(url, { ...opts, headers: { Accept: 'application/json', ...(opts?.headers || {}) } })).json();
const postJSON = (url, body) => getJSON(url, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
async function getHTML(url, opts) { const r = await http(url, opts); return { html: await r.text(), finalUrl: r.url }; }

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k).catch((e) => ({ error: e })); }
  }));
  return out;
}

// ---------------- HTML → text ----------------
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', bull: '•', hellip: '…' };
export function decodeEntities(s) {
  return String(s || '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
    return ENT[e.toLowerCase()] ?? m;
  });
}
export function htmlToText(html) {
  let s = String(html || '');
  if (/&lt;\s*\w/.test(s) && !/<\s*(p|div|li|br)\b/i.test(s)) s = decodeEntities(s); // escaped HTML (Greenhouse)
  s = s.replace(/<(script|style|noscript|svg|head|nav|footer|header|form)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\s*(br|\/p|\/div|\/li|\/h\d|\/tr|li|\/ul|\/ol|\/section|\/article)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(s).replace(/[ \t\f\v ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
function extractAnchors(html, baseUrl) {
  const out = [];
  const re = /<a\b([^>]*?)href\s*=\s*["']([^"'#]+)["']([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const text = htmlToText(m[4]).replace(/\s+/g, ' ').trim();
    const attrs = `${m[1]} ${m[3]}`;
    const label = text || (attrs.match(/(?:title|aria-label)\s*=\s*["']([^"']+)/i) || [])[1] || '';
    if (!label || label.length > 160) continue;
    try { const href = new URL(decodeEntities(m[2]), baseUrl).href; if (/^https?:/i.test(href)) out.push({ href, text: label }); } catch { /* bad url */ }
  }
  return out;
}
function jsonLdJobs(html) {
  const jobs = [];
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const walk = (n) => {
        if (!n || typeof n !== 'object') return;
        if (Array.isArray(n)) return n.forEach(walk);
        const t = n['@type']; if (t === 'JobPosting' || (Array.isArray(t) && t.includes('JobPosting'))) jobs.push(n);
        if (n['@graph']) walk(n['@graph']);
      };
      walk(JSON.parse(m[1].trim()));
    } catch { /* invalid JSON-LD */ }
  }
  return jobs;
}
function ldLocation(j) {
  const locs = [].concat(j.jobLocation || []).map((l) => l?.address).filter(Boolean)
    .map((a) => [a.addressLocality, a.addressRegion, a.addressCountry?.name || a.addressCountry].filter(Boolean).join(', '));
  if (j.jobLocationType === 'TELECOMMUTE') locs.push('Remote');
  return locs.join(' / ');
}

// ---------------- Optional headless browser (Playwright) for JavaScript-heavy sites --------
let browserPromise = null;
async function renderPage(url) {
  if (process.env.TALENTPULSE_NO_BROWSER) return null;
  if (!browserPromise) {
    browserPromise = import('playwright').then((pw) => pw.chromium.launch()).catch((e) => { console.log(`   (headless browser unavailable: ${e.message.split('\n')[0]})`); return null; });
  }
  const browser = await browserPromise;
  if (!browser) return null;
  while (openPages >= 3) await new Promise((r) => setTimeout(r, 250));
  openPages++;
  let page;
  try { page = await browser.newPage({ userAgent: UA }); } catch { openPages--; return null; }
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const frames = page.frames();
    let html = '';
    for (const f of frames) { try { html += `\n<!-- frame ${f.url()} -->\n` + await f.content(); } catch { /* cross-origin */ } }
    const finalUrl = page.url();
    if (!/^https?:/i.test(finalUrl)) return null; // the page failed to load (e.g. chrome-error://)
    return { html, finalUrl };
  } finally { openPages--; await page.close().catch(() => {}); }
}
let openPages = 0;

// ---------------- ATS detection ----------------
export function detectAts(rawUrl) {
  const u = new URL(rawUrl);
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split('/').filter(Boolean);
  if (/greenhouse\.io$/.test(host)) {
    const slug = u.searchParams.get('for') || parts.find((p) => !['embed', 'job_board', 'jobs'].includes(p));
    if (slug) return { type: 'greenhouse', slug };
  }
  if (/(^|\.)lever\.co$/.test(host) && parts[0]) return { type: 'lever', slug: parts[0], eu: host.includes('.eu.') };
  if (host === 'jobs.ashbyhq.com' && parts[0]) return { type: 'ashby', slug: parts[0] };
  if (/smartrecruiters\.com$/.test(host) && parts[0]) return { type: 'smartrecruiters', slug: parts[0] };
  if (/myworkdayjobs\.com$|myworkdaysite\.com$/.test(host)) {
    const rest = parts.filter((p) => !/^[a-z]{2}-[a-z]{2}$/i.test(p) && p !== 'recruiting');
    const tenant = host.split('.')[0];
    if (host.includes('myworkdaysite')) return { type: 'workday', host, tenant: rest[0], site: rest[1] };
    if (rest[0]) return { type: 'workday', host, tenant, site: rest[0] };
  }
  if (host === 'apply.workable.com' && parts[0] && parts[0] !== 'j') return { type: 'workable', slug: parts[0] };
  if (/\.recruitee\.com$/.test(host)) return { type: 'recruitee', slug: host.split('.')[0] };
  if (/\.bamboohr\.com$/.test(host)) return { type: 'bamboohr', slug: host.split('.')[0] };
  if (/icims\.com$/.test(host)) return { type: 'icims', origin: u.origin };
  if (/tbe\.taleo\.net$/.test(host)) return { type: 'taleo-be', url: rawUrl };
  if (/\/services\/rss\/job/i.test(u.pathname)) return { type: 'successfactors', origin: u.origin };
  if (/\.oraclecloud\.com$/.test(host) && /\/hcmUI\/CandidateExperience\//i.test(u.pathname)) {
    const m = u.pathname.match(/CandidateExperience\/([a-z]{2}(?:-[A-Z]{2})?)\/sites\/([^/]+)/i);
    if (m) return { type: 'oracle', origin: u.origin, lang: m[1], site: m[2], url: rawUrl };
  }
  if (/(^|\.)recruiting\d*\.ultipro\.com$/.test(host) && parts[0] && /jobboard/i.test(parts[1] || '') && parts[2]) {
    return { type: 'ukg', origin: u.origin, tenant: parts[0], board: parts[2], url: rawUrl };
  }
  if (/\.breezy\.hr$/.test(host)) return { type: 'breezy', slug: host.split('.')[0], url: rawUrl };
  return { type: 'generic', url: rawUrl };
}
const EMBED_PATTERNS = [
  /https?:\/\/(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/(?:embed\/job_board\?for=)?[A-Za-z0-9_-]+/,
  /https?:\/\/jobs(?:\.eu)?\.lever\.co\/[A-Za-z0-9_.-]+/,
  /https?:\/\/jobs\.ashbyhq\.com\/[A-Za-z0-9_.%-]+/,
  /https?:\/\/[a-z0-9-]+\.wd\d+\.myworkdayjobs\.com\/(?:[a-zA-Z]{2}-[a-zA-Z]{2}\/)?[A-Za-z0-9_-]+/,
  /https?:\/\/apply\.workable\.com\/(?!j\/)[A-Za-z0-9_-]+/,
  /https?:\/\/(?:jobs|careers)\.smartrecruiters\.com\/[A-Za-z0-9_-]+/,
  /https?:\/\/[a-z0-9-]+\.recruitee\.com/,
  /https?:\/\/[a-z0-9-]+\.bamboohr\.com\/(?:careers|jobs)/,
  /https?:\/\/[a-z0-9.-]+\.tbe\.taleo\.net\/[^"'\s<>]*jobSearch[^"'\s<>]*/,
  /https?:\/\/careers-[a-z0-9-]+\.icims\.com/,
  /https?:\/\/[a-z0-9.-]+\.oraclecloud\.com\/hcmUI\/CandidateExperience\/[a-z]{2}(?:-[A-Z]{2})?\/sites\/[A-Za-z0-9_-]+/,
  /https?:\/\/recruiting\d*\.ultipro\.com\/[A-Za-z0-9_-]+\/JobBoard\/[A-Za-z0-9-]+/i,
  /https?:\/\/[a-z0-9-]+\.breezy\.hr/,
  /https?:\/\/(?:www\.)?myworkdaysite\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?recruiting\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+/,
];
function findEmbeddedAts(html) {
  for (const re of EMBED_PATTERNS) {
    const m = decodeEntities(html).replace(/\\\//g, '/').match(re);
    if (m) { const a = detectAts(m[0]); if (a.type !== 'generic') return { ...a, via: m[0] }; }
  }
  return null;
}

// ---------------- Adapters: each returns [{id,title,url,location,posted,type?,description?, detail?:fn}] ----------
// Find the Workday site's country filter (it may sit inside a "Locations" group).
function workdayCountryFacet(facets) {
  for (const f of facets || []) {
    if (/country/i.test(f.facetParameter || '') && Array.isArray(f.values) && f.values.some((v) => v.descriptor && v.id)) return f;
    const inner = workdayCountryFacet((f.values || []).filter((v) => v.facetParameter && Array.isArray(v.values)));
    if (inner) return inner;
  }
  return null;
}
const ADAPTERS = {
  async greenhouse({ slug }) {
    const d = await getJSON(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`);
    return (d.jobs || []).map((j) => ({ id: `gh-${j.id}`, title: j.title, url: j.absolute_url, location: j.location?.name || '',
      posted: j.first_published || j.updated_at, description: htmlToText(j.content) }));
  },
  async lever({ slug, eu }) {
    const d = await getJSON(`https://api${eu ? '.eu' : ''}.lever.co/v0/postings/${slug}?mode=json`);
    return (d || []).map((j) => ({ id: `lv-${j.id}`, title: j.text, url: j.hostedUrl, location: j.categories?.location || '',
      type: j.categories?.commitment, posted: j.createdAt ? new Date(j.createdAt).toISOString() : '',
      description: [j.descriptionPlain, ...(j.lists || []).map((l) => `${l.text}\n${htmlToText(l.content)}`), j.additionalPlain].filter(Boolean).join('\n\n') }));
  },
  async ashby({ slug }) {
    const d = await getJSON(`https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`);
    return (d.jobs || []).filter((j) => j.isListed !== false).map((j) => ({ id: `ab-${j.id}`, title: j.title, url: j.jobUrl,
      location: [j.location, j.isRemote ? 'Remote' : ''].filter(Boolean).join(' / '), type: j.employmentType, posted: j.publishedAt,
      description: j.descriptionPlain || htmlToText(j.descriptionHtml) }));
  },
  async smartrecruiters({ slug }) {
    const all = [];
    for (let offset = 0; offset < MAX_LISTINGS; offset += 100) {
      const d = await getJSON(`https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=100&offset=${offset}`);
      all.push(...(d.content || []));
      if (!d.content?.length || all.length >= (d.totalFound || 0)) break;
    }
    return all.map((j) => ({ id: `sr-${j.id}`, title: j.name, url: `https://jobs.smartrecruiters.com/${slug}/${j.id}`,
      location: [j.location?.city, j.location?.region, j.location?.remote ? 'Remote' : ''].filter(Boolean).join(', '),
      type: j.typeOfEmployment?.label, posted: j.releasedDate,
      detail: async () => { const x = await getJSON(`https://api.smartrecruiters.com/v1/companies/${slug}/postings/${j.id}`);
        return Object.values(x.jobAd?.sections || {}).map((s) => `${s.title || ''}\n${htmlToText(s.text)}`).join('\n\n'); } }));
  },
  async workday({ host, tenant, site }) {
    const api = `https://${host}/wday/cxs/${tenant}/${site}`;
    const seen = new Map();
    const pageThrough = async (searchText, cap, appliedFacets = {}, first = null) => {
      let total = Infinity;
      for (let offset = 0; offset < Math.min(total, cap); offset += 20) {
        const d = offset === 0 && first ? first : await postJSON(`${api}/jobs`, { appliedFacets, limit: 20, offset, searchText });
        if (offset === 0) total = d.total || 0;
        if (!d.jobPostings?.length) break;
        for (const j of d.jobPostings) if (!seen.has(j.externalPath)) seen.set(j.externalPath, j);
      }
      return total;
    };
    const first = await postJSON(`${api}/jobs`, { appliedFacets: {}, limit: 20, offset: 0, searchText: '' });
    // Most Workday sites have a "Country" filter: read only the Canadian jobs, and skip sites that have none.
    const countryFacet = workdayCountryFacet(first.facets);
    const canada = countryFacet?.values.find((v) => /^(canada\b.*|can|ca)$/i.test(String(v.descriptor || '').trim()) && v.id);
    // A country filter without Canada: "2 Locations"-type jobs are almost surely elsewhere, so leave those out.
    const noCanada = !!countryFacet && !canada;
    if (canada) await pageThrough('', 2000, { [countryFacet.facetParameter]: [canada.id] });
    else {
      const total = await pageThrough('', 1000, {}, first);
      // Global employers list thousands of jobs worldwide: also search for Canadian places so those aren't missed.
      if (total > 1000) {
        for (const t of ['Canada', 'Toronto', 'Ontario', 'Montreal', 'Quebec', 'Vancouver', 'British Columbia', 'Calgary', 'Alberta', 'Ottawa', 'Mississauga', 'Remote']) {
          try { await pageThrough(t, 400); } catch { /* keep what we have */ }
        }
      }
    }
    return [...seen.values()].filter((j) => !(noCanada && /^\d+\s+locations?$/i.test(String(j.locationsText || '').trim()))).map((j) => {
      const many = String(j.locationsText || '').trim().match(/^(\d+)\s+locations?$/i);
      return { id: `wd-${tenant}-${j.externalPath}`, title: j.title, url: `https://${host}/en-US/${site}${j.externalPath}`,
        location: canada && many ? `Canada (${many[1]} locations)` : j.locationsText || '', inCanada: !!canada, posted: j.postedOn || '',
        detail: async () => { const x = await getJSON(`${api}${j.externalPath}`); const i = x.jobPostingInfo || {};
          // every location the job lists, Canadian ones first
          const locs = [...new Set([i.location, ...(i.additionalLocations || [])].filter(Boolean).map(String))];
          const ca = locs.filter((l) => provinceOf(l) || /canada/i.test(l));
          const location = locs.length > 1 ? [...ca, ...locs.filter((l) => !ca.includes(l))].join(' / ') : locs[0] || '';
          return { description: htmlToText(i.jobDescription), type: i.timeType, location: canada && locs.length && !ca.length ? '' : location, posted: i.startDate || j.postedOn }; } };
    });
  },
  // Oracle Cloud HCM ("Candidate Experience") career sites
  async oracle({ origin, site, lang, url }) {
    const base = `${origin}/hcmRestApi/resources/latest`;
    const all = [];
    for (let offset = 0; offset < MAX_LISTINGS; offset += 25) {
      const d = await getJSON(`${base}/recruitingCEJobRequisitions?onlyData=true&expand=requisitionList.secondaryLocations&finder=findReqs;siteNumber=${site},limit=25,offset=${offset},sortBy=POSTING_DATES_DESC`);
      const item = (d.items || [])[0] || {};
      const list = item.requisitionList || [];
      all.push(...list);
      if (!list.length || all.length >= (item.TotalJobsCount || 0)) break;
    }
    if (!all.length && url) return genericListing(url);
    return all.map((j) => ({ id: `or-${origin}-${j.Id}`, title: j.Title, url: `${origin}/hcmUI/CandidateExperience/${lang}/sites/${site}/job/${j.Id}`,
      location: [j.PrimaryLocation, ...(j.secondaryLocations || []).map((l) => l.Name)].filter(Boolean).join(' / '), posted: j.PostedDate,
      description: j.ShortDescriptionStr ? htmlToText(j.ShortDescriptionStr) : '',
      detail: async () => { const x = await getJSON(`${base}/recruitingCEJobRequisitionDetails?expand=all&onlyData=true&finder=ById;Id=%22${j.Id}%22,siteNumber=${site}`);
        const i = (x.items || [])[0] || {}; return [i.ExternalDescriptionStr, i.ExternalResponsibilitiesStr, i.ExternalQualificationsStr].map(htmlToText).join('\n\n'); } }));
  },
  // UKG / UltiPro Recruiting
  async ukg({ origin, tenant, board, url }) {
    const all = [];
    for (let skip = 0; skip < MAX_LISTINGS; skip += 50) {
      const d = await postJSON(`${origin}/${tenant}/JobBoard/${board}/JobBoardView/LoadSearchResults`, {
        opportunitySearch: { Top: 50, Skip: skip, QueryString: '', OrderBy: [{ Value: 'postedDateDesc', PropertyName: 'PostedDate', Ascending: false }], Filters: [] },
        matchCriteria: { PreferredJobs: [], Educations: [], LicenseAndCertifications: [], Skills: [], hasNoLicenses: false, SkippedSkills: [] } });
      const list = d.opportunities || [];
      all.push(...list);
      if (!list.length || all.length >= (d.totalCount || 0)) break;
    }
    if (!all.length && url) return genericListing(url);
    return all.map((j) => ({ id: `uk-${j.Id}`, title: j.Title, url: `${origin}/${tenant}/JobBoard/${board}/OpportunityDetail?opportunityId=${j.Id}`,
      location: (j.Locations || []).map((l) => [l.Address?.City, l.Address?.State?.Code, l.Address?.Country?.Code].filter(Boolean).join(', ')).join(' / '),
      posted: j.PostedDate, description: htmlToText(j.BriefDescription || '') }));
  },
  async breezy({ slug, url }) {
    const d = await getJSON(`https://${slug}.breezy.hr/json`).catch(() => null);
    if (!Array.isArray(d)) return genericListing(url || `https://${slug}.breezy.hr`);
    return d.map((j) => ({ id: `bz-${j.id}`, title: j.name, url: j.url, posted: j.published_date,
      location: [j.location?.name || [j.location?.city, j.location?.country?.name].filter(Boolean).join(', '), j.location?.is_remote ? 'Remote' : ''].filter(Boolean).join(' / '),
      detail: () => detailFromPage(j.url) }));
  },
  async workable({ slug }) {
    const all = []; let token;
    for (let n = 0; n < 40; n++) {
      const d = await postJSON(`https://apply.workable.com/api/v3/accounts/${slug}/jobs`, { query: '', location: [], department: [], worktype: [], remote: [], ...(token ? { token } : {}) });
      all.push(...(d.results || [])); token = d.nextPage; if (!token) break;
    }
    return all.map((j) => ({ id: `wk-${j.shortcode}`, title: j.title, url: `https://apply.workable.com/${slug}/j/${j.shortcode}/`,
      location: [j.location?.city, j.location?.region, j.remote ? 'Remote' : ''].filter(Boolean).join(', '), type: j.type, posted: j.published,
      detail: async () => { const x = await getJSON(`https://apply.workable.com/api/v2/accounts/${slug}/jobs/${j.shortcode}`);
        return [x.description, x.requirements, x.benefits].map(htmlToText).join('\n\n'); } }));
  },
  async recruitee({ slug }) {
    const d = await getJSON(`https://${slug}.recruitee.com/api/offers/`);
    return (d.offers || []).map((j) => ({ id: `rc-${j.id}`, title: j.title, url: j.careers_url, location: j.location || [j.city, j.country].filter(Boolean).join(', '),
      type: j.employment_type_code, posted: j.published_at, description: htmlToText(`${j.description || ''}<p>${j.requirements || ''}`) }));
  },
  async bamboohr({ slug }) {
    const d = await getJSON(`https://${slug}.bamboohr.com/careers/list`);
    return (d.result || []).map((j) => ({ id: `bh-${slug}-${j.id}`, title: j.jobOpeningName, url: `https://${slug}.bamboohr.com/careers/${j.id}`,
      location: [j.location?.city, j.location?.state].filter(Boolean).join(', ') || (j.isRemote ? 'Remote' : ''), type: j.employmentStatusLabel,
      detail: async () => { const x = await getJSON(`https://${slug}.bamboohr.com/careers/${j.id}/detail`); return htmlToText(x.result?.jobOpening?.description); } }));
  },
  async icims({ origin }) {
    const all = new Map();
    for (let pr = 0; pr < 30; pr++) {
      const { html } = await getHTML(`${origin}/jobs/search?ss=1&in_iframe=1&pr=${pr}`);
      const links = extractAnchors(html, origin).filter((a) => /\/jobs\/\d+\//.test(a.href) && !/login|apply/i.test(a.href));
      const before = all.size;
      for (const a of links) { const id = a.href.match(/\/jobs\/(\d+)\//)[1]; if (!all.has(id) && a.text.length > 3) all.set(id, { ...a, id }); }
      if (all.size === before) break;
    }
    return [...all.values()].map((a) => ({ id: `ic-${new URL(origin).hostname}-${a.id}`, title: a.text.replace(/^job title\s*/i, ''), url: a.href.split('?')[0],
      detail: () => detailFromPage(`${a.href.split('?')[0]}?in_iframe=1`) }));
  },
  // SAP SuccessFactors career sites publish an RSS feed of their jobs.
  async successfactors({ origin }) {
    const all = new Map();
    const words = ['', 'analyst', 'specialist', 'coordinator', 'associate', 'advisor', 'consultant', 'manager', 'administrator', 'developer'];
    for (const w of words) {
      let xml;
      try { xml = await (await http(`${origin}/services/rss/job/?locale=en_US&keywords=${w ? `(${w})` : ''}`)).text(); }
      catch (e) { if (!w) throw e; continue; }
      for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
        const tag = (t) => { const x = m[1].match(new RegExp(`<${t}>([\\s\\S]*?)<\\/${t}>`)); return x ? x[1].replace(/^<!\[CDATA\[|\]\]>$/g, '').trim() : ''; };
        const link = decodeEntities(tag('link'));
        if (!link || all.has(link)) continue;
        let title = decodeEntities(tag('title'));
        let location = '';
        const loc = title.match(/\s*\(([^()]*)\)\s*$/);
        if (loc) { location = loc[1]; title = title.slice(0, loc.index).trim(); }
        const description = htmlToText(decodeEntities(tag('description')));
        all.set(link, { id: `sf-${link}`, title, url: link, location, posted: tag('pubDate'), description: description.length > 200 ? description : '',
          detail: () => detailFromPage(link) });
      }
    }
    return [...all.values()];
  },
  async 'taleo-be'({ url }) { return genericListing(url, (a) => /viewRequisition/i.test(a.href)); },
  async generic({ url }) { return genericListing(url); },
};

// Generic career page: read links on the page; links whose text looks like a job title become postings.
async function genericListing(url, linkFilter) {
  let page = await getHTML(url).catch((e) => ({ html: '', finalUrl: url, err: e }));
  const embedded = findEmbeddedAts(page.html);
  if (embedded && embedded.type !== 'taleo-be' && detectAts(page.finalUrl).type === 'generic') {
    console.log(`   ↳ career page uses ${embedded.type} (${embedded.via})`);
    return { delegate: embedded };
  }
  if (embedded?.type === 'taleo-be' && !/tbe\.taleo\.net/.test(page.finalUrl)) {
    console.log(`   ↳ career page uses Taleo (${embedded.via})`);
    page = await getHTML(embedded.via.replace(/&amp;/g, '&'));
  }
  const fromLd = jsonLdJobs(page.html).map((j, i) => ({ id: `ld-${url}-${i}`, title: j.title, url: j.url || page.finalUrl,
    location: ldLocation(j), posted: j.datePosted, type: [].concat(j.employmentType || []).join(', '), description: htmlToText(j.description) }));
  let anchors = extractAnchors(page.html, page.finalUrl);
  if (anchors.length < 5 || (!linkFilter && !anchors.some(looksLikeJobLink))) {
    const rendered = await renderPage(url);
    if (rendered) {
      const emb2 = findEmbeddedAts(rendered.html);
      if (emb2 && emb2.type !== 'taleo-be' && detectAts(rendered.finalUrl).type === 'generic') { console.log(`   ↳ career page uses ${emb2.type}`); return { delegate: emb2 }; }
      anchors = extractAnchors(rendered.html, rendered.finalUrl);
      page = rendered;
    }
  }
  const seen = new Set();
  const jobs = anchors.filter((a) => (linkFilter ? linkFilter(a) : true))
    .filter((a) => { const k = a.href; if (seen.has(k)) return false; seen.add(k); return true; })
    .map((a) => ({ id: `gn-${a.href}`, title: a.text, url: a.href, jobLike: linkFilter ? true : looksLikeJobLink(a), detail: () => detailFromPage(a.href) }));
  return [...fromLd, ...jobs];
}
function looksLikeJobLink(a) {
  return /job|career|posting|requisition|opening|position|vacanc|apply|rid=|jobid|req/i.test(a.href) && !/\/(search|login|signin|privacy|faq)\b/i.test(a.href);
}
async function detailFromPage(url) {
  let { html } = await getHTML(url);
  const ld = jsonLdJobs(html)[0];
  if (ld) return { description: htmlToText(ld.description), location: ldLocation(ld), posted: ld.datePosted, type: [].concat(ld.employmentType || []).join(', ') };
  let text = htmlToText(mainContent(html));
  if (text.length < 300) { const r = await renderPage(url); if (r) text = htmlToText(mainContent(r.html)); }
  return { description: text, location: locationFromText(text) };
}
// "Location: Regina, SK" / "Work location - Toronto" / "Lieu de travail : Montréal" on a job page
function locationFromText(text) {
  const m = String(text || '').match(/(?:^|\n|\s)(?:job |work |primary |)(?:location|lieu(?: de travail)?|city)\s*[:\-–]\s*([^\n|]{3,80})/i);
  if (m) return m[1].split(/\.\s|;|\s{2,}|\s[-–|]\s|\b(?:requires?|salary|hours|status|posted|closing|reports? to)\b/i)[0].replace(/[.,\s]+$/, '').trim().slice(0, 60);
  const p = provinceOf(String(text || '').slice(0, 1500));
  return p ? p : '';
}
function mainContent(html) {
  const m = html.match(/<main\b[\s\S]*?<\/main>/i) || html.match(/<article\b[\s\S]*?<\/article>/i) ||
    html.match(/<div[^>]+(?:id|class)=["'][^"']*(?:job-?description|jobdesc|posting|requisition|job-details|content)[^"']*["'][\s\S]*$/i);
  return m ? m[0] : html;
}


const NOT_A_JOB = /^(apply( now)?|view( all)?( jobs)?|search( jobs)?|log ?in|sign ?in|sign up|careers?|jobs?|home|learn more|read more|see (all|more)|back|next|previous|more|details|english|français|francais|privacy.*|terms.*|cookie.*|contact( us)?|about( us)?|\d+)$/i;
// On plain careers pages every link is read, so keep only link text that looks like a job title.
const ROLE_WORD = /\b(analyst|specialist|coordinator|associate|manager|developer|engineer|officer|advisor|adviser|assistant|consultant|planner|administrator|technician|technologist|representative|clerk|intern|co-?op|student|graduate|director|lead|designer|scientist|accountant|agent|auditor|architect|supervisor|strategist|researcher|economist|controller|buyer|generalist|partner|programmer|tester|writer|editor|nurse|therapist|operator|trainee|apprentice|fellow|position|role)\b/i;
function plausibleTitle(t, strict) {
  return t.length >= 4 && t.length <= 140 && /[a-z]/i.test(t) && !NOT_A_JOB.test(t.trim()) && (!strict || ROLE_WORD.test(t));
}

// Posting date -> "YYYY-MM-DD" (handles ISO, epoch ms, RSS dates and Workday's "Posted 3 Days Ago").
function toDate(v, now = new Date()) {
  if (v == null || v === '') return '';
  if (typeof v === 'number') return new Date(v).toISOString().slice(0, 10);
  const s = String(v).trim();
  const rel = s.match(/posted\s+(today|yesterday|(\d+)\+?\s+days?\s+ago)/i);
  if (rel) {
    const days = /today/i.test(rel[1]) ? 0 : /yesterday/i.test(rel[1]) ? 1 : Number(rel[2]);
    if (/\+/.test(s)) return ''; // "Posted 30+ Days Ago" - exact date unknown
    return new Date(now.getTime() - days * 864e5).toISOString().slice(0, 10);
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) || d.getFullYear() < 2015 ? '' : d.toISOString().slice(0, 10);
}

// ---------------- Finding a job board from the company name (JobWatch's "discover") ----------------
function slugCandidates(name) {
  let base = name.toLowerCase().replace(/\b(inc|llc|ltd|corp|corporation|co|company|plc|gmbh)\b\.?/g, '').replace(/\(.*?\)/g, '');
  const w = base.match(/[a-z0-9]+/g) || [];
  // Only the full name (joined or hyphenated). JobWatch also tried the first word alone, which often
  // landed on a different company's board, so that guess is left out.
  return [...new Set([w.join(''), w.join('-')])].filter((s) => s.length >= 3);
}
const BOARD_URL = { greenhouse: (s) => `https://job-boards.greenhouse.io/${s}`, lever: (s) => `https://jobs.lever.co/${s}`,
  ashby: (s) => `https://jobs.ashbyhq.com/${s}`, smartrecruiters: (s) => `https://jobs.smartrecruiters.com/${s}`, workable: (s) => `https://apply.workable.com/${s}` };
// Name-based guess on the big job boards. A board only counts if it has openings in Canada (or the
// employer is a remote-first company), so a same-named company elsewhere isn't picked up by mistake.
async function discoverBySlug(emp) {
  const remoteFirst = /remote/i.test(emp.canada_presence || '') || /remote/i.test(emp.province || '');
  for (const slug of slugCandidates(emp.company)) {
    for (const type of Object.keys(BOARD_URL)) {
      try {
        const jobs = await ADAPTERS[type]({ slug });
        if (!Array.isArray(jobs) || !jobs.length) continue;
        const inCanada = jobs.some((j) => provinceOf(j.location || '') || /canada/i.test(j.location || ''));
        if (inCanada || remoteFirst) return { url: BOARD_URL[type](slug), listings: jobs, via: 'job board found from the company name' };
      } catch { /* not on this board */ }
    }
  }
  return null;
}

// ---- official website from Wikidata ----
const CORP = /\b(inc|incorporated|ltd|limited|llc|llp|corp|corporation|co|company|plc|gmbh|sa|ag|the|group|holdings?)\b\.?/g;
const normName = (s) => String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/\(.*?\)/g, ' ').replace(CORP, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
function similarName(a, b) {
  const x = normName(a), y = normName(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if ((x.startsWith(y) || y.startsWith(x)) && Math.min(x.length, y.length) >= 5) return true;
  const A = new Set(x.split(' ')), B = new Set(y.split(' '));
  const inter = [...A].filter((w) => B.has(w)).length;
  return inter / new Set([...A, ...B]).size >= 0.75;
}
function nameVariants(name) {
  const out = [];
  const base = name.replace(/\s*\(.*?\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
  out.push(base);
  const bare = base.replace(/[,.]?\s+(inc|incorporated|ltd|limited|llc|llp|corp|corporation|co|company|plc)\.?$/i, '').trim();
  if (bare && bare !== base && bare.length >= 3) out.push(bare);
  const noCanada = base.replace(/\s+(of\s+)?canada(\s+(inc|ltd|limited|corp|corporation))?\.?$/i, '').trim();
  if (noCanada && noCanada !== base && noCanada.length >= 3) out.push(noCanada);
  for (const m of name.matchAll(/\(([^)]+)\)/g)) if (!/^(formerly|ex|see)\b/i.test(m[1]) && m[1].length >= 2) out.push(m[1].trim());
  return [...new Set(out)];
}
const CA_DESC = /canad|ontario|qu[eé]bec|british columbia|alberta|manitoba|saskatchewan|nova scotia|new brunswick|newfoundland|toronto|montr[eé]al|vancouver|calgary|ottawa/i;
// Wikidata (run by Wikimedia) limits how often anonymous tools may ask. We ask one at a time, at most WIKI_MAX times
// per scan, and when it says "too many requests" we stop asking for the rest of this scan.
class WikiPaused extends Error {}
let wikiBusy = 0, wikiUsed = 0, wikiPaused = false, wikiLast = 0;
const wikiStats = { used: 0, paused: '' };
async function wikiGet(url) {
  while (wikiBusy >= WIKI_SLOTS) await sleep(100);
  wikiBusy++;
  try {
    for (let attempt = 0; ; attempt++) {
      if (wikiPaused) throw new WikiPaused('Wikidata asked us to slow down');
      if (wikiUsed >= WIKI_MAX) { wikiPaused = true; wikiStats.paused ||= `used this scan's ${WIKI_MAX} lookups`; throw new WikiPaused('lookup limit for this scan reached'); }
      const gap = 500 - (Date.now() - wikiLast);
      if (gap > 0) await sleep(gap);
      wikiLast = Date.now(); wikiUsed++; wikiStats.used = wikiUsed;
      let res;
      try { res = await fetch(url, { headers: { 'User-Agent': WIKI_UA, 'Api-User-Agent': WIKI_UA, Accept: 'application/json' }, signal: AbortSignal.timeout(25000) }); }
      catch (e) { if (attempt < 1) { await sleep(2000); continue; } throw new Error(`Wikidata lookup failed (${e.message}) - will retry next scan`); }
      if (res.ok) return await res.json();
      try { await res.body?.cancel(); } catch { /* ignore */ }
      const ra = Number(res.headers.get('retry-after'));
      const wait = Number.isFinite(ra) && ra >= 0 ? ra : 5 * 2 ** attempt;
      if (res.status === 429) {
        if (wait <= 30 && attempt < 2) { await sleep(1000 * wait + Math.random() * 500); continue; }
        wikiPaused = true; wikiStats.paused ||= `Wikidata said "too many requests" after ${wikiUsed} lookups`;
        throw new WikiPaused('Wikidata asked us to slow down');
      }
      if (res.status >= 500 && attempt < 2) { await sleep(1000 * Math.min(30, wait)); continue; }
      throw new Error(`Wikidata lookup failed (HTTP ${res.status}) - will retry next scan`);
    }
  } finally { wikiBusy--; }
}
async function officialWebsite(emp) {
  const wantCanada = (emp.hq_country || '').toUpperCase() === 'CA';
  for (const q of nameVariants(emp.company)) {
    const s = await wikiGet(`https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(q)}&language=en&uselang=en&type=item&limit=7&format=json`);
    const cands = (s?.search || []).filter((c) => similarName(q, c.label) || similarName(q, c.match?.text) || (c.aliases || []).some((a) => similarName(q, a)));
    if (!cands.length) continue;
    const e = await wikiGet(`https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${cands.map((c) => c.id).join('|')}&props=claims&format=json`);
    const scored = cands.map((c, i) => {
      const claims = e?.entities?.[c.id]?.claims || {};
      const site = (claims.P856 || []).map((x) => x.mainsnak?.datavalue?.value).find((v) => typeof v === 'string' && /^https?:\/\//.test(v));
      const countries = (claims.P17 || []).map((x) => x.mainsnak?.datavalue?.value?.id);
      return { site, i, canadian: countries.includes('Q16') || CA_DESC.test(c.description || '') };
    }).filter((x) => x.site);
    const pool = wantCanada ? scored.filter((x) => x.canadian) : scored.sort((a, b) => Number(b.canadian) - Number(a.canadian) || a.i - b.i);
    if (pool.length) return pool[0].site;
  }
  return null;
}

// ---- careers page and job board from the website ----
const CAREER_TEXT = /^(careers?|jobs?|job (opportunities|openings|postings)|career (opportunities|centre|center)|join (us|our team)|work (with|for) us|working (at|here|with us)|employment( opportunities)?|carri[eè]res?|emplois?|travailler (chez nous|avec nous)|opportunities|we'?re hiring)$/i;
const CAREER_HREF = /(^https?:\/\/(careers?|jobs|emplois|carrieres)\.)|\/(careers?|jobs|join-us|join-our-team|work-with-us|employment|emplois|carrieres?|carri%c3%a8res?)(\/|$|\?|#|\.)/i;
const OPENINGS_TEXT = /\b(search|view|see|browse|explore|find)\b.{0,20}\b(jobs|openings|opportunities|positions|roles|postings|vacancies|careers)\b|current (openings|opportunities|job postings|vacancies|positions)|job (postings|openings|board|search|opportunities)|open (positions|roles)|available positions|apply (now|today)|postes (disponibles|ouverts)|offres d'emploi/i;
async function isRss(url) {
  try { const t = await (await http(url, { timeout: 15000 })).text(); return /<rss[\s>]/i.test(t) && /<item>/i.test(t); } catch { return false; }
}
async function inspectCareersPage(url, depth, budget = { renders: 1 }) {
  let page = await getHTML(url).catch(() => null);
  if (!page || !page.html) return null;
  if (detectAts(page.finalUrl).type !== 'generic') return { board: page.finalUrl };
  let emb = findEmbeddedAts(page.html);
  if (emb) return { board: emb.via };
  if (/rmkcdn|jobs2web|j2w\.|successfactors/i.test(page.html)) {
    const rss = `${new URL(page.finalUrl).origin}/services/rss/job/?locale=en_US&keywords=`;
    if (await isRss(rss)) return { board: rss };
  }
  let anchors = extractAnchors(page.html, page.finalUrl);
  if ((anchors.length < 8 || !anchors.some((a) => ROLE_WORD.test(a.text))) && budget.renders > 0) {
    budget.renders--;
    const r = await renderPage(page.finalUrl);
    if (r?.html) {
      if (detectAts(r.finalUrl).type !== 'generic') return { board: r.finalUrl };
      emb = findEmbeddedAts(r.html);
      if (emb) return { board: emb.via };
      page = r; anchors = extractAnchors(r.html, r.finalUrl);
    }
  }
  if (depth === 0) {
    const next = [...new Set(anchors.filter((a) => OPENINGS_TEXT.test(a.text)).map((a) => a.href.split('#')[0]))].filter((h) => h !== page.finalUrl).slice(0, 3);
    for (const n of next) {
      if (detectAts(n).type !== 'generic') return { board: n };
      const r = await inspectCareersPage(n, 1, budget);
      if (r?.board || r?.listing) return r;
    }
  }
  const jobsHere = anchors.filter((a) => looksLikeJobLink(a) && plausibleTitle(a.text, true)).length + jsonLdJobs(page.html).length;
  if (jobsHere >= 2) return { listing: page.finalUrl };
  return depth === 0 ? { careers: page.finalUrl } : null;
}
// Try companyname.ca (or .com), accepted only if the page's own title matches the company.
async function guessWebsite(emp, tld) {
  const tried = new Set();
  for (const n of nameVariants(emp.company).slice(0, 2)) {
    const w = n.toLowerCase().replace(/&/g, ' and ').replace(CORP, ' ').match(/[a-z0-9]+/g) || [];
    const joined = w.join(''), hyph = w.join('-');
    if (!(w.length >= 2 || joined.length >= 7)) continue; // single short words are too ambiguous
    for (const host of [`www.${joined}.${tld}`, `www.${hyph}.${tld}`]) {
      if (tried.has(host)) continue;
      tried.add(host);
      const page = await getHTML(`https://${host}/`, { timeout: 10000 }).catch(() => null);
      if (!page?.html) continue;
      const title = `${page.html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || ''} ${page.html.match(/og:site_name["'][^>]*content=["']([^"']+)/i)?.[1] || ''}`;
      if (similarName(n, decodeEntities(title)) || normName(decodeEntities(title)).includes(normName(n))) return page.finalUrl;
    }
  }
  return null;
}
async function discoverFromWebsite(emp, knownSite) {
  let site = /^https?:\/\//i.test(knownSite || '') ? knownSite : null, wikiError = null;
  if (!site) site = await guessWebsite(emp, 'ca');
  if (!site) { try { site = await officialWebsite(emp); } catch (e) { wikiError = e; } }
  if (!site) site = await guessWebsite(emp, 'com');
  if (!site) {
    // Wikidata couldn't answer this time: check again next scan instead of giving up for a week
    if (wikiError) return { status: 'unscanned', note: 'Website lookup is waiting its turn - it will be checked in the next scan' };
    return { status: 'not_found', note: 'Official website not found - add a careers link' };
  }
  let home = await getHTML(site).catch(() => null);
  if (!home) home = await renderPage(site);
  if (home && !/^https?:/i.test(home.finalUrl || '')) home = null;
  const candidates = [];
  if (home?.html) {
    if (detectAts(home.finalUrl).type !== 'generic') return { url: home.finalUrl, site, via: 'job board found from the website' };
    const emb = findEmbeddedAts(home.html);
    if (emb) return { url: emb.via, site, via: 'job board found from the website' };
    const anchors = extractAnchors(home.html, home.finalUrl)
      .filter((a) => CAREER_TEXT.test(a.text.trim()) || CAREER_HREF.test(a.href))
      .sort((a, b) => Number(CAREER_TEXT.test(b.text.trim())) - Number(CAREER_TEXT.test(a.text.trim())));
    candidates.push(...[...new Set(anchors.map((a) => a.href.split('#')[0]))].slice(0, 3));
  }
  const origin = new URL(home?.finalUrl || site).origin;
  const rootHost = new URL(origin).hostname.replace(/^www\./, '');
  if (!candidates.length) candidates.push(`${origin}/careers`, `${origin}/en/careers`, `${origin}/jobs`, `https://careers.${rootHost}`, `https://jobs.${rootHost}`);
  let careersPage = null;
  const budget = { renders: 1 };
  for (const c of [...new Set(candidates)].slice(0, 5)) {
    const r = await inspectCareersPage(c, 0, budget).catch(() => null);
    if (!r) continue;
    if (r.board) return { url: r.board, site, via: 'job board found from the website' };
    if (r.listing) return { url: r.listing, site, via: 'careers page found from the website' };
    if (r.careers && !careersPage) careersPage = r.careers;
  }
  if (careersPage) return { status: 'check_page', url: careersPage, site, note: 'Careers page found, but its job list could not be read - add the direct job-list link' };
  return { status: 'not_found', site, note: 'Careers page not found on the website - add a careers link' };
}

// ---------------- One employer ----------------
// Stop waiting for a slow step after `ms` (the step itself is abandoned).
function limit(promise, ms) {
  let timer;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('This careers site took too long - it will be tried again next scan')), ms); });
  return Promise.race([promise.finally(() => clearTimeout(timer)), timeout]);
}
const vagueLocation = (s) => !String(s || '').trim() || /^(\d+\s+locations?|canada \(\d+ locations\))$/i.test(String(s).trim());
async function scanEmployer(emp, cache, previous) {
  const started = Date.now();
  const known = cache[emp.company];
  let url = emp.careers_url;
  let note = '';
  let listings;
  let site = known?.site || '';
  if (!url) {
    const fresh = known && Date.now() - Date.parse(known.checked || 0) < RETRY_NOT_FOUND_DAYS * 864e5;
    if (known?.status === 'found' && known.url) { url = known.url; note = known.via || ''; }
    else if (fresh && (known.status === 'not_found' || known.status === 'check_page')) {
      return { status: { status: known.status, url: known.url || '', note: known.note || 'Add a careers link' }, jobs: [], cacheEntry: known };
    } else {
      // Look for the employer's job board, but give up on very slow websites (remembered for a week).
      let found;
      try { found = await limit((async () => (await discoverBySlug(emp)) || (await discoverFromWebsite(emp, known?.site)))(), DISCOVERY_LIMIT_MS); }
      catch (e) {
        if (!/took too long/.test(String(e.message))) throw e;
        found = { status: 'not_found', site: known?.site || '', note: 'Website too slow to search automatically - add a careers link' };
      }
      if (found.status === 'unscanned') return { status: { status: 'unscanned', url: '', note: found.note }, jobs: [] };
      if (!found.url || found.status) {
        const entry = { status: found.status || 'not_found', url: found.url || '', site: found.site || '', note: found.note, checked: new Date().toISOString() };
        return { status: { status: entry.status, url: entry.url, note: entry.note }, jobs: [], cacheEntry: entry };
      }
      url = found.url; listings = found.listings; note = found.via; site = found.site || site;
    }
  }
  let ats = detectAts(url);
  if (!listings) listings = await ADAPTERS[ats.type](ats);
  if (listings?.delegate) { ats = listings.delegate; note = `found a ${ats.type} job board on the page`; listings = await ADAPTERS[ats.type](ats); }
  if (listings?.delegate) listings = [];
  const strict = ats.type === 'generic';
  let postings = listings.map((l) => ({ ...l, title: String(l.title || '').replace(/\s+/g, ' ').trim() }))
    .filter((l) => l.jobLike !== false && plausibleTitle(l.title, strict))
    .filter((l) => l.inCanada || isCanada(l.location));
  const total = listings.length;

  // Descriptions tell us years of experience and "new grad" wording. Senior titles are hidden anyway, so skip them.
  // Jobs whose place is known, or listed as "N locations" (the job page names them), get their details first.
  const worth = (l) => Number(!!regionOf(l.location) || vagueLocation(l.location));
  const needDetail = postings.filter((l) => !l.description && l.detail && !isSeniorTitle(l.title))
    .sort((a, b) => worth(b) - worth(a))
    .slice(0, MAX_DETAILS_PER_EMPLOYER);
  await pool(needDetail, 4, async (l) => {
    if (Date.now() - started > 240000) return; // enough time spent on this employer's details
    const d = await l.detail();
    if (typeof d === 'string') l.description = d;
    else if (d) {
      l.description = d.description;
      if (d.location && vagueLocation(l.location)) l.location = d.location;
      l.posted = l.posted || d.posted;
    }
  });
  postings = postings.filter((l) => l.inCanada || isCanada(l.location));

  const now = new Date();
  const jobs = postings.map((l) => {
    const desc = String(l.description || '');
    const id = l.url || l.id;
    return {
      title: l.title, location: l.location || '', region: regionOf(l.location || ''), url: l.url,
      posted: toDate(l.posted, now), years: desc ? yearsRequired(desc) : null, ng: desc ? hasNewGradWording(desc) : false,
      firstSeen: previous.get(id) || now.toISOString().slice(0, 10), id,
    };
  });
  const kind = ats.type === 'taleo-be' ? 'taleo' : ats.type;
  const ok = total || kind !== 'generic';
  const cacheEntry = emp.careers_url ? null : { status: 'found', url, via: note, ...(site ? { site } : {}), checked: new Date().toISOString() };
  return { status: { status: ok ? 'ok' : 'check_page', board: kind, url, note: ok ? note : 'Page shows no jobs - add the direct job-list link', read: total, kept: jobs.length,
    seconds: Math.round((Date.now() - started) / 1000) }, jobs, cacheEntry };
}

// ---------------- Main ----------------
async function main() {
  const all = parseCSV(await readFile(path.join(ROOT, 'employers.csv'), 'utf8'))
    .filter((e) => e.company && !['0', 'false', 'no'].includes(String(e.active).toLowerCase()))
    .filter((e) => !ONLY || e.company.toLowerCase().includes(ONLY));
  const cacheFile = path.join(ROOT, 'boards-cache.json');
  const outFile = path.join(ROOT, 'jobs.json');
  let cache = {}; try { cache = JSON.parse(await readFile(cacheFile, 'utf8')); } catch { /* first run */ }
  let prev = { employers: [], jobs: [] }; try { prev = JSON.parse(await readFile(outFile, 'utf8')); } catch { /* first run */ }
  const previous = new Map((prev.jobs || []).map((j) => [j[4], j[8]])); // url -> firstSeen
  const prevEmp = new Map((prev.employers || []).map((e, i) => [e.n, { e, i }]));
  const prevJobsByEmp = new Map();
  for (const j of prev.jobs || []) { if (!prevJobsByEmp.has(j[0])) prevJobsByEmp.set(j[0], []); prevJobsByEmp.get(j[0]).push(j); }

  // Employers with a link first, then ones whose board was found before, then the ones still to look up.
  const rank = (e) => (e.careers_url ? 0 : cache[e.company]?.status === 'found' ? 1 : 2);
  const sorted = all.map((e, i) => ({ e, i })).sort((a, b) => rank(a.e) - rank(b.e) || a.i - b.i).map((x) => x.e);
  // In part mode, every Nth employer goes to this part, so each part gets a fair mix of quick and slow employers.
  const employers = PART ? sorted.filter((_, i) => i % PART[1] === PART[0] - 1) : MERGE ? [] : sorted;
  const cacheChanges = {};
  const setCache = (name, entry) => { cache[name] = entry; cacheChanges[name] = entry; };
  const dropCache = (name) => { delete cache[name]; cacheChanges[name] = null; };
  console.log(MERGE ? 'TalentPulse: combining the parts' : `TalentPulse: checking ${employers.length} employers${PART ? ` (part ${PART[0]} of ${PART[1]})` : ''}, ${WORKERS} at a time`);

  let done = 0;
  const byName = new Map();
  const carry = (emp) => {
    const p = prevEmp.get(emp.company); // keep the last scan's results for this employer
    return p ? { status: { status: p.e.s, board: p.e.b, url: p.e.u, note: p.e.note, read: p.e.r, kept: p.e.k }, carried: prevJobsByEmp.get(p.i) || [] }
      : { status: { status: 'unscanned', note: 'Not reached in this scan - it will be checked next time' }, jobs: [] };
  };

  let written = false;
  async function save(reason) {
    if (written) return;
    written = true;
    if (PART) { // a part only writes its own results; the combine step builds jobs.json
      const file = path.join(ROOT, `part-${PART[0]}.json`);
      const results = [...byName.values()].map((r) => ({ company: r.emp.company, status: r.status, jobs: r.jobs || [], carried: r.carried || null }));
      await writeFile(file, JSON.stringify({ part: PART[0], of: PART[1], results, cache: cacheChanges }));
      console.log(`\n${reason}: part ${PART[0]} of ${PART[1]} checked ${results.length} of ${employers.length} employers in ${Math.round((Date.now() - STARTED) / 60000)} min.`);
      console.log(`Wikidata lookups used: ${wikiStats.used} of ${WIKI_MAX}${wikiStats.paused ? ` (paused: ${wikiStats.paused})` : ''}`);
      return;
    }
    // Compact output in the order of employers.csv: employers listed once, jobs reference them by index.
    const results = all.map((e) => byName.get(e.company) || { emp: e, ...carry(e) });
    const empOut = results.map(({ emp, status }) => ({ n: emp.company, p: emp.province, c: emp.city, i: emp.industry,
      s: status.status, b: status.board || '', u: status.url || emp.careers_url || '', note: status.note || '', r: status.read || 0, k: status.kept || 0 }));
    const empIndex = new Map(empOut.map((e, i) => [e.n, i]));
    const seen = new Set();
    const jobs = [];
    if (ONLY) { // keep everyone else's results from the last full scan
      for (const [name, { e, i }] of prevEmp) {
        if (empIndex.has(name)) continue;
        empIndex.set(name, empOut.length); empOut.push(e);
        for (const j of prevJobsByEmp.get(i) || []) jobs.push([empIndex.get(name), ...j.slice(1)]);
      }
    }
    for (const { emp, jobs: list, carried } of results) {
      const ei = empIndex.get(emp.company);
      for (const j of carried || []) { if (!seen.has(j[4])) { seen.add(j[4]); jobs.push([ei, ...j.slice(1)]); } }
      for (const j of list || []) {
        if (seen.has(j.id)) continue; seen.add(j.id);
        // [employer, title, location, region, url, posted, years, newGradWording, firstSeen]
        jobs.push([ei, j.title, j.location, j.region, j.url, j.posted, j.years, j.ng ? 1 : 0, j.firstSeen]);
      }
    }
    const counts = empOut.reduce((a, e) => { a[e.s] = (a[e.s] || 0) + 1; return a; }, {});
    const minutes = Math.round((Date.now() - STARTED) / 60000);
    await writeFile(outFile, JSON.stringify({ generatedAt: new Date().toISOString(), minutes, counts, employers: empOut, jobs }));
    await writeFile(cacheFile, JSON.stringify(cache, null, 1));
    console.log(`\n${reason} after ${minutes} min. ${jobs.length} openings in Canada from ${empOut.filter((e) => e.k).length} employers.`, counts);
  }
  // Safety net: GitHub stops a scan after a few hours, so save everything found so far before that happens.
  const watchdog = setTimeout(async () => {
    console.log('Time limit reached - saving what has been found so far.');
    await save('Saved early');
    process.exit(0);
  }, Math.max(0, HARD_STOP_MS - (Date.now() - STARTED)));

  if (MERGE) { // combine the parts' results; employers a part didn't finish keep their previous results
    const files = (await readdir(ROOT)).filter((f) => /^part-\d+\.json$/.test(f)).sort();
    const byCompany = new Map(all.map((e) => [e.company, e]));
    for (const f of files) {
      let part;
      try { part = JSON.parse(await readFile(path.join(ROOT, f), 'utf8')); } catch { console.log(`  ${f}: could not be read, skipped`); continue; }
      for (const r of part.results || []) {
        const emp = byCompany.get(r.company);
        if (emp) byName.set(r.company, { emp, status: r.status, jobs: r.jobs || [], carried: r.carried || undefined });
      }
      for (const [name, entry] of Object.entries(part.cache || {})) { if (entry === null) delete cache[name]; else cache[name] = entry; }
      console.log(`  ${f}: ${(part.results || []).length} employers`);
    }
    clearTimeout(watchdog);
    await save(`Combined ${files.length} parts`);
    process.exit(0);
  }

  await pool(employers, WORKERS, async (emp) => {
    let r;
    if (Date.now() - STARTED > TIME_BUDGET_MS) r = carry(emp);
    else {
      try { r = await limit(scanEmployer(emp, cache, previous), EMPLOYER_LIMIT_MS); }
      catch (e) {
        r = { status: { status: 'error', note: String(e.message || e).slice(0, 200) }, jobs: [] };
        if (!emp.careers_url) { // look again next scan, but keep the website if we know it (no need to ask Wikidata again)
          const knownSite = cache[emp.company]?.site;
          if (knownSite) setCache(emp.company, { status: 'retry', site: knownSite, checked: new Date().toISOString() }); else dropCache(emp.company);
        }
      }
      if (r.cacheEntry) setCache(emp.company, r.cacheEntry);
    }
    byName.set(emp.company, { emp, ...r });
    done++;
    if (done % 50 === 0) console.log(`  ${done}/${employers.length} checked (${Math.round((Date.now() - STARTED) / 60000)} min)`);
  });
  clearTimeout(watchdog);
  await save('Done');
  if (browserPromise) { const b = await browserPromise; await b?.close(); }
  process.exit(0);
}

if (process.env.TALENTPULSE_RUN || (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]))) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
export { ADAPTERS, scanEmployer, toDate, slugCandidates, similarName, nameVariants, officialWebsite, discoverFromWebsite, inspectCareersPage };
