// TalentPulse website. Runs entirely in your browser: resume -> titles -> search -> openings.
import { parseTitles, parseCSV, words, bestTitle, classify, LEVELS, PROVINCE_NAMES } from './core.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => Number(n || 0).toLocaleString('en-CA');
const store = {
  get(k, d) { try { const v = localStorage.getItem(`talentpulse:${k}`); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`talentpulse:${k}`, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  del(k) { try { localStorage.removeItem(`talentpulse:${k}`); } catch { /* ignore */ } },
};
const LEVEL_INFO = {
  'New grad': { c: '#E8BE5C', d: 'Says new grad, graduate program, entry level, junior, early career, fresher…' },
  'Entry level': { c: '#5FD0B8', d: 'Asks for a few years of experience, within your limit' },
  'Unspecified': { c: '#8FA3B1', d: 'No seniority stated — often worth a look' },
  'Internship': { c: '#9B8CE8', d: 'Intern, co-op, summer student' },
  'Experienced': { c: '#6AA9F0', d: 'Asks for more years than your limit' },
  'Senior': { c: '#E5604F', d: 'Senior, Lead, Manager, Director, level II+…' },
};
const REGIONS = ['ON', 'QC', 'BC', 'AB', 'MB', 'SK', 'NS', 'NB', 'NL', 'PE', 'YT', 'NT', 'NU', 'Remote', '?'];
const REGION_LABEL = { ...PROVINCE_NAMES, Remote: 'Remote (Canada)', '?': 'Location not stated' };
const TILE_POS = { YT: [0, 1], NT: [0, 2], NU: [0, 3], BC: [1, 0], AB: [1, 1], SK: [1, 2], MB: [1, 3], ON: [1, 4], QC: [1, 5], NL: [1, 6],
  NB: [2, 5], PE: [2, 6], NS: [2, 7], Remote: [2, 0], '?': [2, 1] };
const SKILLS = ['sql', 'python', 'r', 'excel', 'power bi', 'tableau', 'sas', 'spss', 'alteryx', 'looker', 'qlik', 'power query', 'dax',
  'vba', 'azure', 'aws', 'gcp', 'snowflake', 'databricks', 'sap', 'salesforce', 'jira', 'confluence', 'servicenow', 'workday', 'oracle',
  'etl', 'data modeling', 'data visualization', 'dashboard', 'reporting', 'forecasting', 'statistics', 'machine learning', 'a/b testing',
  'agile', 'scrum', 'requirements gathering', 'process improvement', 'lean', 'six sigma', 'stakeholder management', 'project management',
  'financial modeling', 'budgeting', 'risk management', 'fraud', 'compliance', 'aml', 'kyc', 'crm', 'google analytics', 'hubspot',
  'supply chain', 'inventory', 'procurement', 'erp', 'customer service', 'communication', 'leadership'];

const S = {
  data: null, employersCsv: [], starter: '', resume: null,
  titlesText: '', titles: [], category: {}, selected: new Set(),
  levels: new Set(['New grad', 'Entry level', 'Unspecified']), maxYears: 2, provs: new Set(), exclude: '',
  results: [], byEmployer: new Map(), view: { q: '', sort: 'new', newOnly: false, prov: '', level: '', emp: '', cat: '' }, limit: 60,
  empLimit: 100, searched: false, jobWords: null,
};

// ------------------------------------------------------------------ load
// On GitHub Pages the newest scan results are read straight from the repository, so they show up as
// soon as the daily scan saves them (no waiting for the website to be rebuilt).
const GH = (() => {
  const m = location.hostname.match(/^([^.]+)\.github\.io$/i);
  if (!m) return null;
  const seg = location.pathname.split('/').filter(Boolean)[0];
  return { owner: m[1], repo: seg && !/\.html?$/i.test(seg) ? seg : `${m[1]}.github.io` };
})();
const RAW = GH ? `https://raw.githubusercontent.com/${GH.owner}/${GH.repo}/HEAD/` : '';
async function loadText(name) {
  if (RAW) {
    try { const r = await fetch(`${RAW}${name}?t=${Date.now()}`, { cache: 'no-store' }); if (r.ok) return await r.text(); } catch { /* fall back to the site copy */ }
  }
  const r = await fetch(name, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`${name} ${r.status}`);
  return r.text();
}
async function init() {
  const [jobs, titles, emps] = await Promise.allSettled([loadText('jobs.json'), loadText('titles.txt'), loadText('employers.csv')]);
  try { S.data = jobs.status === 'fulfilled' ? JSON.parse(jobs.value) : null; } catch { S.data = null; }
  S.data ||= { generatedAt: null, employers: [], jobs: [] };
  S.starter = titles.status === 'fulfilled' ? titles.value : '';
  S.employersCsv = emps.status === 'fulfilled' ? parseCSV(emps.value) : [];
  setTitlesText(store.get('titlesText', null) ?? S.starter, false);
  const sel = store.get('selected', null);
  S.selected = new Set(sel ? sel.filter((t) => S.titles.includes(t)) : S.titles);
  const f = store.get('filters', null);
  if (f) { S.levels = new Set(f.levels); S.maxYears = f.maxYears; S.provs = new Set(f.provs); S.exclude = f.exclude || ''; }
  S.resume = store.get('resume', null);
  renderHeader(jobs.status === 'rejected');
  checkSetup();
  renderHero();
  renderResume();
  renderTitles();
  renderFilters();
  go(location.hash.slice(1) || (S.resume ? 'titles' : 'resume'), true);
}

function activeEmployers() { return S.employersCsv.filter((e) => !['0', 'false', 'no'].includes(String(e.active).toLowerCase())); }

function renderHeader(failed) {
  const d = S.data;
  S.scanLink = GH ? `https://github.com/${GH.owner}/${GH.repo}/actions/workflows/talentpulse.yml` : null;
  const run = S.scanLink ? ` · <a href="${S.scanLink}" target="_blank" rel="noopener">Run a new scan ↗</a>` : '';
  if (failed && location.protocol === 'file:') { $('#scanInfo').innerHTML = 'Open this site from GitHub Pages — browsers block reading data files from a double-clicked page.'; return; }
  if (!d.generatedAt) { $('#scanInfo').innerHTML = `No scan yet${run}`; return; }
  const read = d.employers.filter((e) => e.s === 'ok').length;
  $('#scanInfo').innerHTML = `Career sites scanned <b>${new Date(d.generatedAt).toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' })}</b><br>${fmt(read)} job boards read · ${fmt(d.jobs.length)} openings in Canada${run}`;
}

function renderHero() {
  const n = activeEmployers().length || S.data.employers.length;
  $('#heroEmployers').textContent = fmt(n);
  $('#runEmployers').textContent = fmt(n);
  const d = S.data;
  const boards = d.employers.filter((e) => e.s === 'ok').length;
  $('#heroStats').innerHTML = [
    [fmt(n), 'employers on your list'],
    [d.generatedAt ? fmt(boards) : '—', 'job boards read in the last scan'],
    [d.generatedAt ? fmt(d.jobs.length) : '—', 'openings in Canada right now'],
    [fmt(S.titles.length), 'job titles in your list'],
  ].map(([b, s]) => `<div class="hstat"><b>${b}</b><span>${s}</span></div>`).join('');
}

// ------------------------------------------------------------------ one-time setup helper
// GitHub only runs scan settings kept in a hidden ".github/workflows" folder, which its drag-and-drop
// uploader skips. This card opens GitHub's "new file" page with that file already named and filled in.
async function checkSetup() {
  const box = $('#setup');
  if (!GH || S.data.generatedAt) { box.hidden = true; return; }
  const api = `https://api.github.com/repos/${GH.owner}/${GH.repo}`;
  const repoUrl = `https://github.com/${GH.owner}/${GH.repo}`;
  let branch = 'main', workflow = null, run = null;
  // Read a repository file fresh through GitHub's API (the raw-file service can lag a few minutes after a change).
  const ghFile = async (filePath) => {
    try {
      const r = await fetch(`${api}/contents/${filePath}?ref=${branch}&t=${Date.now()}`, { cache: 'no-store' });
      if (r.ok) { const j = await r.json(); if (j.content) return new TextDecoder().decode(Uint8Array.from(atob(j.content.replace(/\s/g, '')), (c) => c.charCodeAt(0))); }
    } catch { /* fall back below */ }
    return loadText(filePath);
  };
  try { const r = await fetch(api); if (r.ok) branch = (await r.json()).default_branch || 'main'; } catch { /* use main */ }
  try { const r = await fetch(`${api}/actions/workflows`); if (r.ok) workflow = ((await r.json()).workflows || []).find((w) => /talentpulse/i.test(w.path)) || false; } catch { /* unknown */ }
  let fast = true;
  if (workflow) {
    try { const r = await fetch(`${api}/actions/workflows/${workflow.id}/runs?per_page=1`); if (r.ok) run = ((await r.json()).workflow_runs || [])[0] || null; } catch { /* unknown */ }
    try { fast = /matrix:/.test(await ghFile('.github/workflows/talentpulse.yml')); } catch { /* assume it's fine */ }
  }
  const ago = (t) => { const m = Math.max(0, Math.round((Date.now() - Date.parse(t)) / 60000)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };
  box.hidden = false;
  if (!workflow) {
    let yml = '';
    try { yml = await ghFile('talentpulse-workflow.yml'); } catch { /* button still opens the page */ }
    const newUrl = `${repoUrl}/new/${branch}?filename=${encodeURIComponent('.github/workflows/talentpulse.yml')}&value=${encodeURIComponent(yml)}`;
    box.innerHTML = `<div class="setup-icon">1</div><div class="setup-body"><h3>Last step: turn on the daily career-site scan</h3>
      <p>Click the button. GitHub opens with the scan settings already filled in. Just click the green <b>Commit changes</b> button, then <b>Commit changes</b> again in the box that pops up. The first scan starts by itself and takes about 1–2 hours.</p>
      <div class="row"><a class="btn primary" href="${esc(newUrl)}" target="_blank" rel="noopener">Turn on the daily scan ↗</a>
      <button class="btn ghost sm" id="copyYml">Copy the settings text</button><button class="btn ghost sm" id="recheck">I did it, check again</button></div>
      <p class="muted small">If GitHub shows an empty file instead: click “Copy the settings text”, then on GitHub choose Add file → Create new file, type <code>.github/workflows/talentpulse.yml</code> as the name, paste, and commit.</p></div>`;
    $('#copyYml').addEventListener('click', async (e) => { try { await navigator.clipboard.writeText(yml); e.target.textContent = 'Copied ✓'; } catch { e.target.textContent = 'Copy failed'; } });
  } else if (!fast) { // the older one-machine scan settings: offer the 10-part version
    let yml = '';
    try { yml = await ghFile('talentpulse-workflow.yml'); } catch { /* checked below */ }
    if (!/matrix:/.test(yml)) { try { const r = await fetch(`talentpulse-workflow.yml?t=${Date.now()}`, { cache: 'no-store' }); if (r.ok) yml = await r.text(); } catch { /* checked below */ } }
    const ready = /matrix:/.test(yml);
    const running = run && ['in_progress', 'queued', 'waiting', 'requested', 'pending'].includes(run.status);
    box.innerHTML = `<div class="setup-icon">⚡</div><div class="setup-body"><h3>Switch to the fast scan (10 parts at the same time)</h3>
      <p>${running ? `A slower scan is running now (started ${ago(run.run_started_at || run.created_at)} ago). Switching stops it and starts the fast one, which usually takes 15–30 minutes.` : 'The fast scan checks all employers in 10 parts at once and usually takes 15–30 minutes.'}</p>
      <p><b>1.</b> Click <b>Copy the new settings</b>. <b>2.</b> Click <b>Open the scan settings on GitHub</b>. <b>3.</b> Click inside GitHub's editor, press <b>Ctrl+A</b>, then <b>Ctrl+V</b>, and click <b>Commit changes</b>, then <b>Commit changes</b> again.</p>
      <div class="row"><button class="btn primary" id="copyYml">Copy the new settings</button>
      <a class="btn" href="${repoUrl}/edit/${branch}/.github/workflows/talentpulse.yml" target="_blank" rel="noopener">Open the scan settings on GitHub ↗</a>
      <button class="btn ghost sm" id="recheck">I did it, check again</button></div></div>`;
    $('#copyYml').addEventListener('click', async (e) => {
      if (!ready) { e.target.textContent = 'Not ready yet: upload the new files, wait a minute, refresh'; return; }
      try { await navigator.clipboard.writeText(yml); e.target.textContent = 'Copied ✓'; } catch { e.target.textContent = 'Copy failed'; }
    });
  } else if (run && ['in_progress', 'queued', 'waiting', 'requested', 'pending'].includes(run.status)) {
    box.innerHTML = `<div class="setup-icon spin">↻</div><div class="setup-body"><h3>The career-site scan is running</h3>
      <p>Started ${ago(run.run_started_at || run.created_at)} ago. It checks all ${fmt(activeEmployers().length)} employers in 10 parts at the same time, which usually takes 15–30 minutes. You can upload your resume and choose titles now; the openings appear when it finishes.</p>
      <div class="row"><a class="btn ghost sm" href="${esc(run.html_url)}" target="_blank" rel="noopener">Watch it run ↗</a><button class="btn ghost sm" id="recheck">Check again</button></div></div>`;
  } else if (run && run.status === 'completed' && run.conclusion !== 'success') {
    box.innerHTML = `<div class="setup-icon warn">!</div><div class="setup-body"><h3>The scan stopped with an error</h3>
      <p>Open it, click the step with the red ✗, and send a screenshot so it can be fixed. You can also start it again with <b>Re-run jobs</b>.</p>
      <div class="row"><a class="btn primary" href="${esc(run.html_url)}" target="_blank" rel="noopener">Open the scan ↗</a><button class="btn ghost sm" id="recheck">Check again</button></div></div>`;
  } else if (run && run.status === 'completed') {
    box.innerHTML = `<div class="setup-icon ok">✓</div><div class="setup-body"><h3>The scan finished</h3><p>Its results can take a few minutes to appear. Refresh this page shortly.</p>
      <div class="row"><button class="btn primary sm" id="recheck">Refresh now</button></div></div>`;
  } else {
    box.innerHTML = `<div class="setup-icon">2</div><div class="setup-body"><h3>The scan is set up. Start the first one</h3>
      <p>Open the scan page, click <b>Run workflow</b> on the right, then the green <b>Run workflow</b> button.</p>
      <div class="row"><a class="btn primary" href="${repoUrl}/actions/workflows/talentpulse.yml" target="_blank" rel="noopener">Open the scan page ↗</a><button class="btn ghost sm" id="recheck">Check again</button></div></div>`;
  }
  $('#recheck')?.addEventListener('click', () => location.reload());
}

// ------------------------------------------------------------------ navigation
function go(view, initial) {
  if (!['resume', 'titles', 'results', 'employers'].includes(view)) view = 'resume';
  if (view === 'results' && !S.searched) view = 'titles';
  $$('.view').forEach((v) => { v.hidden = v.id !== `view-${view}`; });
  $$('#stepNav button').forEach((b) => {
    b.classList.toggle('on', b.dataset.go === view);
    b.classList.toggle('done', (b.dataset.go === 'resume' && !!S.resume) || (b.dataset.go === 'titles' && S.searched));
  });
  $('#stepNav [data-go=results]').disabled = !S.searched;
  if (view === 'employers') renderEmployers();
  if (location.hash.slice(1) !== view) history.replaceState(null, '', `#${view}`);
  if (!initial) window.scrollTo({ top: 0, behavior: 'smooth' });
}
$('#stepNav').addEventListener('click', (e) => { const b = e.target.closest('[data-go]'); if (b && !b.disabled) go(b.dataset.go); });
$('#homeLink').addEventListener('click', (e) => { e.preventDefault(); go('resume'); });

// ------------------------------------------------------------------ step 1: resume
async function readResume(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  const buf = await file.arrayBuffer();
  if (ext === 'pdf') {
    const pdfjs = await import('./pdf.min.js');
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('./pdf.worker.min.js', import.meta.url).href;
    const doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
    let text = '';
    for (let p = 1; p <= doc.numPages; p++) {
      const c = await (await doc.getPage(p)).getTextContent();
      let lastY = null;
      for (const it of c.items) {
        const y = it.transform?.[5];
        if (lastY !== null && y !== undefined && Math.abs(y - lastY) > 2 && !text.endsWith('\n')) text += '\n';
        text += it.str + (it.hasEOL ? '\n' : ' ');
        if (y !== undefined) lastY = y;
      }
      text += '\n';
    }
    return { name: file.name, text };
  }
  if (ext === 'docx') {
    if (!window.mammoth) throw new Error('The Word reader did not load — try a PDF.');
    return { name: file.name, text: (await window.mammoth.extractRawText({ arrayBuffer: buf })).value };
  }
  if (ext === 'doc') throw new Error('Old .doc files are not supported — save as .docx or PDF.');
  return { name: file.name, text: new TextDecoder().decode(buf) };
}
const normText = (s) => ` ${String(s).toLowerCase().replace(/[^a-z0-9+#]+/g, ' ')} `;
function resumeTitleHits() {
  if (!S.resume) return { exact: new Set(), loose: new Set() };
  const nt = normText(S.resume.text), rw = words(S.resume.text);
  const exact = new Set(), loose = new Set();
  for (const t of S.titles) {
    if (/\band\b/i.test(t) && /[A-Z]{3}/.test(t)) { if ([...words(t)].every((w) => rw.has(w))) loose.add(t); continue; }
    if (nt.includes(normText(t))) exact.add(t);
    else if ([...words(t)].every((w) => rw.has(w))) loose.add(t);
  }
  return { exact, loose };
}
function renderResume() {
  const r = S.resume;
  $('#resumeSummary').hidden = !r;
  $('#drop').classList.toggle('compact', !!r);
  $('#dropTitle').textContent = r ? 'Replace resume' : 'Drop your resume here, or click to choose';
  $('#dropSub').textContent = r ? 'PDF, Word or text' : 'PDF, Word (.docx) or text · read in your browser, never uploaded';
  $('#toTitles').disabled = !r;
  $('#selResume').hidden = !r;
  if (!r) return;
  $('#resumeName').textContent = `✓ ${r.name}`;
  const { exact, loose } = resumeTitleHits();
  $('#resumeTitles').innerHTML = [...exact].map((t) => `<span class="chip hl">★ ${esc(t)}</span>`).join('') +
    [...loose].slice(0, 14).map((t) => `<span class="chip">${esc(t)}</span>`).join('') || '<span class="muted small">None of your titles appear word-for-word — that’s fine, pick them in the next step.</span>';
  const low = normText(r.text);
  $('#resumeSkills').innerHTML = SKILLS.filter((s) => low.includes(` ${s.replace(/[^a-z0-9+#]+/g, ' ')} `)).map((s) => `<span class="chip">${esc(s)}</span>`).join('') || '<span class="muted small">—</span>';
}
async function handleFile(f) {
  if (!f) return;
  $('#dropTitle').textContent = `Reading ${f.name}…`;
  try {
    S.resume = await readResume(f);
    if (S.resume.text.replace(/\s/g, '').length < 80) throw new Error('Almost no text could be read — the file may be a scanned image.');
    store.set('resume', S.resume);
    renderResume(); renderTitles();
  } catch (e) { S.resume = null; renderResume(); $('#dropTitle').textContent = 'Could not read that file'; $('#dropSub').textContent = e.message; }
}
const drop = $('#drop');
$('#resumeFile').addEventListener('change', (e) => handleFile(e.target.files[0]));
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => handleFile(e.dataTransfer.files[0]));
$('#removeResume').addEventListener('click', () => { S.resume = null; store.del('resume'); $('#resumeFile').value = ''; renderResume(); renderTitles(); });
$('#toTitles').addEventListener('click', () => go('titles'));
$('#skipResume').addEventListener('click', () => go('titles'));

// ------------------------------------------------------------------ step 2: titles & filters
function setTitlesText(text, save = true) {
  S.titlesText = text;
  const p = parseTitles(text);
  S.titles = p.titles; S.category = p.category;
  if (save) store.set('titlesText', text);
}
function saveSelected() { store.set('selected', [...S.selected]); $('#selCount').textContent = S.selected.size; }
function renderTitles() {
  const { exact } = resumeTitleHits();
  const groups = new Map();
  for (const t of S.titles) { const c = S.category[t] || 'My titles'; if (!groups.has(c)) groups.set(c, []); groups.get(c).push(t); }
  $('#titleGroups').innerHTML = [...groups].map(([cat, list]) => `<div class="tgroup"><div class="tgroup-head"><h4>${esc(cat)}</h4>
      <button class="link" data-gall="${esc(cat)}">all</button><button class="link" data-gnone="${esc(cat)}">none</button></div>
      ${list.map((t) => `<button class="tchip ${S.selected.has(t) ? 'on' : ''}" data-t="${esc(t)}">${exact.has(t) ? '<span class="star" title="In your resume">★</span>' : ''}${esc(t)}<span class="x" data-rm="${esc(t)}" title="Remove from list">×</span></button>`).join('')}</div>`).join('')
    || '<p class="muted">Your list is empty — add a title above.</p>';
  saveSelected();
}
$('#titleGroups').addEventListener('click', (e) => {
  const rm = e.target.closest('[data-rm]');
  if (rm) {
    e.stopPropagation();
    const t = rm.dataset.rm;
    setTitlesText(S.titlesText.split(/\r?\n/).filter((l) => l.trim() !== t).join('\n'));
    S.selected.delete(t); renderTitles(); return;
  }
  const g = e.target.closest('[data-gall],[data-gnone]');
  if (g) {
    const cat = g.dataset.gall ?? g.dataset.gnone;
    S.titles.filter((t) => (S.category[t] || 'My titles') === cat).forEach((t) => (g.dataset.gall !== undefined ? S.selected.add(t) : S.selected.delete(t)));
    renderTitles(); return;
  }
  const b = e.target.closest('[data-t]'); if (!b) return;
  S.selected.has(b.dataset.t) ? S.selected.delete(b.dataset.t) : S.selected.add(b.dataset.t);
  b.classList.toggle('on'); saveSelected();
});
function addTitle() {
  const v = $('#newTitle').value.trim(); if (!v) return;
  const add = v.split(/[;\n]/).map((x) => x.trim()).filter((x) => x && !S.titles.some((t) => t.toLowerCase() === x.toLowerCase()));
  if (add.length) {
    const hasMine = /^#\s*My titles\s*$/m.test(S.titlesText);
    setTitlesText(hasMine ? S.titlesText.replace(/^#\s*My titles\s*$/m, (m) => `${m}\n${add.join('\n')}`) : `# My titles\n${add.join('\n')}\n\n${S.titlesText}`);
    add.forEach((t) => S.selected.add(t));
  }
  $('#newTitle').value = ''; renderTitles(); renderHero();
}
$('#addTitle').addEventListener('click', addTitle);
$('#newTitle').addEventListener('keydown', (e) => { if (e.key === 'Enter') addTitle(); });
$('#selAll').addEventListener('click', () => { S.selected = new Set(S.titles); renderTitles(); });
$('#selNone').addEventListener('click', () => { S.selected = new Set(); renderTitles(); });
$('#selResume').addEventListener('click', () => { const h = resumeTitleHits(); S.selected = new Set([...h.exact, ...h.loose]); renderTitles(); });
$('#editList').addEventListener('click', () => { $('#listText').value = S.titlesText; $('#listEditor').hidden = false; $('#listText').focus(); });
$('#cancelList').addEventListener('click', () => { $('#listEditor').hidden = true; });
$('#resetList').addEventListener('click', () => { $('#listText').value = S.starter; });
$('#saveList').addEventListener('click', () => {
  const before = new Set(S.titles);
  setTitlesText($('#listText').value);
  S.selected = new Set(S.titles.filter((t) => S.selected.has(t) || !before.has(t)));
  $('#listEditor').hidden = true; renderTitles(); renderHero();
});

function saveFilters() { store.set('filters', { levels: [...S.levels], maxYears: S.maxYears, provs: [...S.provs], exclude: S.exclude }); }
function renderFilters() {
  $('#levelToggles').innerHTML = LEVELS.map((l) => `<div class="lt ${S.levels.has(l) ? 'on' : ''}" data-lv="${l}"><i style="background:${LEVEL_INFO[l].c}"></i><div><b>${l}</b><span>${LEVEL_INFO[l].d}</span></div></div>`).join('');
  $('#maxYears').value = S.maxYears; $('#maxYearsVal').textContent = S.maxYears;
  $('#provPick').innerHTML = `<button data-p="" class="${S.provs.size ? '' : 'on'}">All of Canada</button>` +
    REGIONS.map((p) => `<button data-p="${p}" class="${S.provs.has(p) ? 'on' : ''}" title="${esc(REGION_LABEL[p])}">${p === '?' ? 'Not stated' : p}</button>`).join('');
  $('#excludeWords').value = S.exclude;
  $('#noScanMsg').hidden = !!S.data.generatedAt;
  $('#dataAge').innerHTML = S.data.generatedAt ? `Uses the career-site scan from ${new Date(S.data.generatedAt).toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' })}. It refreshes every morning.` : '';
}
$('#levelToggles').addEventListener('click', (e) => { const b = e.target.closest('[data-lv]'); if (!b) return; const l = b.dataset.lv; S.levels.has(l) ? S.levels.delete(l) : S.levels.add(l); saveFilters(); renderFilters(); });
$('#maxYears').addEventListener('input', (e) => { S.maxYears = Number(e.target.value); $('#maxYearsVal').textContent = S.maxYears; saveFilters(); });
$('#provPick').addEventListener('click', (e) => { const b = e.target.closest('[data-p]'); if (!b) return; const p = b.dataset.p; if (!p) S.provs.clear(); else S.provs.has(p) ? S.provs.delete(p) : S.provs.add(p); saveFilters(); renderFilters(); });
$('#excludeWords').addEventListener('change', (e) => { S.exclude = e.target.value; saveFilters(); });

// ------------------------------------------------------------------ search
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function runSearch() {
  if (!S.selected.size) { alert('Pick at least one job title first.'); return; }
  if (!S.data.generatedAt) { // nothing has been collected yet: point at the setup box instead of showing zeros
    $('#noScanMsg').hidden = false;
    const box = $('#setup');
    if (!box.hidden) { box.scrollIntoView({ behavior: 'smooth', block: 'start' }); box.classList.remove('attention'); void box.offsetWidth; box.classList.add('attention'); }
    return;
  }
  const d = S.data;
  $$('.view').forEach((v) => { v.hidden = v.id !== 'view-searching'; });
  window.scrollTo({ top: 0 });
  const exclude = S.exclude.split(',').map((x) => x.trim()).filter(Boolean);
  const targets = S.titles.filter((t) => S.selected.has(t));
  const byEmp = new Map();
  d.jobs.forEach((j, i) => { if (!byEmp.has(j[0])) byEmp.set(j[0], []); byEmp.get(j[0]).push(i); });
  const emps = activeEmployers().length ? activeEmployers().map((e) => e.company) : d.employers.map((e) => e.n);
  const idxByName = new Map(d.employers.map((e, i) => [e.n, i]));
  const results = [];
  const total = emps.length || 1;
  let read = 0;
  const started = performance.now();
  const minMs = Math.min(4500, 1200 + total * 1.2);
  const tick = $('#sTicker'); tick.innerHTML = '';
  const chunk = Math.max(10, Math.ceil(total / 90));
  for (let k = 0; k < emps.length; k += chunk) {
    for (const name of emps.slice(k, k + chunk)) {
      const ei = idxByName.get(name);
      const list = ei == null ? [] : byEmp.get(ei) || [];
      read += list.length;
      let hits = 0;
      for (const ji of list) {
        const j = d.jobs[ji];
        const m = bestTitle(j[1], targets, exclude);
        if (!m) continue;
        const level = classify(j[1], j[6], !!j[7], S.maxYears);
        if (!S.levels.has(level)) continue;
        const region = j[3] || '?';
        if (S.provs.size && !S.provs.has(region)) continue;
        results.push({ e: ei, title: j[1], loc: j[2], region, url: j[4], posted: j[5], years: j[6], seen: j[8], match: m, cat: S.category[m] || 'My titles', level });
        hits++;
      }
      if (hits) { tick.insertAdjacentHTML('afterbegin', `<div>${esc(name)} — <b>${hits} match${hits > 1 ? 'es' : ''}</b></div>`); while (tick.children.length > 8) tick.lastChild.remove(); }
    }
    const done = Math.min(total, k + chunk);
    $('#sProg').style.width = `${(done / total) * 100}%`;
    $('#sEmp').textContent = fmt(done); $('#sJobs').textContent = fmt(read); $('#sHits').textContent = fmt(results.length);
    const target = (minMs * done) / total;
    const el = performance.now() - started;
    await sleep(Math.max(0, target - el));
  }
  S.results = results; S.searched = true; S.limit = 60;
  S.view = { q: '', sort: 'new', newOnly: false, prov: '', level: '', emp: '', cat: '' };
  $('#q').value = ''; $('#newOnly').checked = false; $$('#sortSeg button').forEach((b) => b.classList.toggle('on', b.dataset.sort === 'new'));
  await sleep(250);
  go('results');
  renderResults();
}
$('#runSearch').addEventListener('click', runSearch);

// ------------------------------------------------------------------ results
const dayMs = 864e5;
const today = () => new Date(new Date().toISOString().slice(0, 10));
const ageDays = (iso) => (iso ? (today() - new Date(iso)) / dayMs : Infinity);
const isNew = (r) => ageDays(r.posted || r.seen) <= 7;
const LEVEL_RANK = Object.fromEntries(LEVELS.map((l, i) => [l, i]));
function empName(i) { return S.data.employers[i]?.n || ''; }

function filtered() {
  const v = S.view, q = v.q.toLowerCase();
  let list = S.results.filter((r) => (!v.prov || r.region === v.prov) && (!v.level || r.level === v.level) && (v.emp === '' || r.e === v.emp) &&
    (!v.cat || r.cat === v.cat) && (!v.newOnly || isNew(r)) && (!q || `${r.title} ${empName(r.e)} ${r.loc}`.toLowerCase().includes(q)));
  const dateOf = (r) => r.posted || r.seen || '';
  if (v.sort === 'new') list.sort((a, b) => dateOf(b).localeCompare(dateOf(a)) || LEVEL_RANK[a.level] - LEVEL_RANK[b.level]);
  else if (v.sort === 'level') list.sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level] || dateOf(b).localeCompare(dateOf(a)));
  else list.sort((a, b) => empName(a.e).localeCompare(empName(b.e)) || a.title.localeCompare(b.title));
  return list;
}

function renderResults() {
  const all = S.results;
  const list = filtered();
  const empCount = new Set(list.map((r) => r.e)).size;
  const grad = list.filter((r) => r.level === 'New grad' || r.level === 'Entry level').length;
  const fresh = list.filter(isNew).length;
  $('#kpis').innerHTML = [
    [fmt(list.length), 'openings match your titles', 'var(--teal)'],
    [fmt(grad), 'new grad or entry level', 'var(--gold)'],
    [fmt(empCount), 'employers hiring for them', 'var(--text)'],
    [fmt(fresh), 'posted or found this week', 'var(--red)'],
  ].map(([b, s, c]) => `<div class="kpi" style="--c:${c}"><b>${b}</b><span>${s}</span></div>`).join('');
  drawMap(list);
  bars('#levelChart', countBy(list, (r) => r.level), (k) => LEVEL_INFO[k]?.c, 'level', LEVELS);
  const emp = countBy(list, (r) => r.e);
  bars('#empChart', emp, () => 'var(--blue)', 'emp', null, 10, (k) => empName(Number(k)));
  bars('#catChart', countBy(list, (r) => r.cat), () => 'var(--violet)', 'cat', null, 8);
  drawTimeline(list);
  const chips = [];
  if (S.view.prov) chips.push(['prov', REGION_LABEL[S.view.prov] || S.view.prov]);
  if (S.view.level) chips.push(['level', S.view.level]);
  if (S.view.emp !== '') chips.push(['emp', empName(S.view.emp)]);
  if (S.view.cat) chips.push(['cat', S.view.cat]);
  $('#activeFilters').innerHTML = chips.map(([k, l]) => `<span class="af" data-clear="${k}">${esc(l)}</span>`).join('');
  $('#resultList').innerHTML = list.slice(0, S.limit).map(card).join('');
  $('#more').hidden = list.length <= S.limit;
  $('#more').textContent = `Show more (${fmt(list.length - S.limit)} left)`;
  const empty = $('#resultEmpty');
  empty.hidden = list.length > 0;
  if (!list.length) {
    empty.innerHTML = !S.data.generatedAt
      ? `<b>No career-site scan has run yet.</b>Use the box at the top of this page to turn on the daily scan. The first scan takes about 1–2 hours; then search again.`
      : all.length ? '<b>Nothing matches these filters.</b>Clear a filter above.'
        : '<b>No openings match your titles and experience settings right now.</b>Try more titles, turn on more levels (e.g. Unspecified or Experienced), raise the years limit, or widen the location.';
  }
}
function countBy(list, fn) { const m = new Map(); for (const r of list) { const k = fn(r); m.set(k, (m.get(k) || 0) + 1); } return m; }
function bars(sel, counts, color, key, order, top = 12, label = (k) => k) {
  let items = order ? order.map((k) => [k, counts.get(k) || 0]).filter(([k, v]) => v || S.levels.has(k)) : [...counts].sort((a, b) => b[1] - a[1]).slice(0, top);
  const max = Math.max(1, ...items.map(([, v]) => v));
  const cur = S.view[key];
  $(sel).innerHTML = items.length ? `<div class="bars">${items.map(([k, v]) => `<div class="bar-row ${String(cur) === String(k) ? 'sel' : ''}" data-f="${key}" data-v="${esc(k)}">
    <span class="lbl" title="${esc(label(k))}">${esc(label(k))}</span><span class="trk"><i style="width:${(v / max) * 100}%;--c:${color(k)}"></i></span><span class="val">${fmt(v)}</span></div>`).join('')}</div>`
    : '<p class="muted small">No data</p>';
}
function drawMap(list) {
  const c = countBy(list, (r) => r.region);
  const max = Math.max(1, ...c.values());
  const W = 62, G = 6;
  const tiles = Object.entries(TILE_POS).map(([code, [row, col]]) => {
    const v = c.get(code) || 0;
    const t = v ? Math.pow(v / max, 0.55) : 0;
    const fill = v ? `rgba(95,208,184,${0.16 + 0.78 * t})` : '#1C2C3B';
    const fg = t > 0.55 ? '#08221d' : '#E6EDF1';
    const x = col * (W + G), y = row * (W + G);
    return `<g class="tile ${S.view.prov === code ? 'sel' : ''}" data-f="prov" data-v="${code}"><title>${esc(REGION_LABEL[code])}: ${fmt(v)}</title>
      <rect x="${x}" y="${y}" width="${W}" height="${W}" rx="10" fill="${fill}" stroke="#263848" ${code === 'Remote' || code === '?' ? 'stroke-dasharray="4 3"' : ''}/>
      <text x="${x + 8}" y="${y + 17}" font-size="12" font-weight="700" fill="${fg}">${code === '?' ? 'N/S' : code === 'Remote' ? 'RMT' : code}</text>
      <text x="${x + W / 2}" y="${y + W - 12}" font-size="${v > 999 ? 14 : 17}" font-weight="700" text-anchor="middle" fill="${fg}">${v ? fmt(v) : '·'}</text></g>`;
  }).join('');
  $('#map').innerHTML = `<svg viewBox="-2 -2 ${8 * (W + G) + 2} ${3 * (W + G) + 2}" role="img" aria-label="Openings by province">${tiles}</svg>
    <p class="muted small" style="margin:8px 0 0">RMT = remote in Canada · N/S = location not stated (usually several Canadian offices)</p>`;
}
function drawTimeline(list) {
  const days = 30, counts = new Array(days).fill(0);
  let undated = 0;
  for (const r of list) {
    if (!r.posted) { undated++; continue; }
    const a = Math.floor(ageDays(r.posted));
    if (a >= 0 && a < days) counts[days - 1 - a]++;
  }
  const max = Math.max(1, ...counts), W = 600, H = 120, bw = W / days;
  const barsSvg = counts.map((v, i) => `<rect x="${i * bw + 1}" y="${H - 18 - (v / max) * (H - 30)}" width="${bw - 2}" height="${(v / max) * (H - 30)}" rx="2" fill="${i >= days - 7 ? '#E5604F' : '#5FD0B8'}"><title>${v} posted ${days - 1 - i} days ago</title></rect>`).join('');
  $('#timeChart').innerHTML = `<svg viewBox="0 0 ${W} ${H}">${barsSvg}<text x="0" y="${H - 2}" font-size="11" fill="#8FA3B1">30 days ago</text><text x="${W}" y="${H - 2}" font-size="11" fill="#8FA3B1" text-anchor="end">today</text></svg>
    <p class="muted small" style="margin:6px 0 0">${undated ? `${fmt(undated)} postings don’t show a date (first-seen date is shown instead).` : ''}</p>`;
}
const PIN = '<svg viewBox="0 0 24 24"><path d="M12 22s7-6.2 7-12a7 7 0 0 0-14 0c0 5.8 7 12 7 12z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="10" r="2.5" fill="currentColor"/></svg>';
function hue(s) { let h = 0; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; }
function card(r) {
  const name = empName(r.e);
  const emp = S.data.employers[r.e] || {};
  const initials = name.replace(/\(.*?\)/g, '').split(/\s+/).filter((w) => /^[A-Za-z0-9]/.test(w)).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  const where = r.region === 'Remote' ? `Remote · Canada${r.loc && !/^remote/i.test(r.loc) ? ` (${r.loc})` : ''}`
    : r.loc && r.loc === r.region ? REGION_LABEL[r.region]
    : (r.loc || (r.region !== '?' ? REGION_LABEL[r.region] : `Location not stated${emp.c ? ` · employer based in ${emp.c}${emp.p ? `, ${emp.p}` : ''}` : ''}`));
  const prov = r.loc && r.loc !== r.region && PROVINCE_NAMES[r.region] && !new RegExp(`\\b${r.region}\\b`).test(r.loc) && !r.loc.toLowerCase().includes(PROVINCE_NAMES[r.region].toLowerCase()) ? `, ${r.region}` : '';
  const when = r.posted ? `Posted ${new Date(r.posted + 'T12:00').toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: ageDays(r.posted) > 300 ? 'numeric' : undefined })}`
    : r.seen ? `First seen ${new Date(r.seen + 'T12:00').toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })}` : '';
  return `<article class="job">
    <div class="avatar" style="background:hsl(${hue(name)} 55% 66%)">${esc(initials || '?')}</div>
    <div class="job-main">
      <div class="job-title">${esc(r.title)}${isNew(r) ? '<span class="new">NEW</span>' : ''}</div>
      <div class="job-emp"><b>${esc(name)}</b>${emp.i ? ` · ${esc(emp.i)}` : ''}</div>
      <div class="tags"><span class="tag loc">${PIN}${esc(where)}${esc(prov)}</span>
        <span class="tag lvl" style="background:${LEVEL_INFO[r.level].c}">${esc(r.level)}</span>
        ${r.years != null ? `<span class="tag">${r.years}+ yrs asked</span>` : ''}
        <span class="tag">matches “${esc(r.match)}”</span></div>
    </div>
    <div class="apply"><a class="btn primary sm" href="${esc(r.url)}" target="_blank" rel="noopener">Apply on career site ↗</a><span class="when">${esc(when)}</span></div>
  </article>`;
}
document.addEventListener('click', (e) => {
  const f = e.target.closest('[data-f]');
  if (f && f.closest('#view-results')) {
    const k = f.dataset.f; let v = f.dataset.v; if (k === 'emp') v = Number(v);
    S.view[k] = String(S.view[k]) === String(v) ? '' : v; S.limit = 60; renderResults(); return;
  }
  const c = e.target.closest('[data-clear]');
  if (c) { S.view[c.dataset.clear] = ''; renderResults(); }
});
$('#q').addEventListener('input', (e) => { S.view.q = e.target.value; S.limit = 60; renderResults(); });
$('#newOnly').addEventListener('change', (e) => { S.view.newOnly = e.target.checked; renderResults(); });
$('#sortSeg').addEventListener('click', (e) => { const b = e.target.closest('[data-sort]'); if (!b) return; S.view.sort = b.dataset.sort; $$('#sortSeg button').forEach((x) => x.classList.toggle('on', x === b)); renderResults(); });
$('#more').addEventListener('click', () => { S.limit += 60; renderResults(); });
$('#editSearch').addEventListener('click', () => go('titles'));
$('#exportCsv').addEventListener('click', () => {
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['Employer', 'Job title', 'Level', 'Years asked', 'Location', 'Province', 'Posted', 'First seen', 'Matched title', 'Apply link']]
    .concat(filtered().map((r) => [empName(r.e), r.title, r.level, r.years ?? '', r.loc, REGION_LABEL[r.region] || '', r.posted, r.seen, r.match, r.url]));
  const blob = new Blob(['﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n')], { type: 'text/csv' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `talentpulse-openings-${new Date().toISOString().slice(0, 10)}.csv` });
  a.click();
});

