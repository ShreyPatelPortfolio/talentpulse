// TalentPulse engine, shared by the website (browser) and the scanner (GitHub Actions / Node).
// Ported from the JobWatch desktop app: levels.py, canada.py and checker.py's title matching.

// ---------------------------------------------------------------- Canada (canada.py)
export const PROVINCE_NAMES = {
  ON: 'Ontario', QC: 'Quebec', BC: 'British Columbia', AB: 'Alberta', MB: 'Manitoba', SK: 'Saskatchewan',
  NS: 'Nova Scotia', NB: 'New Brunswick', NL: 'Newfoundland and Labrador', PE: 'Prince Edward Island',
  YT: 'Yukon', NT: 'Northwest Territories', NU: 'Nunavut',
};
const NAME_PATTERNS = {
  ON: ['ontario'], QC: ['quebec', 'québec'], BC: ['british columbia'], AB: ['alberta'], MB: ['manitoba'],
  SK: ['saskatchewan'], NS: ['nova scotia'], NB: ['new brunswick', 'nouveau-brunswick'], NL: ['newfoundland', 'labrador'],
  PE: ['prince edward island'], YT: ['yukon'], NT: ['northwest territories'], NU: ['nunavut'],
};
const CITIES = {
  ON: ['toronto', 'ottawa', 'mississauga', 'brampton', 'waterloo', 'kitchener', 'markham', 'hamilton', 'oakville',
    'burlington', 'vaughan', 'richmond hill', 'guelph', 'kingston, on', 'london, on', 'london, ontario', 'windsor, on',
    'sudbury', 'thunder bay', 'barrie', 'oshawa', 'pickering', 'cambridge, on', 'kanata', 'scarborough', 'north york',
    'etobicoke', 'milton, on', 'peterborough', 'st. catharines', 'niagara', 'welland', 'newmarket', 'aurora', 'whitby', 'ajax'],
  QC: ['montreal', 'montréal', 'quebec city', 'ville de québec', 'laval', 'gatineau', 'sherbrooke', 'longueuil',
    'trois-rivières', 'trois-rivieres', 'boucherville', 'saint-laurent', 'dorval', 'brossard', 'lévis', 'levis'],
  BC: ['vancouver', 'burnaby', 'surrey, bc', 'richmond, bc', 'victoria, bc', 'kelowna', 'coquitlam', 'abbotsford',
    'nanaimo', 'kamloops', 'north vancouver', 'new westminster', 'langley', 'prince george'],
  AB: ['calgary', 'edmonton', 'red deer', 'lethbridge', 'fort mcmurray', 'grande prairie', 'medicine hat', 'airdrie',
    'sherwood park', 'st. albert'],
  MB: ['winnipeg', 'brandon', 'steinbach'], SK: ['regina', 'saskatoon', 'prince albert', 'moose jaw'],
  NS: ['halifax', 'dartmouth', 'sydney, ns', 'truro', 'stellarton', 'bedford, ns'],
  NB: ['moncton', 'fredericton', 'saint john', 'dieppe', 'bathurst, nb', 'florenceville'],
  NL: ["st. john's", "st john's", 'mount pearl', 'corner brook', 'gander'], PE: ['charlottetown', 'summerside'],
  YT: ['whitehorse'], NT: ['yellowknife', 'inuvik', 'hay river'], NU: ['iqaluit', 'rankin inlet', 'cambridge bay'],
};
const ABBR_RE = /(?:^|[\s,(/-])(ON|QC|PQ|BC|AB|MB|SK|NS|NB|NL|PE|PEI|YT|NT|NWT|NU)(?=$|[\s,)/.])/;
const ABBR_MAP = { PQ: 'QC', PEI: 'PE', NWT: 'NT' };
const NOT_CANADA_RE = /\b(us|u\.s\.?|usa|united states|uk|u\.k\.|united kingdom|emea|apac|latam|europe|eu|india|germany|france|spain|poland|brazil|mexico|australia|singapore|japan|ireland|netherlands|philippines|argentina|israel|portugal)\b/i;
const OPEN_RE = /\b(north america|americas|worldwide|global|anywhere)\b/i;

