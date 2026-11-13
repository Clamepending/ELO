import { scoreTree, describe } from './scoring.js';
import { TREE, buildContext } from './tree.js';
import { ingest } from './ingest.js';
import { loadClassifier, classify } from './classify.js';
import { demoPhotos } from './demo.js';

const $ = (s) => document.querySelector(s);
const status = $('#status');
const results = $('#results');
let photosById = new Map();

function setStatus(text, frac) {
  status.hidden = !text;
  status.querySelector('.msg').textContent = text ?? '';
  const bar = status.querySelector('progress');
  if (frac == null) bar.removeAttribute('value'); else bar.value = frac;
}

async function run(fileList) {
  results.innerHTML = '';
  try {
    setStatus('Reading metadata…', 0);
    const photos = await ingest(fileList, (i, n) => setStatus(`Reading metadata ${i}/${n}`, i / n));
    if (!photos.length) { setStatus('No images found in that selection.'); return; }

    setStatus('Loading CLIP model (first run downloads ≈90 MB)…');
    let clf = null;
    try {
      clf = await loadClassifier((p) => {
        if (p.status === 'progress' && p.file?.endsWith('.onnx')) setStatus(`Downloading model ${Math.round(p.progress)}%`, p.progress / 100);
      });
    } catch (e) {
      console.warn('Classifier unavailable', e);
    }
    if (clf) {
      const todo = photos.filter((p) => p.thumb);
      for (let i = 0; i < todo.length; i++) {
        Object.assign(todo[i], await classify(clf, todo[i].thumb));
        setStatus(`Classifying ${i + 1}/${todo.length}`, (i + 1) / todo.length);
      }
      setStatus(null);
    } else {
      setStatus('The AI model could not load here, so only Exploration and Rhythm are scored from dates and GPS. Run the app locally (see README) for the full categories.', 1);
    }
    render(photos);
  } catch (e) {
    console.error(e);
    setStatus(`Error: ${e.message}`);
  }
}

// ---- rendering --------------------------------------------------------------

function render(photos) {
  photosById = new Map(photos.map((p) => [p.id, p]));
  const scored = scoreTree(TREE, buildContext(photos));
  results.innerHTML = '';
  results.append(summary(photos), nodeEl(scored, 0));
}

function summary(photos) {
  const counts = {};
  for (const p of photos) counts[p.cat] = (counts[p.cat] ?? 0) + 1;
  const dated = photos.filter((p) => p.date);
  const span = dated.length
    ? `${fmtDate(new Date(Math.min(...dated.map((p) => p.date))))} – ${fmtDate(new Date(Math.max(...dated.map((p) => p.date))))}`
    : 'no dates';
  const gps = photos.filter((p) => Number.isFinite(p.lat)).length;
  const el = document.createElement('div');
  el.className = 'summary';
  el.innerHTML = `<span><b>${photos.length}</b> photos · ${span} · ${gps} with GPS</span><span class="chips">${
    Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<span class="chip">${k} ${v}</span>`).join('')}</span>`;
  return el;
}

const ordinal = (n) => (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
const fmtDate = (d) => d.toLocaleDateString(undefined, { year: 'numeric', month: 'short' });

function nodeEl(node, depth) {
  const s = node.score;
  const d = describe(s);
  const isLeaf = !node.children;
  const wrap = document.createElement('div');
  wrap.className = `node depth-${Math.min(depth, 2)}`;

  const row = document.createElement('button');
  row.className = 'row';
  row.setAttribute('aria-expanded', 'false');
  const badge = s.missing ? '<span class="badge none">no data</span>' : d.provisional ? '<span class="badge prov">provisional</span>' : '';
  row.innerHTML = `
    <span class="chev" aria-hidden="true">▸</span>
    <span class="name">${node.name}${badge}</span>
    <span class="bar" title="${d.pct}${ordinal(d.pct)} percentile vs. reference"><span style="width:${d.pct}%"></span></span>
    <span class="elo">${d.elo}</span>
    <span class="ci">±${d.ci95}</span>
    <span class="pct">${d.pct}<small>${ordinal(d.pct)}</small></span>`;
  wrap.append(row);

  const kids = document.createElement('div');
  kids.className = 'kids';
  kids.hidden = true;
  const info = document.createElement('div');
  info.className = 'info';
  info.innerHTML = `<p>${node.desc ?? ''}</p>${isLeaf ? leafInfo(node) : ''}`;
  kids.append(info);
  if (isLeaf) {
    kids.append(evidenceEl(s.evidence));
  } else {
    for (const c of node.children) kids.append(nodeEl(c, depth + 1));
  }
  wrap.append(kids);

  row.addEventListener('click', () => {
    kids.hidden = !kids.hidden;
    row.setAttribute('aria-expanded', String(!kids.hidden));
  });
  return wrap;
}

function leafInfo(node) {
  const s = node.score;
  const n = node.norm;
  const ref = n.transform === 'logit' ? `${Math.round(n.median * 100)}%` : n.median;
  const rows = [
    ['Measured', s.raw?.detail ?? '—'],
    ['Reference median', `${ref} (placeholder norm, ${n.higherIsBetter === false ? 'lower' : 'higher'} is better)`],
    ['Evidence weight', s.missing ? 'none: shown at the prior (1500)' : `n = ${s.raw.n}, shrinkage ${Math.round(100 * (1 - s.coverage))}% toward 1500`],
  ];
  if (!s.missing) rows.push(['Raw z → posterior θ', `${s.z.toFixed(2)} → ${s.theta.toFixed(2)} (sd ${Math.sqrt(s.var).toFixed(2)})`]);
  return `<dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;
}

function evidenceEl(ids) {
  const el = document.createElement('div');
  el.className = 'evidence';
  const ps = ids.map((id) => photosById.get(id)).filter(Boolean);
  if (!ps.length) return el;
  const MAX = 36;
  for (const p of ps.slice(0, MAX)) {
    const t = document.createElement(p.thumb ? 'img' : 'div');
    t.className = 'thumb';
    const when = p.date ? p.date.toLocaleString() : 'no date';
    t.title = `${p.name}\n${p.cat}${p.sub ? ' / ' + p.sub : ''} (${Math.round(p.conf * 100)}%)\n${when} [${p.dateSource}]`;
    if (p.thumb) { t.src = p.thumb; t.loading = 'lazy'; t.alt = p.name; } else t.textContent = p.sub ?? p.cat;
    el.append(t);
  }
  if (ps.length > MAX) {
    const more = document.createElement('div');
    more.className = 'thumb more';
    more.textContent = `+${ps.length - MAX}`;
    el.append(more);
  }
  return el;
}

// ---- wiring -----------------------------------------------------------------

for (const id of ['#files', '#folder']) {
  $(id).addEventListener('change', (e) => { if (e.target.files.length) run(e.target.files); e.target.value = ''; });
}
$('#demo').addEventListener('click', () => { setStatus(null); render(demoPhotos()); });

const drop = $('#drop');
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer.files.length) run(e.dataTransfer.files); });