// ------------------------------------------------------------------ employers
const STATUS_TEXT = { ok: 'Job board read', not_found: 'Needs a careers link', check_page: 'Page shows no jobs', error: "Couldn't load", unscanned: 'Not scanned yet' };
function employerRows() {
  const scan = new Map(S.data.employers.map((e, i) => [e.n, { ...e, i }]));
  const mine = countBy(S.results, (r) => r.e);
  const base = activeEmployers().length ? activeEmployers() : S.data.employers.map((e) => ({ company: e.n, province: e.p, city: e.c, industry: e.i }));
  return base.map((e) => { const s = scan.get(e.company); return { name: e.company, prov: e.province, city: e.city, ind: e.industry, url: s?.u || e.careers_url, st: s?.s || 'unscanned', note: s?.note || '', board: s?.b || '', open: s?.k || 0, mine: s ? mine.get(s.i) || 0 : 0 }; });
}
function renderEmployers() {
  const rows = employerRows();
  const c = countBy(rows, (r) => r.st);
  const auto = rows.filter((r) => r.st === 'ok' && /found from/.test(r.note)).length;
  $('#empKpis').innerHTML = [[rows.length, 'employers watched', 'var(--text)'], [c.get('ok') || 0, `job boards read${auto ? ` (${fmt(auto)} found automatically)` : ''}`, 'var(--teal)'],
    [(c.get('not_found') || 0) + (c.get('check_page') || 0), 'need a careers link', 'var(--gold)'], [c.get('error') || 0, "couldn't load", 'var(--red)']]
    .map(([b, s, col]) => `<div class="kpi" style="--c:${col}"><b>${fmt(b)}</b><span>${s}</span></div>`).join('');
  const ps = $('#eProv');
  if (!ps.options.length) ps.innerHTML = '<option value="">All provinces</option>' + ['ON', 'QC', 'BC', 'AB', 'MB', 'SK', 'NS', 'NB', 'NL', 'PE', 'YT', 'NT', 'NU', 'Remote'].map((p) => `<option>${p}</option>`).join('');
  const q = $('#eq').value.toLowerCase(), st = $('#eStatus').value, pv = $('#eProv').value;
  const list = rows.filter((r) => (!q || `${r.name} ${r.city} ${r.ind}`.toLowerCase().includes(q)) && (!st || r.st === st) && (!pv || r.prov === pv))
    .sort((a, b) => b.mine - a.mine || b.open - a.open || a.name.localeCompare(b.name));
  $('#eCount').textContent = `${fmt(list.length)} of ${fmt(rows.length)}${S.data.generatedAt ? '' : ' · statuses appear after the first scan finishes'}`;
  $('#eBody').innerHTML = list.slice(0, S.empLimit).map((r) => `<tr>
    <td>${r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.name)}</a>` : esc(r.name)}${r.board ? `<div class="sub">${esc(r.board)} job board</div>` : ''}</td>
    <td>${esc([r.city, r.prov].filter(Boolean).join(', '))}</td><td>${esc(r.ind)}</td>
    <td><span class="st ${r.st}" title="${esc(r.note)}">${STATUS_TEXT[r.st] || r.st}</span>${r.note ? `<div class="sub">${esc(r.note)}</div>` : ''}</td>
    <td>${r.st === 'ok' ? fmt(r.open) : '—'}</td><td>${S.searched && r.mine ? `<b class="teal">${fmt(r.mine)}</b>` : '—'}</td></tr>`).join('');
  $('#eMore').hidden = list.length <= S.empLimit;
}
['#eq', '#eStatus', '#eProv'].forEach((s) => $(s).addEventListener('input', () => { S.empLimit = 100; renderEmployers(); }));
$('#eMore').addEventListener('click', () => { S.empLimit += 200; renderEmployers(); });

window.addEventListener('hashchange', () => go(location.hash.slice(1)));
init().catch((e) => { $('#scanInfo').textContent = `Could not load data: ${e.message}`; console.error(e); });