export function provinceOf(location) {
  if (!location) return '';
  const m = String(location).match(ABBR_RE);
  if (m) return ABBR_MAP[m[1]] || m[1];
  const low = String(location).toLowerCase();
  for (const [code, names] of Object.entries(NAME_PATTERNS)) if (names.some((n) => low.includes(n))) return code;
  for (const [code, cities] of Object.entries(CITIES)) if (cities.some((c) => low.includes(c))) return code;
  return '';
}

// True if a posting is in Canada or open to people in Canada. Blank / "3 Locations" -> true (can't tell).
export function isCanada(location) {
  const loc = String(location || '').trim();
  if (!loc || /\d+\s+locations?/i.test(loc)) return true;
  const low = loc.toLowerCase();
  if (low.includes('canada') || low.includes('canadian') || provinceOf(loc)) return true;
  if (OPEN_RE.test(loc)) return true;
  if (low.includes('remote') && !NOT_CANADA_RE.test(loc)) return true;
  return false;
}

// "ON", "BC" ... or "Remote" or "" (somewhere in Canada / not stated)
export function regionOf(location) {
  return provinceOf(location) || (/remote|anywhere|virtual|work from home/i.test(location || '') ? 'Remote' : '');
}

// ---------------------------------------------------------------- Levels (levels.py)
export const LEVELS = ['New grad', 'Entry level', 'Unspecified', 'Internship', 'Experienced', 'Senior'];
const SENIOR = /\b(senior|sr|snr|lead|leader|principal|staff|manager|mgr|director|head|vp|vice president|chief|architect|supervisor|expert|specialist iii|team lead|ii|iii|iv|level [2-5]|[2-5]\s*$)\b/i;
const INTERN = /\b(intern|interns|internship|co-?op|coop|summer student|student|work term|stagiaire|stage)\b/i;
const NEWGRAD_TITLE = /(\bnew[\s-]?grad(uate)?s?\b|\brecent grad(uate)?s?\b|\bgraduate\b|\bentry[\s-]?level\b|\bearly[\s-]?career\b|\bearly[\s-]?talent\b|\bjunior\b|\bjr\b|\bcampus\b|\bfreshers?\b|\buniversity (hire|graduate|recruit)|\brotational\b|\bdevelopment program|\bleadership program|\btrainee\b|\bapprentice\b|\b(analyst|associate) program\b|\bclass of 202[6-8]\b|\b202[6-8]\b|\banalyst i\b|\bassociate\b|\blevel 1\b|\b1\s*$|\bi\s*$)/i;
const NEWGRAD_DESC = /\b(new grad(uate)?s?|recent (university |college )?grad(uate)?s?|graduating (in|by|this)|entry[\s-]?level|early[\s-]?career|early[\s-]?experience|freshers?|no (prior )?experience (is )?required|0\s*[-–to]+\s*[12]\s*years?|less than (2|two) years|under (2|two) years|class of 202[6-8]|(april|may|june|spring|summer) 202[67] (grad|start)|(expected|anticipated) graduation)\b/i;
const NUM_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const N = '(\\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)';
const YEARS = new RegExp(`(?:minimum (?:of )?|at least |min\\.? )?${N}\\s*(?:\\+|plus)?\\s*(?:(?:-|–|to)\\s*${N}\\s*)?\\+?\\s*(?:or more\\s*)?years?(?:'|’)?(?:\\s+of)?\\s+(?:[\\w/&,-]+\\s+){0,6}?(?:experience|exp\\b)`, 'gi');

// Largest "N years of experience" minimum in the text, or null.
export function yearsRequired(text) {
  const found = [];
  for (const m of String(text || '').matchAll(YEARS)) {
    const raw = m[1].toLowerCase();
    const n = /^\d+$/.test(raw) ? Number(raw) : NUM_WORDS[raw];
    if (n != null && n >= 0 && n <= 15) found.push(n);
  }
  return found.length ? Math.max(...found) : null;
}
export const hasNewGradWording = (text) => NEWGRAD_DESC.test(String(text || ''));

// years / newGradDesc come from the posting description (worked out by the scanner)
export function classify(title, years, newGradDesc, maxYears = 2) {
  const t = String(title || '');
  if (INTERN.test(t)) return 'Internship';
  const ngTitle = NEWGRAD_TITLE.test(t);
  if (SENIOR.test(t) && !/\b(new grad|graduate|entry level|junior|jr)\b/i.test(t)) return 'Senior';
  if (ngTitle) return 'New grad';
  if (years != null && years > maxYears) return 'Experienced';
  if (newGradDesc) return 'New grad';
  if (years != null) return 'Entry level';
  return 'Unspecified';
}
export const isSeniorTitle = (title) => SENIOR.test(title) && !/\b(new grad|graduate|entry level|junior|jr)\b/i.test(title) && !INTERN.test(title);

// ---------------------------------------------------------------- Title matching (checker.py)
const ABBREV = { sr: 'senior', jr: 'junior', mgr: 'manager', eng: 'engineer', engr: 'engineer', dev: 'developer',
  assoc: 'associate', admin: 'administrator', mktg: 'marketing', acct: 'accountant', dir: 'director', vp: 'vice president',
  svp: 'senior vice president', ops: 'operations', qa: 'quality assurance', hr: 'human resources', pm: 'product manager',
  swe: 'software engineer', bi: 'business intelligence' };
const STOP = new Set(['and', 'of', 'the', 'a', 'an', 'to', 'for', 'in', 'at', 'with']);
const GENERIC_WORDS = new Set(['new', 'grad', 'graduate', 'junior', 'entry', 'level', 'early', 'career', 'associate', 'program', 'campus', 'i', 'analyst']);

export function words(text) {
  const out = new Set();
  for (let w of String(text || '').toLowerCase().match(/[a-z0-9+#]+/g) || []) {
    w = ABBREV[w] || w;
    for (const x of w.split(' ')) if (!STOP.has(x)) out.add(x);
  }
  return out;
}
const subset = (a, b) => { for (const x of a) if (!b.has(x)) return false; return true; };

// Every word of the target appears in the posting title, any order ("Operations AND Coordinator" works too).
export function titleMatches(jobTitle, target, exclude = []) {
  const jw = words(jobTitle), tw = words(target);
  if (!tw.size || !subset(tw, jw) || String(jobTitle).length > 150) return false;
  return !exclude.some((e) => { const ew = words(e); return ew.size && subset(ew, jw) && !subset(ew, tw); });
}

// Best (most specific) matching title, or null.
export function bestTitle(jobTitle, targets, exclude = []) {
  let best = null, bestKey = null;
  for (const t of targets) {
    if (!titleMatches(jobTitle, t, exclude)) continue;
    const w = words(t);
    const key = [[...w].filter((x) => !GENERIC_WORDS.has(x)).length, w.size];
    if (!best || key[0] > bestKey[0] || (key[0] === bestKey[0] && key[1] > bestKey[1])) { best = t; bestKey = key; }
  }
  return best;
}

// titles.txt: "# Heading" lines are categories, other lines are titles.
export function parseTitles(text) {
  const titles = [], category = {};
  let cur = '';
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      const head = line.replace(/^#+/, '').trim();
      if (head && head.length < 60 && !/^(lines |a posting|one job|jobwatch|talentpulse|the website|seniority)/i.test(head)) cur = head.split('(')[0].trim();
      continue;
    }
    if (!titles.some((t) => t.toLowerCase() === line.toLowerCase())) { titles.push(line); category[line] = cur; }
  }
  return { titles, category };
}

// ---------------------------------------------------------------- CSV (employers.csv)
export function parseCSV(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  const s = String(text).replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && s[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const head = (rows.shift() || []).map((h) => h.trim().toLowerCase());
  return rows.filter((r) => r.some((c) => c.trim())).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] || '').trim()])));
}
