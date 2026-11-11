import * as C from './calc.js';
import { STYLES, FERMENTABLES, HOPS, YEASTS, WATER_TARGETS, RO_WATER, AROMA_AXES, findStyle, byName, similarFermentables, similarHops, grainDiPh } from './data.js';
import { parseBeerXML, toBeerXML, decodeXmlBytes } from './beerxml.js';
import { toBeerJSON, fromBeerJSON, blankRecipe } from './beerjson.js';
import { store } from './store.js';
import { timer } from './timer.js';
import { fetchThingSpeak, stableFor } from './sources.js';
import { sheetHtml, sheetPdf } from './brewsheet.js';

// ---------- helpers ----------
const $ = (s, el = document) => el.querySelector(s);
const view = $('#view');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sg = v => (Number.isFinite(v) && v > 0 ? v.toFixed(3) : '–');
const n = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '–');
const uid = () => Math.random().toString(36).slice(2, 7);
const slug = s => (s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, 40) || 'recipe';
const today = () => new Date().toISOString().slice(0, 10);
const clone = o => JSON.parse(JSON.stringify(o));

// Equipment profiles live in settings.json. A recipe points at one by id; without one it uses the default.
function profiles() {
  const s = store.get('settings', 'settings') || {};
  const list = s.profiles?.length ? s.profiles : [{ id: 'default', name: 'My brewery', ...(s.equipment || {}) }];
  return list.map(p => ({ ...C.DEFAULT_EQUIP, ...p }));
}
function defaultProfile() {
  const list = profiles();
  return list.find(p => p.id === store.get('settings', 'settings')?.defaultProfile) || list[0];
}
const equipFor = r => profiles().find(p => p.id === r?.equipment) || defaultProfile();

// Water. Your own profiles live in settings.json; RO water and the target profiles are built in.
const ION_LABELS = { ca: 'Ca', mg: 'Mg', na: 'Na', cl: 'Cl', so4: 'SO₄', hco3: 'HCO₃' };
const myWaters = () => store.get('settings', 'settings')?.waters || [];
const sourceWaters = () => [RO_WATER, ...myWaters()];
const targetWaters = () => [...WATER_TARGETS, ...myWaters()];
const sourceFor = r => sourceWaters().find(w => w.id === (r?.water?.source ?? store.get('settings', 'settings')?.defaultWater)) || RO_WATER;
const targetFor = r => targetWaters().find(w => w.id === r?.water?.target);
const saltList = r => Object.entries(C.SALTS).filter(([k]) => r?.water?.salts?.[k] > 0).map(([k, d]) => `${n(+r.water.salts[k])} g ${d.name.toLowerCase()}`);

function setPath(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  let o = obj;
  for (const k of keys) o = o[k] ??= {};
  o[last] = value;
}
const getPath = (obj, path) => path.split('.').reduce((o, k) => o?.[k], obj);

let toastTimer;
function toast(msg, kind = '') { // kind: '' | true (error) | 'alert' (timer)
  const t = $('#toast');
  const cls = kind === true ? 'bad' : kind;
  t.textContent = msg;
  t.className = 'show ' + cls;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, { bad: 6000, alert: 20000 }[cls] || 3000);
}
$('#toast').addEventListener('click', () => { $('#toast').className = ''; });

function download(filename, text, mime) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: mime }));
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// A pint of the beer in question. `level` 0..1 is how full it is; the outline takes the text colour.
let pintId = 0;
function pint(hex, width = 34, level = 1, pour = false) {
  const id = 'pint' + (++pintId), top = 15 + (1 - Math.max(0, Math.min(1, level))) * 59;
  const foam = level > 0.04 ? `<g class="foam" fill="#fffaf0"><rect x="6" y="${top - 8}" width="48" height="9"/><circle cx="16" cy="${top - 8}" r="5"/><circle cx="26" cy="${top - 9.5}" r="6"/><circle cx="37" cy="${top - 8.5}" r="5.5"/><circle cx="46" cy="${top - 8}" r="4.5"/></g>` : '';
  return `<svg class="pint${pour ? ' pour' : ''}" viewBox="0 0 60 82" width="${width}" height="${Math.round(width * 82 / 60)}" aria-hidden="true">
    <defs><clipPath id="${id}"><path d="M9 4h42l-5.2 68.5a4 4 0 0 1-4 3.5H18.2a4 4 0 0 1-4-3.5z"/></clipPath></defs>
    <path d="M9 4h42l-5.2 68.5a4 4 0 0 1-4 3.5H18.2a4 4 0 0 1-4-3.5z" fill="#fffaf0" fill-opacity=".22"/>
    <g clip-path="url(#${id})"><rect class="beer" x="6" y="${top}" width="48" height="${78 - top}" fill="${hex}"/>${foam}
      <path d="M15 8l3.6 62h4.2L19.5 8z" fill="#fff" fill-opacity=".28"/></g>
    <path d="M9 4h42l-5.2 68.5a4 4 0 0 1-4 3.5H18.2a4 4 0 0 1-4-3.5z" fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="round"/>
  </svg>`;
}

// Two-tap confirmation for destructive buttons: the first tap arms the button, the second does it.
function confirmTap(b, label) {
  if (b.dataset.armed) return true;
  const old = b.textContent;
  b.dataset.armed = '1';
  b.textContent = label;
  setTimeout(() => { if (b.isConnected) { delete b.dataset.armed; b.textContent = old; } }, 4000);
  return false;
}

// One form field. `c` = { f, label, num, opts, list, autofill, rerender, type, cls }
function field(c, path, value) {
  const id = 'f-' + path.replace(/\./g, '-');
  const attrs = `id="${id}" data-p="${path}"${c.rerender ? ' data-rerender="1"' : ''}`;
  let ctl;
  if (c.opts) {
    ctl = `<select ${attrs}>${c.opts.map(o => {
      const [val, text] = Array.isArray(o) ? o : [o, o];
      return `<option value="${esc(val)}"${val === value ? ' selected' : ''}>${esc(text)}</option>`;
    }).join('')}</select>`;
  } else if (c.area) {
    ctl = `<textarea ${attrs} rows="${c.area}">${esc(value)}</textarea>`;
  } else {
    const type = c.type || (c.num ? 'number' : 'text');
    ctl = `<input ${attrs} type="${type}"${c.num ? ` step="${c.step || 'any'}" inputmode="decimal"` : ''}${c.list ? ` list="${c.list}" autocomplete="off"` : ''}${c.autofill ? ` data-autofill="${c.autofill}"` : ''} value="${esc(value ?? '')}">`;
  }
  return `<label class="fld ${c.cls || ''}" for="${id}"><span>${c.label}</span>${ctl}</label>`;
}

// Spider chart of aroma scores (0 to 5 on each of AROMA_AXES). Small ones are a bare glyph; large ones are labelled.
function radar(vals, { size = 40, labels = false } = {}) {
  const N = AROMA_AXES.length, W = labels ? 300 : 100, H = labels ? 214 : 100, cx = W / 2, cy = H / 2, R = labels ? 74 : 44;
  const pt = (i, v) => { const a = -Math.PI / 2 + i * 2 * Math.PI / N; return [cx + Math.cos(a) * R * v / 5, cy + Math.sin(a) * R * v / 5]; };
  const poly = v => AROMA_AXES.map((_, i) => pt(i, typeof v === 'number' ? v : Math.max(0.25, v[i])).map(x => x.toFixed(1)).join(',')).join(' ');
  const top = vals ? AROMA_AXES.map((name, i) => [vals[i], name.toLowerCase()]).filter(x => x[0] >= 3).sort((a, b) => b[0] - a[0]).slice(0, 3).map(x => x[1]) : [];
  return `<svg class="radar" viewBox="0 0 ${W} ${H}" width="${size}" height="${Math.round(size * H / W)}" role="img" aria-label="${vals ? `Aroma: ${top.join(', ') || 'mild'}` : 'No aroma data'}">
    ${(labels ? [1, 2, 3, 4, 5] : [5]).map(v => `<polygon class="ring" points="${poly(v)}"/>`).join('')}
    ${labels ? AROMA_AXES.map((_, i) => { const [x, y] = pt(i, 5); return `<line class="spoke" x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}"/>`; }).join('') : ''}
    ${vals ? `<polygon class="shape" points="${poly(vals)}"/>` : ''}
    ${labels ? AROMA_AXES.map((name, i) => { const [x, y] = pt(i, 5.75), c = Math.cos(-Math.PI / 2 + i * 2 * Math.PI / N); return `<text x="${x.toFixed(1)}" y="${(y + 4).toFixed(1)}" text-anchor="${c > 0.3 ? 'start' : c < -0.3 ? 'end' : 'middle'}">${name}</text>`; }).join('') : ''}
  </svg>`;
}
const hopAroma = name => byName(HOPS, name)?.aroma;
// Colour chip for a fermentable: a small round swatch of the malt's own colour.
// Malt colours run from 3 to 1300 EBC, so they are spread over the beer colour scale on a log curve;
// otherwise everything from light crystal upwards would look black.
function maltGlyph(ebc, size = 26) {
  return `<span class="chip" data-tip="${n(+ebc || 0, 0)} EBC · ${n(C.ebcToSrm(+ebc || 0), 0)} SRM"><svg class="radar malt" viewBox="0 0 100 100" width="${size}" height="${size}" role="img" aria-label="Colour ${n(+ebc || 0, 0)} EBC"><circle class="ring" cx="50" cy="50" r="45" style="fill:${C.srmToHex(40 * Math.log(1 + (+ebc || 0) / 8) / Math.log(1 + 1300 / 8))}"/></svg></span>`;
}
const aromaWords = vals => {
  const top = AROMA_AXES.map((name, i) => [vals[i], name.toLowerCase()]).filter(x => x[0] >= 3).sort((a, b) => b[0] - a[0]).slice(0, 3).map(x => x[1]);
  return top.length ? `Mostly ${top.join(', ').replace(/, ([^,]*)$/, ' and $1')}` : 'Mild, with no strong aroma note';
};
// How much an addition contributes to aroma, per gram: dry hops and whirlpool most, long boils nothing.
const aromaWeight = h => (h.use === 'dry hop' ? 1 : h.use === 'whirlpool' ? 0.8 : (h.use || 'boil') === 'boil' ? (h.time <= 5 ? 0.6 : h.time <= 10 ? 0.4 : h.time <= 20 ? 0.2 : 0) : 0);

// Attenuation as a ring: the filled share of the circle is the share of sugar the yeast eats.
function yeastGlyph(att, size = 26) {
  const a = Math.min(100, Math.max(0, +att || 0)), r = 38, c = 2 * Math.PI * r;
  return `<span class="chip" data-tip="${n(a, 0)} % attenuation"><svg class="radar yeast" viewBox="0 0 100 100" width="${size}" height="${size}" role="img" aria-label="Attenuation ${n(a, 0)} %"><circle class="ring" cx="50" cy="50" r="${r}"/><circle class="shape" cx="50" cy="50" r="${r}" stroke-dasharray="${(c * a / 100).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 50 50)"/></svg></span>`;
}
const miscWhen = m => ({
  mash: 'mash', boil: `boil · ${m.time ?? 0} min`, fermentation: 'fermenter', package: 'packaging',
}[m.use || 'boil'] + (m.type && m.type !== 'other' ? ` · ${m.type}` : ''));

const hopWhen = h => ({
  boil: `boil · ${h.time ?? 0} min`, 'first wort': 'first wort', mash: 'mash',
  whirlpool: `whirlpool · ${h.time ?? 0} min at ${h.temp ?? 80} °C`, 'dry hop': `dry hop · ${h.time ?? 0} days`,
}[h.use || 'boil']);

// Editable lists (fermentables, hops, readings…). Each renders into #sec-<name>.
const LISTS = {
  fermentables: {
    title: 'Fermentables', empty: 'No fermentables yet. Add your base malt first.',
    addAct: 'add-ferm', // opens the picker instead of adding a blank row
    // Name, weight and share of the grist. Type, potential and colour live in the popup (tap the name).
    row: (f, i) => `<div class="row compact">
      <button type="button" class="name-btn glyph" data-act="edit-ferm" data-i="${i}" aria-label="Edit ${esc(f.name || 'fermentable')}">${maltGlyph(f.color)}<span><strong>${esc(f.name || 'Unnamed fermentable')}</strong>${f.type && f.type !== 'grain' ? `<small>${esc(f.type)}</small>` : ''}</span></button>
      <label class="amt" for="f-fermentables-${i}-amount"><span class="sr">Kilograms of ${esc(f.name)}</span><input id="f-fermentables-${i}-amount" data-p="fermentables.${i}.amount" type="number" step="0.1" inputmode="decimal" value="${esc(f.amount ?? '')}"><span aria-hidden="true">kg</span></label>
      <output class="derived" id="d-fermentables-${i}"></output>
      <button type="button" class="icon-btn" data-act="remove" data-list="fermentables" data-i="${i}" aria-label="Remove ${esc(f.name || 'row')}">×</button></div>`,
  },
  hops: {
    title: 'Hops', empty: 'No hops yet.',
    addAct: 'add-hop',
    // Name with its timing, weight and IBU. Alpha, form and timing are edited in the popup (tap the name).
    row: (h, i) => `<div class="row compact">
      <button type="button" class="name-btn glyph" data-act="edit-hop" data-i="${i}" aria-label="Edit ${esc(h.name || 'hop')}">${radar(hopAroma(h.name), { size: 38 })}<span><strong>${esc(h.name || 'Unnamed hop')}</strong><small class="when">${esc(hopWhen(h))}</small></span></button>
      <label class="amt" for="f-hops-${i}-amount"><span class="sr">Grams of ${esc(h.name)}</span><input id="f-hops-${i}-amount" data-p="hops.${i}.amount" type="number" step="1" inputmode="decimal" value="${esc(h.amount ?? '')}"><span aria-hidden="true">g</span></label>
      <output class="derived" id="d-hops-${i}"></output>
      <button type="button" class="icon-btn" data-act="remove" data-list="hops" data-i="${i}" aria-label="Remove ${esc(h.name || 'row')}">×</button></div>`,
    footer: () => '<div id="hop-aroma"></div>',
  },
  yeasts: {
    title: 'Yeast', empty: 'No yeast yet. FG is estimated at 75% attenuation until you add one.',
    addAct: 'add-yeast',
    // Name with lab and form, and the number of packs. Lab, form and attenuation are edited in the popup (tap the name).
    row: (y, i) => `<div class="row compact">
      <button type="button" class="name-btn glyph" data-act="edit-yeast" data-i="${i}" aria-label="Edit ${esc(y.name || 'yeast')}">${yeastGlyph(y.attenuation)}<span><strong>${esc(y.name || 'Unnamed yeast')}</strong><small class="when">${esc([y.lab, y.form].filter(Boolean).join(' · '))}</small></span></button>
      <label class="amt" for="f-yeasts-${i}-amount"><span class="sr">Packs of ${esc(y.name)}</span><input id="f-yeasts-${i}-amount" data-p="yeasts.${i}.amount" type="number" step="1" min="0" inputmode="decimal" value="${esc(y.amount ?? '')}"><span aria-hidden="true">pk</span></label>
      <output class="derived">${Number.isFinite(+y.attenuation) && y.attenuation !== '' ? `${n(+y.attenuation, 0)} %` : ''}</output>
      <button type="button" class="icon-btn" data-act="remove" data-list="yeasts" data-i="${i}" aria-label="Remove ${esc(y.name || 'row')}">×</button></div>`,
  },
  miscs: {
    title: 'Other additions', empty: 'Finings, nutrients, spices and the like. Water salts go in the Water card.',
    addAct: 'add-misc',
    // Name with when it goes in, and the amount. Type, unit and timing are edited in the popup (tap the name).
    row: (m, i) => `<div class="row compact">
      <button type="button" class="name-btn" data-act="edit-misc" data-i="${i}" aria-label="Edit ${esc(m.name || 'addition')}"><strong>${esc(m.name || 'Unnamed addition')}</strong><small class="when">${esc(miscWhen(m))}</small></button>
      <label class="amt" for="f-miscs-${i}-amount"><span class="sr">${m.unit === 'each' ? 'Number' : m.unit === 'ml' ? 'Millilitres' : 'Grams'} of ${esc(m.name)}</span><input id="f-miscs-${i}-amount" data-p="miscs.${i}.amount" type="number" step="${m.unit === 'each' ? 1 : 'any'}" min="0" inputmode="decimal" value="${esc(m.amount ?? '')}"><span aria-hidden="true">${m.unit === 'each' ? '×' : esc(m.unit || 'g')}</span></label>
      <output class="derived"></output>
      <button type="button" class="icon-btn" data-act="remove" data-list="miscs" data-i="${i}" aria-label="Remove ${esc(m.name || 'row')}">×</button></div>`,
  },
  mash: {
    title: 'Mash', empty: 'No mash steps (extract brew).',
    blank: () => ({ name: 'Step', temp: 66, time: 60 }),
    cols: () => [{ f: 'name', label: 'Step', cls: 'w-name' }, { f: 'temp', label: '°C', num: 1 }, { f: 'time', label: 'Min', num: 1 }],
    footer: () => '<div id="water" class="summary"></div>',
  },
  fermentation: {
    title: 'Fermentation', empty: 'No fermentation steps.',
    blank: () => ({ name: 'Step', temp: 19, days: 7 }),
    cols: () => [{ f: 'name', label: 'Step', cls: 'w-name' }, { f: 'temp', label: '°C', num: 1 }, { f: 'days', label: 'Days', num: 1 }],
  },
  readings: {
    title: 'Fermentation log', empty: 'No readings yet. Add one each time you take a gravity sample.',
    blank: () => ({ date: today(), sg: null, temp: null, note: '' }),
    cols: () => [
      { f: 'date', label: 'Date', type: 'date' },
      { f: 'sg', label: 'Gravity', num: 1, step: 0.001 },
      { f: 'temp', label: '°C', num: 1 },
      { f: 'note', label: 'Note', cls: 'w-name' },
    ],
    footer: () => '<div id="chart"></div>',
  },
};

function renderList(name) {
  const cfg = LISTS[name];
  const items = (ctx.doc[name] ??= []);
  const sec = $('#sec-' + name);
  if (!sec) return;
  sec.innerHTML = `<div class="sec-head"><h2>${cfg.title}</h2><button type="button" class="btn small" data-act="${cfg.addAct || 'add'}" data-list="${name}">Add</button></div>` +
    (items.length ? items.map((it, i) => cfg.row ? cfg.row(it, i) : `<div class="row">${cfg.cols(it).map(c => field(c, `${name}.${i}.${c.f}`, it[c.f])).join('')}` +
      (cfg.derived ? `<output class="derived" id="d-${name}-${i}"></output>` : '') +
      `<button type="button" class="icon-btn" data-act="remove" data-list="${name}" data-i="${i}" aria-label="Remove ${esc(it.name || 'row')}">×</button></div>`).join('')
      : `<p class="empty">${cfg.empty}</p>`) + (cfg.footer?.() ?? '');
}

// Popup for adding a fermentable (index null) or editing one. Pick from the built-in list or type your own.
const FERM_TYPES = ['grain', 'sugar', 'extract', 'dry extract', 'honey', 'other'];
function fermentableDialog(recipe, index, done) {
  const editing = index != null;
  const item = editing ? clone(recipe.fermentables[index]) : { name: '', type: 'grain', amount: 1, potential: 1.037, color: 6 };
  document.querySelector('dialog.sheet')?.remove();
  const dlg = document.createElement('dialog');
  dlg.className = 'sheet';
  dlg.innerHTML = `<form novalidate>
    <div class="sec-head"><h2>${editing ? 'Edit fermentable' : 'Add fermentable'}</h2><button type="button" class="icon-btn" data-x aria-label="Close">×</button></div>
    <label class="fld" for="fd-name"><span>Name</span><input id="fd-name" type="search" autocomplete="off" placeholder="Search malts, sugars and extracts" value="${esc(item.name)}"></label>
    <div class="picks" id="fd-picks"></div>
    <p class="hint" id="fd-note" role="status"></p>
    <div class="row"><label class="fld" for="fd-amount"><span>Amount, kg</span><input id="fd-amount" type="number" step="0.1" min="0" inputmode="decimal" value="${esc(item.amount ?? '')}"></label></div>
    <details id="fd-more"${editing ? " open" : ""}><summary>Type, potential and colour</summary><div class="row">
      <label class="fld" for="fd-type"><span>Type</span><select id="fd-type">${FERM_TYPES.map(t => `<option${t === item.type ? ' selected' : ''}>${t}</option>`).join('')}</select></label>
      <label class="fld" for="fd-potential"><span>Potential SG</span><input id="fd-potential" type="number" step="0.001" inputmode="decimal"></label>
      <label class="fld" for="fd-color"><span>Colour, EBC</span><input id="fd-color" type="number" step="1" inputmode="decimal"></label>
    </div><p class="hint" id="fd-srm"></p></details>
    ${editing ? '<div id="fd-subs"></div>' : ''}
    <div class="foot-actions">
      <button type="submit" class="btn primary">${editing ? 'Done' : 'Add to recipe'}</button>
      <button type="button" class="btn" data-x>Cancel</button>
    </div></form>`;
  document.body.append(dlg);
  const el = id => dlg.querySelector('#fd-' + id);
  const showSrm = () => { el('srm').textContent = Number.isFinite(+item.color) ? `${n(+item.color, 0)} EBC is ${n(C.ebcToSrm(+item.color), 0)} SRM. EBC is the European scale and runs about twice the SRM number.` : ''; };
  const fillDetails = () => { el('type').value = item.type || 'grain'; el('potential').value = item.potential ?? ''; el('color').value = item.color ?? ''; showSrm(); };
  const drawPicks = () => {
    const q = item.name.trim().toLowerCase(), exact = byName(FERMENTABLES, item.name);
    const hits = editing && exact ? [] : FERMENTABLES.filter(f => !q || exact || f.name.toLowerCase().includes(q));
    el('picks').innerHTML = hits.map(f => `<button type="button" class="pick${f === exact ? ' on' : ''}" data-n="${esc(f.name)}"><span>${esc(f.name)}</span><small>${f.type !== 'grain' ? f.type + ' · ' : ''}${f.color} EBC</small></button>`).join('');
    el('picks').hidden = !hits.length;
    const custom = q && !exact;
    el('note').textContent = custom ? (hits.length ? 'Pick one from the list, or keep typing to add your own.' : `"${item.name.trim()}" is not in the list. Set its type, potential and colour below.`) : '';
    if (custom && !hits.length) el('more').open = true;
    if (exact) el('picks').querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  };
  const adopt = hit => { Object.assign(item, { name: hit.name, type: hit.type, potential: hit.potential, color: hit.color }); fillDetails(); };
  // Substitutes: similar fermentables, with the weight that keeps this one's gravity contribution.
  const swapAmount = hit => +(((+item.potential || 1.037) - 1) * (+item.amount || 0) / (hit.potential - 1)).toFixed(2);
  const drawSubs = () => {
    if (!editing) return;
    const subs = item.name.trim() ? similarFermentables(item) : [];
    el('subs').innerHTML = subs.length ? `<h3>Swap for something similar</h3><div class="picks">${subs.map(f =>
      `<button type="button" class="pick sub" data-s="${esc(f.name)}"><span>${esc(f.name)}</span><small>${f.type !== 'grain' ? f.type + ' · ' : ''}${f.color} EBC · ${n(swapAmount(f), 2)} kg</small></button>`).join('')}</div>
      <p class="hint">Amounts shown keep the same gravity as ${n(+item.amount || 0, 2)} kg of ${esc(item.name)}.</p>` : '';
  };
  dlg.addEventListener('input', e => {
    const t = e.target;
    if (t === el('name')) { item.name = t.value; const hit = byName(FERMENTABLES, t.value); if (hit) adopt(hit); drawPicks(); }
    else if (t === el('amount')) item.amount = t.value === '' ? null : parseFloat(t.value);
    else if (t === el('type')) item.type = t.value;
    else if (t === el('potential')) item.potential = parseFloat(t.value);
    else if (t === el('color')) { item.color = parseFloat(t.value); showSrm(); }
    drawSubs();
  });
  dlg.addEventListener('click', e => {
    const swap = e.target.closest('.sub');
    if (swap) {
      const hit = byName(FERMENTABLES, swap.dataset.s), was = item.name, amount = swapAmount(hit);
      adopt(hit);
      item.amount = amount;
      el('name').value = item.name; el('amount').value = amount;
      drawPicks(); drawSubs();
      el('note').textContent = `Swapped ${was} for ${hit.name} at ${n(amount, 2)} kg. Press Done to keep it.`;
      return;
    }
    const pick = e.target.closest('.pick');
    if (pick) { adopt(byName(FERMENTABLES, pick.dataset.n)); el('name').value = item.name; drawPicks(); el('amount').focus(); el('amount').select(); return; }
    if (e.target.closest('[data-x]') || e.target === dlg) dlg.close(); // close button, Cancel, or a tap on the backdrop
  });
  dlg.querySelector('form').addEventListener('submit', e => {
    e.preventDefault();
    item.name = item.name.trim();
    if (!item.name) { el('note').textContent = 'Give the fermentable a name first.'; el('name').focus(); return; }
    if (!Number.isFinite(item.potential)) item.potential = 1.037;
    if (!Number.isFinite(item.color)) item.color = 0;
    if (editing) recipe.fermentables[index] = item; else recipe.fermentables.push(item);
    dlg.close();
    done();
  });
  dlg.addEventListener('close', () => dlg.remove());
  fillDetails();
  drawPicks();
  drawSubs();
  dlg.showModal();
  if (editing) { el('amount').focus(); el('amount').select(); } else el('name').focus();
}

// Popup for adding a hop (index null) or editing one, with substitutes when editing.
const HOP_USES = ['boil', 'first wort', 'whirlpool', 'dry hop', 'mash'];
function hopDialog(recipe, index, done) {
  const editing = index != null;
  const item = editing ? clone(recipe.hops[index]) : { name: '', amount: 20, alpha: 6, form: 'pellet', use: 'boil', time: 60 };
  document.querySelector('dialog.sheet')?.remove();
  const dlg = document.createElement('dialog');
  dlg.className = 'sheet';
  dlg.innerHTML = `<form novalidate>
    <div class="sec-head"><h2>${editing ? 'Edit hop' : 'Add hop'}</h2><button type="button" class="icon-btn" data-x aria-label="Close">×</button></div>
    <label class="fld" for="hd-name"><span>Name</span><input id="hd-name" type="search" autocomplete="off" placeholder="Search hops" value="${esc(item.name)}"></label>
    <div class="picks" id="hd-picks"></div>
    <p class="hint" id="hd-note" role="status"></p>
    <div id="hd-aroma"></div>
    <div class="row">
      <label class="fld" for="hd-amount"><span>Amount, g</span><input id="hd-amount" type="number" step="1" min="0" inputmode="decimal" value="${esc(item.amount ?? '')}"></label>
      <label class="fld" for="hd-alpha"><span>Alpha acid %</span><input id="hd-alpha" type="number" step="0.1" min="0" inputmode="decimal" value="${esc(item.alpha ?? '')}"></label>
    </div>
    <div class="row" id="hd-timing"></div>
    <div class="row"><label class="fld" for="hd-form"><span>Form</span><select id="hd-form">${['pellet', 'leaf'].map(f => `<option${f === (item.form || 'pellet') ? ' selected' : ''}>${f}</option>`).join('')}</select></label></div>
    ${editing ? '<div id="hd-subs"></div>' : ''}
    <div class="foot-actions">
      <button type="submit" class="btn primary">${editing ? 'Done' : 'Add to recipe'}</button>
      <button type="button" class="btn" data-x>Cancel</button>
    </div></form>`;
  document.body.append(dlg);
  const el = id => dlg.querySelector('#hd-' + id);
  const drawTiming = () => {
    const timed = ['boil', 'whirlpool', 'dry hop'].includes(item.use);
    el('timing').innerHTML = `<label class="fld" for="hd-use"><span>Use</span><select id="hd-use">${HOP_USES.map(u => `<option${u === item.use ? ' selected' : ''}>${u}</option>`).join('')}</select></label>` +
      (timed ? `<label class="fld" for="hd-time"><span>${item.use === 'dry hop' ? 'Days' : item.use === 'boil' ? 'Minutes from the end' : 'Minutes'}</span><input id="hd-time" type="number" step="${item.use === 'dry hop' ? 1 : 5}" min="0" inputmode="decimal" value="${esc(item.time ?? '')}"></label>` : '') +
      (item.use === 'whirlpool' ? `<label class="fld" for="hd-temp"><span>Temp °C</span><input id="hd-temp" type="number" step="1" inputmode="decimal" value="${esc(item.temp ?? 80)}"></label>` : '');
  };
  const drawPicks = () => {
    const q = item.name.trim().toLowerCase(), exact = byName(HOPS, item.name);
    const hits = editing && exact ? [] : HOPS.filter(h => !q || exact || h.name.toLowerCase().includes(q));
    el('picks').innerHTML = hits.map(h => `<button type="button" class="pick${h === exact ? ' on' : ''}" data-n="${esc(h.name)}"><span>${esc(h.name)}</span><small>${h.alpha} % · ${h.group}</small></button>`).join('');
    el('picks').hidden = !hits.length;
    el('note').textContent = q && !exact ? (hits.length ? 'Pick one from the list, or keep typing to add your own.' : `"${item.name.trim()}" is not in the list. Set its alpha acid below.`) : '';
    if (exact) el('picks').querySelector('.on')?.scrollIntoView({ block: 'nearest' });
    el('aroma').innerHTML = exact ? `<div class="aroma-box">${radar(exact.aroma, { size: 300, labels: true })}<p class="hint">${aromaWords(exact.aroma)}.</p></div>`
      : q && !hits.length ? '<p class="hint">No aroma chart for hops outside the built-in list.</p>' : '';
  };
  const adopt = hit => { item.name = hit.name; item.alpha = hit.alpha; el('alpha').value = hit.alpha; };
  // Hot-side swaps keep the bitterness (grams scale with alpha); dry hops keep their weight.
  const swapAmount = hit => (item.use === 'dry hop' ? +item.amount || 0 : Math.round((+item.amount || 0) * (+item.alpha || hit.alpha) / hit.alpha));
  const drawSubs = () => {
    if (!editing) return;
    const subs = item.name.trim() ? similarHops(item) : [];
    el('subs').innerHTML = subs.length ? `<h3>Swap for something similar</h3><div class="picks">${subs.map(h =>
      `<button type="button" class="pick sub glyph" data-s="${esc(h.name)}">${radar(h.aroma, { size: 34 })}<span>${esc(h.name)}</span><small>${h.alpha} % · ${swapAmount(h)} g</small></button>`).join('')}</div>
      <p class="hint">${item.use === 'dry hop' ? 'Dry hops keep the same weight.' : `Amounts shown keep the same bitterness as ${n(+item.amount || 0, 0)} g at ${n(+item.alpha || 0, 1)} %.`}</p>` : '';
  };
  dlg.addEventListener('input', e => {
    const t = e.target, numOr = v => (v === '' ? null : parseFloat(v));
    if (t === el('name')) { item.name = t.value; const hit = byName(HOPS, t.value); if (hit) adopt(hit); drawPicks(); }
    else if (t === el('amount')) item.amount = numOr(t.value);
    else if (t === el('alpha')) item.alpha = numOr(t.value);
    else if (t === el('form')) item.form = t.value;
    else if (t.id === 'hd-time') item.time = numOr(t.value);
    else if (t.id === 'hd-temp') item.temp = numOr(t.value);
    else if (t.id === 'hd-use') {
      item.use = t.value;
      item.time = { boil: 60, whirlpool: 20, 'dry hop': 4 }[item.use] ?? null; // a sensible start for the new use
      if (item.use === 'whirlpool') item.temp ??= 80;
      drawTiming();
      el('use').focus();
    }
    drawSubs();
  });
  dlg.addEventListener('click', e => {
    const swap = e.target.closest('.sub');
    if (swap) {
      const hit = byName(HOPS, swap.dataset.s), was = item.name, amount = swapAmount(hit);
      adopt(hit);
      item.amount = amount;
      el('name').value = item.name; el('amount').value = amount;
      drawPicks(); drawSubs();
      el('note').textContent = `Swapped ${was} for ${hit.name}: ${amount} g at ${hit.alpha} %. Press Done to keep it.`;
      return;
    }
    const pick = e.target.closest('.pick');
    if (pick) { adopt(byName(HOPS, pick.dataset.n)); el('name').value = item.name; drawPicks(); el('amount').focus(); el('amount').select(); return; }
    if (e.target.closest('[data-x]') || e.target === dlg) dlg.close();
  });
  dlg.querySelector('form').addEventListener('submit', e => {
    e.preventDefault();
    item.name = item.name.trim();
    if (!item.name) { el('note').textContent = 'Give the hop a name first.'; el('name').focus(); return; }
    if (!Number.isFinite(item.alpha)) item.alpha = 0;
    if (!['boil', 'whirlpool', 'dry hop'].includes(item.use)) delete item.time;
    if (item.use !== 'whirlpool') delete item.temp;
    if (editing) recipe.hops[index] = item; else recipe.hops.push(item);
    dlg.close();
    done();
  });
  dlg.addEventListener('close', () => dlg.remove());
  drawTiming();
  drawPicks();
  drawSubs();
  dlg.showModal();
  if (editing) { el('amount').focus(); el('amount').select(); } else el('name').focus();
}

// Popup for adding a yeast (index null) or editing one. Pick from the built-in list or type your own.
const YEAST_FORMS = ['dry', 'liquid', 'slurry', 'culture'];
function yeastDialog(recipe, index, done) {
  const editing = index != null;
  const item = editing ? clone(recipe.yeasts[index]) : { name: '', lab: '', form: 'dry', attenuation: 75, amount: 1 };
  document.querySelector('dialog.sheet')?.remove();
  const dlg = document.createElement('dialog');
  dlg.className = 'sheet';
  dlg.innerHTML = `<form novalidate>
    <div class="sec-head"><h2>${editing ? 'Edit yeast' : 'Add yeast'}</h2><button type="button" class="icon-btn" data-x aria-label="Close">×</button></div>
    <label class="fld" for="yd-name"><span>Name</span><input id="yd-name" type="search" autocomplete="off" placeholder="Search yeasts" value="${esc(item.name)}"></label>
    <div class="picks" id="yd-picks"></div>
    <p class="hint" id="yd-note" role="status"></p>
    <div class="row">
      <label class="fld" for="yd-amount"><span>Packs</span><input id="yd-amount" type="number" step="1" min="0" inputmode="decimal" value="${esc(item.amount ?? '')}"></label>
      <label class="fld" for="yd-att"><span>Attenuation %</span><input id="yd-att" type="number" step="1" min="0" max="100" inputmode="decimal" value="${esc(item.attenuation ?? '')}"></label>
    </div>
    <div class="row">
      <label class="fld" for="yd-lab"><span>Lab</span><input id="yd-lab" autocomplete="off" value="${esc(item.lab || '')}"></label>
      <label class="fld" for="yd-form"><span>Form</span><select id="yd-form">${YEAST_FORMS.map(f => `<option${f === (item.form || 'dry') ? ' selected' : ''}>${f}</option>`).join('')}</select></label>
    </div>
    <p class="hint">Attenuation sets the estimated FG. Use the lab's figure, or your own from past brews.</p>
    <div class="foot-actions">
      <button type="submit" class="btn primary">${editing ? 'Done' : 'Add to recipe'}</button>
      <button type="button" class="btn" data-x>Cancel</button>
    </div></form>`;
  document.body.append(dlg);
  const el = id => dlg.querySelector('#yd-' + id);
  const drawPicks = () => {
    const q = item.name.trim().toLowerCase(), exact = byName(YEASTS, item.name);
    const hits = editing && exact ? [] : YEASTS.filter(y => !q || exact || `${y.name} ${y.lab}`.toLowerCase().includes(q));
    el('picks').innerHTML = hits.map(y => `<button type="button" class="pick${y === exact ? ' on' : ''}" data-n="${esc(y.name)}"><span>${esc(y.name)}</span><small>${esc(y.lab)} · ${y.attenuation} %</small></button>`).join('');
    el('picks').hidden = !hits.length;
    el('note').textContent = q && !exact ? (hits.length ? 'Pick one from the list, or keep typing to add your own.' : `"${item.name.trim()}" is not in the list. Set its attenuation below.`) : '';
    if (exact) el('picks').querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  };
  const adopt = hit => {
    Object.assign(item, { name: hit.name, lab: hit.lab, form: hit.form, attenuation: hit.attenuation });
    el('lab').value = hit.lab; el('form').value = hit.form; el('att').value = hit.attenuation;
  };
  dlg.addEventListener('input', e => {
    const t = e.target, numOr = v => (v === '' ? null : parseFloat(v));
    if (t === el('name')) { item.name = t.value; const hit = byName(YEASTS, t.value); if (hit) adopt(hit); drawPicks(); }
    else if (t === el('amount')) item.amount = numOr(t.value);
    else if (t === el('att')) item.attenuation = numOr(t.value);
    else if (t === el('lab')) item.lab = t.value;
    else if (t === el('form')) item.form = t.value;
  });
  dlg.addEventListener('click', e => {
    const pick = e.target.closest('.pick');
    if (pick) { adopt(byName(YEASTS, pick.dataset.n)); el('name').value = item.name; drawPicks(); el('amount').focus(); el('amount').select(); return; }
    if (e.target.closest('[data-x]') || e.target === dlg) dlg.close();
  });
  dlg.querySelector('form').addEventListener('submit', e => {
    e.preventDefault();
    item.name = item.name.trim();
    item.lab = (item.lab || '').trim();
    if (!item.name) { el('note').textContent = 'Give the yeast a name first.'; el('name').focus(); return; }
    if (!(item.attenuation > 0 && item.attenuation <= 100)) { el('note').textContent = 'Attenuation must be between 1 and 100 %.'; el('att').focus(); return; }
    if (editing) recipe.yeasts[index] = item; else (recipe.yeasts ??= []).push(item);
    dlg.close();
    done();
  });
  dlg.addEventListener('close', () => dlg.remove());
  drawPicks();
  dlg.showModal();
  if (editing) { el('amount').focus(); el('amount').select(); } else el('name').focus();
}

// Popup for adding an "other addition" (index null) or editing one: finings, nutrients, spices and so on.
// Types are the BeerJSON ones. Only boil additions have a time; the brew-day timer counts down to them.
const MISC_TYPES = ['fining', 'spice', 'herb', 'flavor', 'wood', 'water agent', 'other'];
const MISC_USES = [['mash', 'Mash'], ['boil', 'Boil'], ['fermentation', 'Fermenter'], ['package', 'Packaging']];
function miscDialog(recipe, index, done) {
  const editing = index != null;
  const item = editing ? clone(recipe.miscs[index]) : { name: '', type: 'other', amount: 1, unit: 'g', use: 'boil', time: 10 };
  const types = MISC_TYPES.includes(item.type) ? MISC_TYPES : [...MISC_TYPES, item.type];
  document.querySelector('dialog.sheet')?.remove();
  const dlg = document.createElement('dialog');
  dlg.className = 'sheet';
  dlg.innerHTML = `<form novalidate>
    <div class="sec-head"><h2>${editing ? 'Edit addition' : 'Add addition'}</h2><button type="button" class="icon-btn" data-x aria-label="Close">×</button></div>
    <label class="fld" for="md-name"><span>Name</span><input id="md-name" autocomplete="off" placeholder="For example Irish moss" value="${esc(item.name)}"></label>
    <p class="hint" id="md-note" role="status"></p>
    <div class="row">
      <label class="fld" for="md-amount"><span>Amount</span><input id="md-amount" type="number" step="any" min="0" inputmode="decimal" value="${esc(item.amount ?? '')}"></label>
      <label class="fld" for="md-unit"><span>Unit</span><select id="md-unit">${['g', 'ml', 'each'].map(u => `<option${u === (item.unit || 'g') ? ' selected' : ''}>${u}</option>`).join('')}</select></label>
    </div>
    <div class="row" id="md-timing"></div>
    <div class="row"><label class="fld" for="md-type"><span>Type</span><select id="md-type">${types.map(t => `<option${t === (item.type || 'other') ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select></label></div>
    <div class="foot-actions">
      <button type="submit" class="btn primary">${editing ? 'Done' : 'Add to recipe'}</button>
      <button type="button" class="btn" data-x>Cancel</button>
    </div></form>`;
  document.body.append(dlg);
  const el = id => dlg.querySelector('#md-' + id);
  const drawTiming = () => {
    el('timing').innerHTML = `<label class="fld" for="md-use"><span>Added</span><select id="md-use">${MISC_USES.map(([v, t]) => `<option value="${v}"${v === item.use ? ' selected' : ''}>${t}</option>`).join('')}</select></label>` +
      (item.use === 'boil' ? `<label class="fld" for="md-time"><span>Minutes from the end</span><input id="md-time" type="number" step="5" min="0" inputmode="decimal" value="${esc(item.time ?? '')}"></label>` : '');
  };
  dlg.addEventListener('input', e => {
    const t = e.target, numOr = v => (v === '' ? null : parseFloat(v));
    if (t === el('name')) item.name = t.value;
    else if (t === el('amount')) item.amount = numOr(t.value);
    else if (t === el('unit')) item.unit = t.value;
    else if (t === el('type')) item.type = t.value;
    else if (t.id === 'md-time') item.time = numOr(t.value);
    else if (t.id === 'md-use') { item.use = t.value; if (item.use === 'boil' && item.time == null) item.time = 10; drawTiming(); el('use').focus(); }
  });
  dlg.addEventListener('click', e => { if (e.target.closest('[data-x]') || e.target === dlg) dlg.close(); });
  dlg.querySelector('form').addEventListener('submit', e => {
    e.preventDefault();
    item.name = item.name.trim();
    if (!item.name) { el('note').textContent = 'Give the addition a name first.'; el('name').focus(); return; }
    if (item.use !== 'boil') delete item.time; else if (!Number.isFinite(item.time)) item.time = 0;
    if (editing) recipe.miscs[index] = item; else (recipe.miscs ??= []).push(item);
    dlg.close();
    done();
  });
  dlg.addEventListener('close', () => dlg.remove());
  drawTiming();
  dlg.showModal();
  if (editing) { el('amount').focus(); el('amount').select(); } else el('name').focus();
}

const listActions = {
  add(b) { (ctx.doc[b.dataset.list] ??= []).push(LISTS[b.dataset.list].blank()); ctx.touch(); renderList(b.dataset.list); ctx.update?.(); },
  remove(b) { ctx.doc[b.dataset.list].splice(+b.dataset.i, 1); ctx.touch(); renderList(b.dataset.list); ctx.update?.(); },
};

// Save button shared by the recipe and brew pages.
function saveState(kind, id) {
  const b = $('#save-btn');
  if (!b) return;
  const dirty = store.isDirty(kind, id);
  b.disabled = !dirty || !store.canWrite;
  b.textContent = !store.canWrite ? 'Saved on this device' : dirty ? store.words.save : store.words.saved;
  const r = $('#revert-btn');
  if (r) r.hidden = !(dirty && store.canWrite);
}
async function commit(kind, id) {
  try { await store.push(kind, id); toast(store.words.done); } catch (e) { toast(e.message, true); }
}

// ---------- view plumbing ----------
let ctx = {};
view.addEventListener('input', e => {
  const t = e.target, path = t.dataset.p;
  if (!path) return ctx.raw?.(t);
  const value = t.type === 'checkbox' ? t.checked : t.type === 'number' ? (t.value === '' ? null : parseFloat(t.value)) : t.value;
  setPath(ctx.doc, path, value);
  ctx.touch();
  ctx.update?.();
});
view.addEventListener('change', e => ctx.change?.(e.target));
view.addEventListener('submit', e => { e.preventDefault(); ctx.submit?.(e.target); });
view.addEventListener('click', e => {
  const b = e.target.closest('[data-act]');
  const fn = b && ctx.actions?.[b.dataset.act];
  if (fn) { e.preventDefault(); fn(b); }
});

// ---------- recipe versions ----------
// Every version of a recipe is its own document. They share a `family` (the id of the first
// version) and count up from version 1. Recipes from before versions existed have neither
// field: they are version 1 of a family named after their own id.
const familyOf = (id, r) => r?.family || id;
const versionOf = r => +r?.version || 1;
const vName = r => (versionOf(r) > 1 ? `${r.name} v${versionOf(r)}` : r.name);
function versionsOf(family) {
  return store.list('recipes').filter(x => familyOf(x.id, x.data) === family).sort((a, b) => versionOf(a.data) - versionOf(b.data));
}
// The newest version of each recipe: what the recipe list and the brew picker show.
function latestOnly(list) {
  const best = new Map();
  for (const x of list) {
    const f = familyOf(x.id, x.data), cur = best.get(f);
    if (!cur || versionOf(x.data) > versionOf(cur.data)) best.set(f, x);
  }
  return [...best.values()];
}
// In the brew queue, a recipe's place passes to its newest version.
function swapInQueue(oldId, newId) {
  const order = store.get('settings', 'settings')?.brewOrder || [];
  if (!order.includes(oldId)) return;
  saveQueue(order.map(x => (x === oldId ? newId : x)).filter((x, i, a) => a.indexOf(x) === i));
}

// Popup: a new version of recipe `id`. It starts as a copy and takes the next free number.
function newVersionDialog(id) {
  const r = store.get('recipes', id), family = familyOf(id, r);
  const all = versionsOf(family), next = versionOf(all.at(-1)?.data) + 1;
  sheetDialog(`<div class="sec-head"><h2>New version</h2><button type="button" class="icon-btn" data-x aria-label="Close">×</button></div>
    <p class="hint">Version ${next} starts as a copy of version ${versionOf(r)}. Version ${versionOf(r)} stays as it is, and brews made from it keep their link to it.</p>
    <div class="row"><label class="fld w-name" for="nv-note"><span>What will change</span><input id="nv-note" autocomplete="off" placeholder="For example less crystal, more Citra"></label></div>
    <div class="foot-actions"><button type="submit" class="btn primary">Create version ${next}</button><button type="button" class="btn" data-x>Cancel</button></div>`,
  dlg => {
    const copy = clone(r), nid = `${slug(r.name)}-v${next}-${uid()}`;
    Object.assign(copy, { family, version: next, versionNote: dlg.querySelector('#nv-note').value.trim(), created: today(), modified: today() });
    if (!copy.versionNote) delete copy.versionNote;
    store.put('recipes', nid, copy);
    swapInQueue(all.at(-1).id, nid);
    location.hash = '#recipe/' + nid;
    toast(`Version ${next} created.`);
  });
}

// Popup: a new recipe with its own name, blank or started from another recipe.
function newRecipeDialog(baseId = '') {
  const choices = latestOnly(store.list('recipes')).sort((a, b) => a.data.name.localeCompare(b.data.name));
  if (baseId && !choices.some(x => x.id === baseId)) choices.unshift({ id: baseId, data: store.get('recipes', baseId) }); // an older version
  const base = baseId && store.get('recipes', baseId);
  sheetDialog(`<div class="sec-head"><h2>New recipe</h2><button type="button" class="icon-btn" data-x aria-label="Close">×</button></div>
    <div class="row"><label class="fld w-name" for="nr-name"><span>Name</span><input id="nr-name" autocomplete="off" value="${base ? '' : 'New recipe'}" placeholder="A name of its own"></label></div>
    <div class="row"><label class="fld w-name" for="nr-base"><span>Start from</span><select id="nr-base"><option value="">A blank recipe</option>${choices.map(x => `<option value="${x.id}"${x.id === baseId ? ' selected' : ''}>${esc(vName(x.data))}</option>`).join('')}</select></label></div>
    <p class="hint" id="nr-note" role="status">${base ? 'The new recipe starts as a copy and remembers what it was based on. To change this recipe and keep its name, make a new version instead.' : ''}</p>
    <div class="foot-actions"><button type="submit" class="btn primary">Create recipe</button><button type="button" class="btn" data-x>Cancel</button></div>`,
  dlg => {
    const name = dlg.querySelector('#nr-name').value.trim(), from = dlg.querySelector('#nr-base').value, src = from && store.get('recipes', from);
    const note = dlg.querySelector('#nr-note');
    if (!name) { note.textContent = 'Give the recipe a name.'; dlg.querySelector('#nr-name').focus(); return false; }
    if (store.list('recipes').some(x => x.data.name.trim().toLowerCase() === name.toLowerCase())) {
      note.textContent = `There is already a recipe called ${name}. Choose another name, or open that recipe and make a new version of it.`;
      dlg.querySelector('#nr-name').focus();
      return false;
    }
    let r;
    if (src) {
      r = clone(src);
      for (const k of ['family', 'version', 'versionNote']) delete r[k];
      Object.assign(r, { name, status: 'planning', basedOn: { id: from, name: src.name, version: versionOf(src) } });
    } else r = blankRecipe(defaultProfile());
    Object.assign(r, { name, created: today(), modified: today() });
    const id = `${slug(name)}-${uid()}`;
    store.put('recipes', id, r);
    location.hash = '#recipe/' + id;
  }, dlg => dlg.querySelector('#nr-name').focus());
}

// A small popup with a form. onSubmit(dlg) returns false to keep it open.
function sheetDialog(html, onSubmit, onOpen) {
  document.querySelector('dialog.sheet')?.remove();
  const dlg = document.createElement('dialog');
  dlg.className = 'sheet';
  dlg.innerHTML = `<form novalidate>${html}</form>`;
  document.body.append(dlg);
  dlg.addEventListener('click', e => { if (e.target.closest('[data-x]') || e.target === dlg) dlg.close(); });
  dlg.querySelector('form').addEventListener('submit', e => { e.preventDefault(); if (onSubmit(dlg) !== false) dlg.close(); });
  dlg.addEventListener('close', () => dlg.remove());
  dlg.showModal();
  (onOpen || (d => d.querySelector('input')?.focus()))(dlg);
}

// ---------- recipes list ----------
// The brew queue: recipe ids in the order you plan to brew them, kept in settings.json
// so one drag is one small commit. Recipes not in the list yet sit at the bottom.
function queued(items) {
  const pos = new Map((store.get('settings', 'settings')?.brewOrder || []).map((id, i) => [id, i]));
  return [...items].sort((a, b) => (pos.get(a.id) ?? 1e9) - (pos.get(b.id) ?? 1e9)
    || (b.data.modified || '').localeCompare(a.data.modified || '') || a.data.name.localeCompare(b.data.name));
}
function saveQueue(ids) {
  const doc = clone(store.get('settings', 'settings') || {});
  doc.brewOrder = ids;
  store.put('settings', 'settings', doc);
}

// Drag rows by their grip (pointer or touch), or move them with the arrow keys. onMove(from, to) gets list indexes.
function enableReorder(list, onMove) {
  list.addEventListener('pointerdown', e => {
    const grip = e.target.closest('.grip');
    if (!grip || e.button > 0) return;
    const rows = [...list.querySelectorAll('.q-row')], row = grip.closest('.q-row'), from = rows.indexOf(row);
    const rects = rows.map(r => { const box = r.getBoundingClientRect(); return { top: box.top + scrollY, h: box.height }; });
    const step = rects[from].h + (rows.length > 1 ? rects[1].top - rects[0].top - rects[0].h : 0);
    const startY = e.pageY;
    let to = from, clientY = e.clientY, raf;
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    row.classList.add('dragging');
    const place = pageY => {
      const dy = pageY - startY, centre = rects[from].top + rects[from].h / 2 + dy;
      row.style.transform = `translateY(${dy}px)`;
      to = from;
      rows.forEach((r, i) => {
        if (i === from) return;
        const mid = rects[i].top + rects[i].h / 2;
        let shift = 0;
        if (i > from && centre > mid) { shift = -step; to = Math.max(to, i); }
        if (i < from && centre < mid) { shift = step; to = Math.min(to, i); }
        r.style.transform = shift ? `translateY(${shift}px)` : '';
      });
    };
    const move = ev => { clientY = ev.clientY; place(ev.pageY); };
    const edge = () => { // scroll the page when the row is held near the top or bottom
      const d = clientY < 130 ? -9 : clientY > innerHeight - 130 ? 9 : 0;
      if (d) { scrollBy(0, d); place(clientY + scrollY); }
      raf = requestAnimationFrame(edge);
    };
    const end = () => {
      cancelAnimationFrame(raf);
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', end);
      grip.removeEventListener('pointercancel', end);
      rows.forEach(r => { r.style.transform = ''; });
      row.classList.remove('dragging');
      if (to !== from) onMove(from, to);
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
    raf = requestAnimationFrame(edge);
  });
  list.addEventListener('keydown', e => {
    const grip = e.target.closest('.grip');
    if (!grip || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    const rows = [...list.querySelectorAll('.q-row')], from = rows.indexOf(grip.closest('.q-row'));
    const to = from + (e.key === 'ArrowUp' ? -1 : 1);
    if (to < 0 || to >= rows.length) return;
    onMove(from, to);
    list.querySelectorAll('.grip')[to]?.focus();
  });
}

const RECIPE_SORTS = [['queue', 'Brew queue'], ['recent', 'Recently edited'], ['name', 'Name']];
const RECIPE_SHOWS = [['all', 'All recipes'], ['ready', 'Ready to brew'], ['planning', 'In planning']];
let recipeSort = 'queue', recipeShow = 'all';
const isReady = data => data.status === 'ready';

function recipesView() {
  let shown = []; // what is on screen, in order
  ctx = {
    q: ctx.q || '',
    raw(t) {
      if (t.id === 'q') { ctx.q = t.value; draw(); }
      if (t.id === 'sort') { recipeSort = t.value; draw(); }
      if (t.id === 'show') { recipeShow = t.value; draw(); }
    },
    change(t) { if (t.id === 'import-file') importFiles(t.files); },
    actions: {
      new: () => newRecipeDialog(),
      import() { $('#import-file').click(); },
    },
  };
  view.innerHTML = `
    <div class="page-head"><h1>Recipes</h1>
      <div class="actions"><button type="button" class="btn" data-act="import">Import</button><button type="button" class="btn primary" data-act="new">New recipe</button></div>
    </div>
    <input type="file" id="import-file" accept=".xml,.beerxml,.json,application/json,text/xml" multiple hidden>
    <div class="row list-tools">
      <label class="fld search w-name" for="q"><span>Search by name or style</span><input id="q" type="search" value="${esc(ctx.q)}"></label>
      <label class="fld search" for="sort"><span>Order</span><select id="sort">${RECIPE_SORTS.map(([v, t]) => `<option value="${v}"${v === recipeSort ? ' selected' : ''}>${t}</option>`).join('')}</select></label>
      <label class="fld search" for="show"><span>Show</span><select id="show">${RECIPE_SHOWS.map(([v, t]) => `<option value="${v}"${v === recipeShow ? ' selected' : ''}>${t}</option>`).join('')}</select></label>
    </div>
    <p class="hint on-wall" id="queue-hint"></p>
    <div id="recipe-list" class="list"></div>`;
  enableReorder($('#recipe-list'), (from, to) => {
    const ids = shown.map(x => x.id);
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    saveQueue(ids); // redraws through the store's change event
  });
  function draw() {
    const q = ctx.q.trim().toLowerCase();
    const all = latestOnly(store.list('recipes'));
    const sorted = recipeSort === 'queue' ? queued(all)
      : recipeSort === 'name' ? [...all].sort((a, b) => a.data.name.localeCompare(b.data.name))
      : [...all].sort((a, b) => (b.data.modified || '').localeCompare(a.data.modified || '') || a.data.name.localeCompare(b.data.name));
    shown = sorted.filter(({ data }) => (!q || `${data.name} ${data.style}`.toLowerCase().includes(q))
      && (recipeShow === 'all' || (recipeShow === 'ready') === isReady(data)));
    const whole = !q && recipeShow === 'all';
    const canDrag = recipeSort === 'queue' && whole && shown.length > 1;
    const nextId = queued(all).find(x => isReady(x.data))?.id; // the first ready recipe in the queue is the next brew
    $('#queue-hint').textContent = recipeSort !== 'queue' || !all.length ? ''
      : !whole ? 'Show all recipes with no search to reorder the queue.'
      : shown.length > 1 ? `Your brew queue: drag a handle to reorder. ${nextId ? 'The first recipe that is ready to brew is next.' : 'Nothing is flagged ready to brew yet.'}` : '';
    $('#recipe-list').innerHTML = shown.length ? shown.map(({ id, data, dirty }, i) => {
      const s = C.recipeStats(data, equipFor(data));
      return `<div class="q-row">
        ${canDrag ? `<button type="button" class="grip" aria-label="Move ${esc(data.name)}, now number ${i + 1} in the queue. Drag, or use the up and down arrow keys."><b>${i + 1}</b><svg viewBox="0 0 10 16" width="10" height="16" aria-hidden="true"><g fill="currentColor"><circle cx="2" cy="2" r="1.6"/><circle cx="8" cy="2" r="1.6"/><circle cx="2" cy="8" r="1.6"/><circle cx="8" cy="8" r="1.6"/><circle cx="2" cy="14" r="1.6"/><circle cx="8" cy="14" r="1.6"/></g></svg></button>` : ''}
        <a class="item" href="#recipe/${id}">
        ${pint(C.srmToHex(s.srm), 34)}
        <span class="item-main">${id === nextId ? '<span class="next-tag">Next brew</span>' : ''}<strong>${esc(data.name)}</strong><small>${versionOf(data) > 1 ? `v${versionOf(data)} · ` : ''}${esc(data.style || 'No style')} · ${n(data.batchSize, 0)} L${dirty && store.connected ? ` · <em>${store.words.unsaved}</em>` : ''}</small></span>
        <span class="pill ${isReady(data) ? 's-finished' : ''}">${isReady(data) ? 'Ready' : 'Planning'}</span>
        <span class="item-stats"><span><b>${sg(s.og)}</b> OG</span><span><b>${n(s.ibu, 0)}</b> IBU</span><span><b>${n(s.abv)}</b> %</span></span>
      </a></div>`;
    }).join('') : all.length ? '<p class="empty">No recipes match.</p>'
      : `<div class="empty-state"><h2>No recipes yet</h2><p>Start a new recipe, or import BeerXML or BeerJSON files exported from BeerSmith or Brewfather.${store.connected ? '' : ' Choose where to keep them in Settings.'}</p></div>`;
  }
  ctx.refresh = draw;
  draw();
}

async function importFiles(files) {
  const added = [];
  for (const file of files) {
    try {
      const text = decodeXmlBytes(await file.arrayBuffer());
      const recipes = text.trimStart().startsWith('<') ? parseBeerXML(text) : fromBeerJSON(JSON.parse(text));
      for (const r of recipes) {
        const id = `${slug(r.name)}-${uid()}`;
        r.modified = today();
        store.put('recipes', id, r);
        added.push(id);
      }
    } catch (e) {
      toast(`${file.name}: ${e instanceof SyntaxError ? 'not valid JSON or XML.' : e.message}`, true);
    }
  }
  if (!added.length) return;
  toast(`Imported ${added.length} recipe${added.length > 1 ? 's' : ''}.`);
  if (added.length === 1) location.hash = '#recipe/' + added[0]; else ctx.refresh?.();
}

// ---------- recipe editor ----------
const SCALE = { og: [1.02, 1.13], fg: [0.996, 1.036], ibu: [0, 120], ebc: [0, 90], abv: [0, 14] };
// `key` names a fixed scale in SCALE, or is a [low, high] pair. `words` are the verdicts for below, above and inside the range.
function gauge(key, label, value, text, range, rangeText, d = 0, extra = '', words = ['below style', 'above style', 'in style'], none = 'no style range') {
  const [lo, hi] = Array.isArray(key) ? key : SCALE[key];
  const pos = x => Math.max(0, Math.min(100, (x - lo) / (hi - lo) * 100));
  let state = '', verdict = '';
  if (range && Number.isFinite(value)) {
    const shown = +value.toFixed(d); // judge the number as displayed
    state = shown < +range[0].toFixed(d) ? 'low' : shown > +range[1].toFixed(d) ? 'high' : 'ok';
    verdict = { low: words[0], high: words[1], ok: words[2] }[state];
  }
  return `<div class="gauge ${state}">
    <div class="g-top"><span class="g-label">${label}</span><span class="g-value">${text}</span></div>
    <div class="g-track">${range ? `<span class="g-band" style="left:${pos(range[0])}%;width:${Math.max(2, pos(range[1]) - pos(range[0]))}%"></span>` : ''}<span class="g-mark" style="left:${pos(value)}%"></span></div>
    <div class="g-foot">${range ? `${rangeText} · <b>${verdict}</b>` : none}${extra}</div>
  </div>`;
}

// Under the recipe name: which version this is, links to the others, and what it was based on.
function versionBar(id, r) {
  const all = versionsOf(familyOf(id, r)), latest = all.at(-1);
  const based = r.basedOn && (store.get('recipes', r.basedOn.id)
    ? `<a href="#recipe/${esc(r.basedOn.id)}">${esc(vName(r.basedOn))}</a>` : esc(vName(r.basedOn)));
  const parts = [];
  if (all.length > 1) {
    parts.push(`<span class="v-list" aria-label="Versions">${all.map(x => x.id === id
      ? `<b aria-current="page">v${versionOf(x.data)}</b>` : `<a href="#recipe/${x.id}" title="${esc(x.data.versionNote || '')}">v${versionOf(x.data)}</a>`).join('')}</span>`);
  }
  if (based) parts.push(`<span>Based on ${based}</span>`);
  const old = latest && latest.id !== id
    ? `<p class="v-old">This is version ${versionOf(r)}. The newest is <a href="#recipe/${latest.id}">version ${versionOf(latest.data)}</a>.</p>` : '';
  return parts.length || old ? `<div class="v-bar">${parts.join('')}</div>${old}` : '';
}

function recipeView(id) {
  const r = store.get('recipes', id);
  if (!r) return notFound('recipe', '#recipes');
  ctx = {
    doc: r,
    touch() { r.modified = today(); store.touch('recipes', id); },
    update,
    actions: {
      ...listActions,
      save: () => commit('recipes', id),
      async revert(btn) {
        if (!confirmTap(btn, 'Tap again to discard')) return;
        try { await store.revert('recipes', id); route(); } catch (e) { toast(e.message, true); }
      },
      'new-version': () => newVersionDialog(id),
      'new-from': () => newRecipeDialog(id),
      delete(btn) {
        if (!confirmTap(btn, versionsOf(familyOf(id, r)).length > 1 ? `Tap again to delete v${versionOf(r)}` : 'Tap again to delete')) return;
        const family = familyOf(id, r);
        store.remove('recipes', id);
        const rest = versionsOf(family);
        if (rest.length) { swapInQueue(id, rest.at(-1).id); location.hash = '#recipe/' + rest.at(-1).id; } else location.hash = '#recipes';
      },
      'export-json': () => download(slug(vName(r)) + '.json', JSON.stringify(toBeerJSON(r), null, 2), 'application/json'),
      'export-xml': () => download(slug(vName(r)) + '.xml', toBeerXML(r), 'text/xml'),
      brew() { location.hash = '#brew/' + newBrew(id, r); },
      status(btn) { r.status = btn.dataset.v; ctx.touch(); update(); },
      'add-ferm': () => fermentableDialog(r, null, () => { ctx.touch(); renderList('fermentables'); update(); }),
      'edit-ferm': btn => fermentableDialog(r, +btn.dataset.i, () => { ctx.touch(); renderList('fermentables'); update(); }),
      'suggest-salts'() {
        const tgt = targetFor(r);
        if (!tgt) return toast('Choose a target profile first.', true);
        const litres = C.recipeStats(r, equipFor(r)).totalWater;
        r.water = { ...r.water, source: sourceFor(r).id, target: tgt.id, salts: C.suggestSalts(sourceFor(r), tgt, litres) };
        ctx.touch(); drawWater(); update();
        toast(saltList(r).length ? `Salts set for ${tgt.name}.` : 'Your water already meets or exceeds this target. Salts can only add minerals.');
      },
      'suggest-acid'(btn) {
        r.water = { ...r.water, acid: { type: r.water?.acid?.type || 'lactic88', ml: +btn.dataset.ml } };
        ctx.touch(); drawWater(); update();
      },
      'add-hop': () => hopDialog(r, null, () => { ctx.touch(); renderList('hops'); update(); }),
      'edit-hop': btn => hopDialog(r, +btn.dataset.i, () => { ctx.touch(); renderList('hops'); update(); }),
      'add-yeast': () => yeastDialog(r, null, () => { ctx.touch(); renderList('yeasts'); update(); }),
      'edit-yeast': btn => yeastDialog(r, +btn.dataset.i, () => { ctx.touch(); renderList('yeasts'); update(); }),
      'add-misc': () => miscDialog(r, null, () => { ctx.touch(); renderList('miscs'); update(); }),
      'edit-misc': btn => miscDialog(r, +btn.dataset.i, () => { ctx.touch(); renderList('miscs'); update(); }),
      // Rescale every ingredient so OG and IBU stay put on the chosen profile's batch size and efficiency.
      fit() {
        const eq = equipFor(r), before = C.recipeStats(r, eq);
        if (!(r.batchSize > 0) || !(eq.batchSize > 0) || !(eq.efficiency > 0)) return toast('Batch size and efficiency must be above zero to scale.', true);
        const vol = eq.batchSize / r.batchSize, eff = r.efficiency / eq.efficiency;
        const kettle = (+eq.batchSize + +eq.kettleLoss) / (+r.batchSize + +eq.kettleLoss);
        r.fermentables.forEach(f => { f.amount = +((+f.amount || 0) * vol * (C.isMashed(f) ? eff : 1)).toFixed(2); });
        r.hops.forEach(h => { h.amount = Math.round((+h.amount || 0) * (h.use === 'dry hop' ? vol : kettle)); });
        r.miscs.forEach(m => { m.amount = +((+m.amount || 0) * vol).toFixed(m.unit === 'each' ? 0 : 1); });
        r.batchSize = +eq.batchSize; r.efficiency = +eq.efficiency;
        ctx.touch();
        route();
        const after = C.recipeStats(r, eq);
        toast(`Scaled to ${n(+eq.batchSize)} L. OG ${sg(before.og)} → ${sg(after.og)}, IBU ${n(before.ibu, 0)} → ${n(after.ibu, 0)}.`);
      },
    },
    refresh: () => saveState('recipes', id),
    ref: () => store.get('recipes', id),
  };

  view.innerHTML = `
    <div class="page-head"><a class="back" href="#recipes">← Recipes</a>
      <div class="actions"><button type="button" class="btn ghost" id="revert-btn" data-act="revert" hidden>Discard changes</button><button type="button" class="btn primary" id="save-btn" data-act="save"></button></div>
    </div>
    <section class="label-card">
      <div class="label-main"><span class="overline" id="hero-over"></span>
        <label class="title-fld" for="f-name"><span class="sr">Recipe name</span><input id="f-name" class="title-input" data-p="name" value="${esc(r.name)}"></label>
        ${versionBar(id, r)}
        <div class="segs status" id="status-toggle" role="group" aria-label="Recipe status"></div></div>
      <div class="label-art" id="hero-art"></div>
    </section>
    <section class="gauges" id="gauges" aria-label="Recipe numbers"></section>
    <section class="card"><div class="sec-head"><h2>Batch</h2></div><div class="row">
      ${field({ label: 'Style', cls: 'w-name', list: 'dl-style' }, 'style', r.style)}
      ${field({ label: 'Batch L', num: 1 }, 'batchSize', r.batchSize)}
      ${field({ label: 'Boil min', num: 1 }, 'boilTime', r.boilTime)}
      ${field({ label: 'Efficiency %', num: 1 }, 'efficiency', r.efficiency)}
      ${field({ label: 'Brewer' }, 'author', r.author)}
      ${field({ label: 'Equipment', cls: 'w-name', opts: profiles().map(p => [p.id, p.name]) }, 'equipment', equipFor(r).id)}
    </div><p class="hint" id="fit-line"></p></section>
    ${['fermentables', 'hops', 'yeasts', 'miscs'].map(k => `<section class="card" id="sec-${k}"></section>`).join('')}
    <section class="card" id="sec-mash"></section>
    <section class="card" id="sec-water"></section>
    <section class="card" id="sec-fermentation"></section>
    <section class="card"><div class="sec-head"><h2>Packaging & notes</h2></div>
      <div class="row">${field({ label: 'Carbonation, vols CO₂', num: 1, step: 0.1 }, 'carbonation', r.carbonation)}${field({ label: 'Mash ratio L/kg', num: 1, step: 0.1 }, 'mashRatio', r.mashRatio)}</div>
      ${versionOf(r) > 1 ? field({ label: `What changed in version ${versionOf(r)}`, cls: 'block' }, 'versionNote', r.versionNote || '') : ''}
      ${field({ label: 'Notes', area: 5, cls: 'block' }, 'notes', r.notes)}
    </section>
    <div class="foot-actions">
      <button type="button" class="btn primary" data-act="brew">Brew this recipe</button>
      <a class="btn" href="#sheet/${id}">Brew sheet</a>
      <button type="button" class="btn" data-act="new-version">New version</button>
      <button type="button" class="btn" data-act="new-from">New recipe from this</button>
      <button type="button" class="btn" data-act="export-json">Export BeerJSON</button>
      <button type="button" class="btn" data-act="export-xml">Export BeerXML</button>
      <button type="button" class="btn danger" data-act="delete">Delete</button>
    </div>`;
  ['fermentables', 'hops', 'yeasts', 'miscs', 'mash', 'fermentation'].forEach(renderList);
  let poured = false; // the pint pours once, when the recipe opens
  const drawWater = () => {
    const w = r.water || {};
    $('#sec-water').innerHTML = `<div class="sec-head"><h2>Water</h2><button type="button" class="btn small" data-act="suggest-salts">Suggest salts</button></div>
      <div class="row">
        ${field({ label: 'Your water', cls: 'w-name', opts: sourceWaters().map(x => [x.id, x.name]) }, 'water.source', sourceFor(r).id)}
        ${field({ label: 'Target profile', cls: 'w-name', opts: [['', 'No target'], ...targetWaters().map(x => [x.id, x.name])] }, 'water.target', w.target || '')}
      </div>
      <div class="row salts">${Object.entries(C.SALTS).map(([k, d]) => field({ label: `${d.name} g`, num: 1, step: 0.1 }, `water.salts.${k}`, w.salts?.[k] ?? '')).join('')}</div>
      <div id="water-table"></div>
      <div class="ph-block">
        <h3>Mash pH</h3>
        <div class="row">
          ${field({ label: 'Acid', cls: 'w-name', opts: Object.entries(C.ACIDS).map(([k, a]) => [k, a.name]) }, 'water.acid.type', w.acid?.type || 'lactic88')}
          ${field({ label: 'Acid ml', num: 1, step: 0.1 }, 'water.acid.ml', w.acid?.ml ?? '')}
          ${field({ label: 'Target pH', num: 1, step: 0.05 }, 'water.targetPh', w.targetPh ?? 5.4)}
        </div>
        <div id="ph-out"></div>
      </div>`;
  };
  drawWater();

  function update() {
    const eq = equipFor(r);
    const s = C.recipeStats(r, eq);
    const st = findStyle(r.style);
    $('#hero-over').textContent = `${r.style || 'No style set'} · ${n(+r.batchSize, 0)} L`;
    const ready = r.status === 'ready';
    $('#status-toggle').innerHTML = [['planning', 'In planning'], ['ready', 'Ready to brew']].map(([v, t]) =>
      `<button type="button" class="seg${(v === 'ready') === ready ? ' on' : ''}" data-act="status" data-v="${v}" aria-pressed="${(v === 'ready') === ready}">${t}</button>`).join('');
    $('#hero-art').innerHTML = pint(C.srmToHex(s.srm), 84, 1, !poured) + `<span class="stamp"><b>${n(s.abv)}</b>% ABV</span>`;
    poured = true;
    $('#fit-line').innerHTML = +r.batchSize === +eq.batchSize && +r.efficiency === +eq.efficiency
      ? `Water volumes and IBU use the ${esc(eq.name)} profile.`
      : `${esc(eq.name)} brews ${n(+eq.batchSize)} L at ${n(+eq.efficiency, 0)} % efficiency; this recipe is set to ${n(+r.batchSize)} L at ${n(+r.efficiency, 0)} %. <button type="button" class="btn small" data-act="fit">Scale recipe to fit</button>`;
    const rng = (a, d) => `${a[0].toFixed(d)}–${a[1].toFixed(d)}`;
    $('#gauges').innerHTML =
      gauge('og', 'OG', s.og, sg(s.og), st?.og, st && rng(st.og, 3), 3) +
      gauge('fg', 'FG', s.fg, sg(s.fg), st?.fg, st && rng(st.fg, 3), 3) +
      gauge('ibu', 'IBU', s.ibu, n(s.ibu, 0), st?.ibu, st && rng(st.ibu, 0)) +
      gauge('ebc', `Colour <i class="dot" style="background:${C.srmToHex(s.srm)}"></i>`, s.ebc, `${n(s.ebc, 0)} EBC`, st?.srm.map(C.srmToEbc), st && rng(st.srm.map(C.srmToEbc), 0), 0, `<br>same as ${n(s.srm, 0)} SRM`) +
      gauge('abv', 'ABV', s.abv, `${n(s.abv)} %`, st?.abv, st && rng(st.abv, 1), 1) +
      `<div class="gauge plain"><div class="g-top"><span class="g-label">BU:GU</span><span class="g-value">${n(s.buGu, 2)}</span></div>
        <div class="g-foot">${n(s.totalKg, 2)} kg fermentables · ${n((r.hops || []).reduce((a, h) => a + (+h.amount || 0), 0), 0)} g hops</div></div>`;
    s.fermPct.forEach((p, i) => { const o = $(`#d-fermentables-${i}`); if (o) o.textContent = `${n(p, 0)} %`; });
    s.hopIbus.forEach((v, i) => { const o = $(`#d-hops-${i}`); if (o) o.textContent = r.hops[i].use === 'dry hop' ? '' : `${n(v, 0)} IBU`; });
    const w = $('#water');
    if (w) w.innerHTML = s.grainKg > 0
      ? `<span><b>${n(s.mashWater)} L</b> strike water at <b>${n(s.strikeTemp)} °C</b></span><span><b>${n(s.spargeWater)} L</b> sparge</span><span><b>${n(s.preBoilVol)} L</b> pre-boil at <b>${sg(s.preBoilSG)}</b></span>`
      : `<span><b>${n(s.preBoilVol)} L</b> pre-boil at <b>${sg(s.preBoilSG)}</b></span>`;
    // Hop aroma of the whole recipe: each hop's profile, weighted by grams and how late it goes in.
    const mix = AROMA_AXES.map(() => 0);
    let weightSum = 0, unknown = 0;
    (r.hops || []).forEach(h => {
      const w = (+h.amount || 0) * aromaWeight(h), a = hopAroma(h.name);
      if (!w) return;
      if (!a) { unknown++; return; }
      a.forEach((v, i) => { mix[i] += v * w; });
      weightSum += w;
    });
    const ha = $('#hop-aroma');
    if (ha) ha.innerHTML = weightSum ? `<div class="aroma-box"><h3>Hop aroma of this recipe</h3>${radar(mix.map(v => v / weightSum), { size: 300, labels: true })}
      <p class="hint">${aromaWords(mix.map(v => v / weightSum))}. Late boil, whirlpool and dry hop additions count, weighted by weight; this shows character, not strength.${unknown ? ` ${unknown} hop${unknown > 1 ? 's' : ''} without aroma data left out.` : ''}</p></div>` : '';

    // Water: what the salts do to the source water, against the target.
    const src = sourceFor(r), tgt = targetFor(r), got = C.waterWithSalts(src, r.water?.salts, s.totalWater);
    const ratio = got.cl > 0 ? got.so4 / got.cl : null;
    // One gauge per ion: the band is the target give or take 20% (at least 15 ppm), the marker is the treated water.
    const WORDS = ['below target', 'above target', 'on target'];
    $('#water-table').innerHTML = `<div class="gauges inset">${C.IONS.map(i => {
      const t = tgt?.[i], tol = tgt ? Math.max(15, 0.2 * t) : 0;
      const top = Math.max(60, (t || 0) * 1.6, got[i] * 1.15);
      return gauge([0, top], ION_LABELS[i], got[i], `${n(got[i], 0)} <small>ppm</small>`, tgt && [Math.max(0, t - tol), t + tol],
        tgt && `target ${n(t, 0)}`, 0, '', ['low', 'high', 'good'], 'no target');
    }).join('')}</div>
      <p class="hint">Salts are dissolved in all ${n(s.totalWater)} L of brewing water (mash plus sparge).${ratio == null ? '' : ` Sulfate to chloride is ${n(ratio, 1)}: ${ratio > 2 ? 'leans dry and bitter' : ratio < 0.7 ? 'leans full and malty' : 'balanced'}.`}</p>`;

    // Mash pH from the treated water, the grist and any acid.
    const target = +r.water?.targetPh || 5.4, m = C.mashPh(r, got, s.mashWater, grainDiPh);
    if (!m) $('#ph-out').innerHTML = '<p class="hint">Add grain to estimate mash pH.</p>';
    else {
      const need = +m.mlFor(target).toFixed(1), have = +r.water?.acid?.ml || 0;
      const state = Math.abs(+m.ph.toFixed(2) - target) <= 0.05 ? 'ok' : m.ph > target ? 'high' : 'low';
      const advice = state === 'ok' ? 'On target.'
        : need > 0 ? `${n(need)} ml of ${m.acid.name.toLowerCase()} would bring it to ${n(target, 2)}. <button type="button" class="btn small" data-act="suggest-acid" data-ml="${need}">Use ${n(need)} ml</button>`
        : have > 0 ? `That is below target. No acid is needed for ${n(target, 2)}. <button type="button" class="btn small" data-act="suggest-acid" data-ml="0">Remove the acid</button>`
        : 'That is already below target without acid. A little baking soda would raise it.';
      $('#ph-out').innerHTML = `<div class="gauges inset one">${gauge([4.8, 6.2], 'Estimated mash pH', m.ph, n(m.ph, 2), [target - 0.05, target + 0.05], `target ${n(target, 2)}`, 2, '', WORDS)}</div>
        <p class="hint">${advice}</p>
        <p class="hint">Without acid this mash would sit at about ${n(m.phNoAcid, 2)}. The estimate is good to roughly ±0.1, so check with a pH meter. Acid goes into the ${n(s.mashWater)} L of mash water; sparge water is not acidified here.</p>`;
    }
    saveState('recipes', id);
  }
  update();
}

// ---------- brews ----------
const STATUSES = ['planned', 'brew day', 'fermenting', 'conditioning', 'packaged', 'finished'];

function newBrew(recipeId, r) {
  const count = store.list('brews').length + 1;
  const id = `${today()}-${slug(r.name)}-${uid()}`;
  store.put('brews', id, {
    name: `${vName(r)} #${count}`, recipeId, recipe: clone(r), equipment: clone(equipFor(r)), status: 'planned', brewDate: today(), packagedDate: '',
    measured: { preBoilVol: null, preBoilSG: null, og: null, fermenterVol: null, fg: null },
    readings: [], checklist: {}, notes: '', tasting: '', rating: null,
  });
  return id;
}

function brewSteps(r, eq) {
  const s = C.recipeStats(r, eq), steps = [];
  const hops = (r.hops || []).filter(h => h.name || h.amount);
  const hop = h => `${n(+h.amount, 0)} g ${h.name}`;
  if (saltList(r).length) steps.push(`Treat ${n(s.totalWater)} L of brewing water: ${saltList(r).join(', ')}`);
  if (r.water?.acid?.ml > 0 && s.grainKg > 0) steps.push(`Add ${n(+r.water.acid.ml)} ml of ${(C.ACIDS[r.water.acid.type] || C.ACIDS.lactic88).name.toLowerCase()} to the mash water`);
  if (s.grainKg > 0) {
    steps.push(`Heat ${n(s.mashWater)} L of strike water to ${n(s.strikeTemp)} °C and mash in ${n(s.grainKg, 2)} kg of grain`);
    hops.filter(h => h.use === 'mash').forEach(h => steps.push(`Mash hops: ${hop(h)}`));
    (r.miscs || []).filter(m => m.use === 'mash').forEach(m => steps.push(`Add to mash: ${m.amount} ${m.unit} ${m.name}`));
    (r.mash || []).forEach(m => steps.push(`${m.name}: hold ${m.temp} °C for ${m.time} min`));
    if (s.spargeWater > 0) steps.push(`Sparge with ${n(s.spargeWater)} L`);
  }
  hops.filter(h => h.use === 'first wort').forEach(h => steps.push(`First wort hops: ${hop(h)}`));
  steps.push(`Collect ${n(s.preBoilVol)} L. Target pre-boil gravity ${sg(s.preBoilSG)}`);
  const boil = [
    ...hops.filter(h => h.use === 'boil').map(h => ({ t: +h.time || 0, text: hop(h) })),
    ...(r.miscs || []).filter(m => m.use === 'boil').map(m => ({ t: +m.time || 0, text: `${m.amount} ${m.unit} ${m.name}` })),
  ].sort((a, b) => b.t - a.t);
  steps.push(`Bring to the boil. Boil for ${r.boilTime} min`);
  boil.forEach(b => steps.push(b.t > 0 ? `${b.t} min left: add ${b.text}` : `Flame-out: add ${b.text}`));
  hops.filter(h => h.use === 'whirlpool').forEach(h => steps.push(`Whirlpool at ${h.temp ?? 80} °C for ${h.time} min: ${hop(h)}`));
  steps.push(`Chill and transfer ${n(+r.batchSize, 0)} L to the fermenter. Target OG ${sg(s.og)}`);
  if (r.yeasts?.length) steps.push(`Pitch ${r.yeasts.map(y => y.name).filter(Boolean).join(' + ')}`);
  (r.fermentation || []).forEach(f => steps.push(`${f.name}: ${f.temp} °C for ${f.days} days`));
  hops.filter(h => h.use === 'dry hop').forEach(h => steps.push(`Dry hop for ${h.time} days: ${hop(h)}`));
  (r.miscs || []).filter(m => m.use === 'fermentation' || m.use === 'package').forEach(m => steps.push(`Add at ${m.use}: ${m.amount} ${m.unit} ${m.name}`));
  steps.push(`Package at ${n(+r.carbonation)} vols CO₂. Target FG ${sg(s.fg)}`);
  return steps;
}

// Gravity over time. Hydrometer-device readings (if any) draw the line; readings you typed in are dots on top.
function readingsChart(readings, og, targetFg, device = []) {
  const manual = readings.filter(x => x.date && x.sg > 0.9).map(x => ({ t: Date.parse(x.date), sg: +x.sg })).filter(p => !Number.isNaN(p.t)).sort((a, b) => a.t - b.t);
  const auto = device.map(x => ({ t: Date.parse(x.t), sg: +x.sg })).filter(p => !Number.isNaN(p.t));
  const pts = auto.length > 1 ? auto : manual, all = [...manual, ...auto];
  if (pts.length < 2) return '';
  const W = 320, H = 130, L = 44, R = 10, T = 12, B = 22;
  const t0 = Math.min(...all.map(p => p.t)), t1 = Math.max(...all.map(p => p.t));
  const hi = Math.max(og || 0, ...all.map(p => p.sg)) + 0.002, lo = Math.min(targetFg || 2, ...all.map(p => p.sg)) - 0.002;
  const x = t => L + (t - t0) / Math.max(1, t1 - t0) * (W - L - R), y = v => T + (hi - v) / (hi - lo) * (H - T - B);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.sg).toFixed(1)}`).join(' ');
  const days = Math.round((t1 - t0) / 864e5), dots = auto.length > 1 ? manual : pts.slice(0, -1), end = pts.at(-1);
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Gravity over ${days} days, from ${sg(pts[0].sg)} to ${sg(end.sg)}">
    <line class="axis" x1="${L}" y1="${y(hi)}" x2="${W - R}" y2="${y(hi)}"/><line class="axis" x1="${L}" y1="${y(lo)}" x2="${W - R}" y2="${y(lo)}"/>
    ${targetFg ? `<line class="target" x1="${L}" y1="${y(targetFg)}" x2="${W - R}" y2="${y(targetFg)}"/>` : ''}
    <path class="area" d="${line} L${x(end.t).toFixed(1)},${y(lo)} L${x(pts[0].t).toFixed(1)},${y(lo)} Z"/><path class="line" d="${line}"/>
    ${dots.map(p => `<circle class="pt" cx="${x(p.t).toFixed(1)}" cy="${y(p.sg).toFixed(1)}" r="2.5"/>`).join('')}
    <circle class="end" cx="${x(end.t).toFixed(1)}" cy="${y(end.sg).toFixed(1)}" r="4"/>
    <text x="${L - 6}" y="${y(hi) + 4}" text-anchor="end">${hi.toFixed(3)}</text><text x="${L - 6}" y="${y(lo) + 4}" text-anchor="end">${lo.toFixed(3)}</text>
    <text x="${L}" y="${H - 5}">day 0</text><text x="${W - R}" y="${H - 5}" text-anchor="end">day ${days}</text>
  </svg><p class="hint">${[targetFg ? `Dashed line: target FG ${sg(targetFg)}.` : '', auto.length > 1 ? `Line: hydrometer${manual.length ? '; dots: your own readings' : ''}.` : ''].filter(Boolean).join(' ')}</p>`;
}

// Timed parts of a brew day: each mash step, the boil with its additions, each whirlpool stand.
function timerSegments(r) {
  const segs = [];
  const hasGrain = (r.fermentables || []).some(f => C.isMashed(f) && f.amount > 0);
  if (hasGrain) (r.mash || []).filter(m => m.time > 0).forEach(m => segs.push({ name: m.name || 'Mash', min: +m.time, alerts: [] }));
  const boilTime = +r.boilTime || 0;
  if (boilTime > 0) {
    const at = new Map();
    const add = (t, text) => { const k = Math.max(0, Math.min(boilTime, +t || 0)); at.set(k, [...(at.get(k) || []), text]); };
    (r.hops || []).filter(h => h.use === 'boil' && h.amount > 0).forEach(h => add(h.time, `${n(+h.amount, 0)} g ${h.name}`));
    (r.miscs || []).filter(m => m.use === 'boil').forEach(m => add(m.time, `${m.amount} ${m.unit} ${m.name}`));
    segs.push({ name: 'Boil', min: boilTime, alerts: [...at].sort((a, b) => b[0] - a[0]).map(([t, list]) => ({ at: t, text: `Add ${list.join(' + ')}` })) });
  }
  const wp = new Map();
  (r.hops || []).filter(h => h.use === 'whirlpool' && h.time > 0).forEach(h => wp.set(+h.time, [...(wp.get(+h.time) || []), `${n(+h.amount, 0)} g ${h.name} at ${h.temp ?? 80} °C`]));
  [...wp].forEach(([t, list]) => segs.push({ name: 'Whirlpool', min: t, alerts: [{ at: t, text: `Add ${list.join(' + ')}` }] }));
  return segs;
}
const clock = ms => {
  const s = Math.ceil(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

function brewsView() {
  const recipes = queued(latestOnly(store.list('recipes'))); // newest versions, in queue order
  const nextUp = recipes.find(r => r.data.status === 'ready')?.id; // first ready recipe is preselected
  ctx = {
    actions: {
      new() {
        const rid = $('#brew-recipe').value, r = store.get('recipes', rid);
        if (r) location.hash = '#brew/' + newBrew(rid, r);
      },
    },
  };
  const brews = store.list('brews').sort((a, b) => (b.data.brewDate || '').localeCompare(a.data.brewDate || ''));
  view.innerHTML = `
    <div class="page-head"><h1>Brews</h1></div>
    ${recipes.length ? `<div class="card"><div class="row">
      <label class="fld w-name" for="brew-recipe"><span>Start a brew from</span><select id="brew-recipe">${recipes.map(r => `<option value="${r.id}"${r.id === nextUp ? ' selected' : ''}>${esc(vName(r.data))}${r.data.status === 'ready' ? '' : ' (in planning)'}</option>`).join('')}</select></label>
      <button type="button" class="btn primary" data-act="new">Start brew</button></div></div>` : ''}
    <div class="list">${brews.length ? brews.map(({ id, data: b, dirty }) => {
      const m = b.measured || {}, last = [...(b.readings || [])].filter(x => x.sg).sort((a, c) => (a.date || '').localeCompare(c.date || '')).at(-1);
      const fg = m.fg || last?.sg;
      return `<a class="item" href="#brew/${id}">
        ${pint(C.srmToHex(C.recipeStats(b.recipe, b.equipment || equipFor(b.recipe)).srm), 34)}
        <span class="item-main"><strong>${esc(b.name)}</strong><small>${esc(b.brewDate || 'no date')}${dirty && store.connected ? ` · <em>${store.words.unsaved}</em>` : ''}</small></span>
        <span class="pill s-${b.status.replace(' ', '-')}">${esc(b.status)}</span>
        <span class="item-stats"><span><b>${sg(m.og)}</b> OG</span><span><b>${sg(fg)}</b> SG</span><span><b>${m.og && fg ? n(C.abv(m.og, fg)) : '–'}</b> %</span></span>
      </a>`;
    }).join('') : `<div class="empty-state"><h2>No brews logged</h2><p>${recipes.length ? 'Pick a recipe above to start a brew. It keeps a snapshot of the recipe, a brew-day checklist, your measurements and gravity readings.' : 'Create a recipe first, then start a brew from it.'}</p></div>`}</div>`;
}

function brewView(id) {
  const b = store.get('brews', id);
  if (!b) return notFound('brew', '#brews');
  b.measured ??= {}; b.checklist ??= {}; b.readings ??= [];
  const r = b.recipe, eq = b.equipment || equipFor(r), plan = C.recipeStats(r, eq), steps = brewSteps(r, eq);
  ctx = {
    doc: b,
    touch: () => store.touch('brews', id),
    update,
    actions: {
      ...listActions,
      save: () => commit('brews', id),
      delete(btn) {
        if (!confirmTap(btn, 'Tap again to delete')) return;
        store.remove('brews', id);
        location.hash = '#brews';
      },
    },
    refresh: () => saveState('brews', id),
    ref: () => store.get('brews', id),
    change(t) { if (t.id === 't-wake') timer.setWake(t.checked); },
    timer(kind) { if (kind === 'tick') tickTimer(); else drawTimer(); },
  };
  Object.assign(ctx.actions, {
    't-start': () => timer.start(),
    't-pause': () => timer.pause(),
    't-reset': () => timer.select(timer.state.seg),
    't-adj': btn => timer.adjust(+btn.dataset.d),
    't-seg': btn => (timer.running ? toast('Pause the timer before switching step.', true) : timer.select(+btn.dataset.i)),
    't-take': () => timer.open(id, b.name, segs, true),
    't-notify': () => timer.askToNotify(),
    't-test': () => timer.test(),
  });
  const segs = timerSegments(r);

  // ---- wireless hydrometer (iSpindel via ThingSpeak) ----
  // The channel number is saved with the brew. The read key stays in this browser only, so it is never committed.
  const keyName = () => 'gyle.tskey.' + (b.device?.channel || '');
  const readKey = () => { try { return localStorage.getItem(keyName()) || ''; } catch { return ''; } };
  let deviceMsg = '', deviceFields = null, fetching = false;
  let typedChannel = b.device?.channel || '', typedKey = readKey(); // what is in the boxes, kept across redraws
  function drawDevice() {
    const el = $('#sec-device');
    if (!el) return;
    const d = b.device || {}, list = b.deviceReadings || [], latest = list.at(-1);
    const ago = t => { const h = (Date.now() - Date.parse(t)) / 36e5; return h < 1 ? 'under an hour ago' : h < 48 ? `${Math.round(h)} hours ago` : `${Math.round(h / 24)} days ago`; };
    const fieldPick = (id, label, value) => `<label class="fld" for="${id}"><span>${label}</span><select id="${id}"><option value="">Auto</option>${Object.entries(deviceFields || {}).map(([k, name]) => `<option value="${k}"${String(value) === k ? ' selected' : ''}>${k}: ${esc(name)}</option>`).join('')}</select></label>`;
    el.innerHTML = `<div class="sec-head"><h2>Hydrometer</h2><span class="count">${list.length ? `${list.length} hourly readings` : 'not linked'}</span></div>
      <p class="hint">Link an iSpindel that posts to a ThingSpeak channel. Gyle pulls its readings for this brew's dates and keeps one per hour in the brew log.</p>
      <div class="row">
        <label class="fld" for="dev-channel"><span>Channel ID</span><input id="dev-channel" inputmode="numeric" autocomplete="off" value="${esc(typedChannel)}"></label>
        <label class="fld w-name" for="dev-key"><span>Read key (blank if public)</span><input id="dev-key" type="password" autocomplete="off" value="${esc(typedKey)}"></label>
      </div>
      ${deviceFields ? `<div class="row">${fieldPick('dev-gf', 'Gravity field', d.gravityField)}${fieldPick('dev-tf', 'Temperature field', d.tempField)}</div>` : ''}
      <div class="foot-actions"><button type="button" class="btn primary" data-act="dev-fetch"${fetching ? ' disabled' : ''}>${fetching ? 'Fetching…' : list.length ? 'Fetch latest' : 'Link and fetch'}</button>
        ${d.channel ? '<button type="button" class="btn danger" data-act="dev-unlink">Unlink</button>' : ''}</div>
      ${latest ? `<div class="summary"><span>Latest <b>${sg(latest.sg)}</b>${latest.temp != null ? ` at <b>${n(latest.temp)} °C</b>` : ''}, ${ago(latest.t)}</span>${latest.battery != null ? `<span>Battery <b>${n(latest.battery, 2)} V</b></span>` : ''}
        ${stableFor(list) ? '<span class="stable">Stable for 2 days: likely finished</span>' : ''}</div>` : ''}
      <p class="hint" role="status">${esc(deviceMsg)}</p>`;
  }
  async function fetchDevice(quiet = false) {
    typedChannel = ($('#dev-channel')?.value ?? typedChannel).trim();
    typedKey = ($('#dev-key')?.value ?? typedKey).trim();
    const channel = typedChannel;
    if (!channel) { deviceMsg = 'Enter the channel ID first.'; return drawDevice(); }
    const device = { type: 'thingspeak', channel, gravityField: $('#dev-gf')?.value || b.device?.gravityField || '', tempField: $('#dev-tf')?.value || b.device?.tempField || '' };
    const key = typedKey;
    const from = b.brewDate ? new Date(b.brewDate + 'T00:00:00') : null;
    const to = b.packagedDate ? new Date(b.packagedDate + 'T23:59:59') : null;
    fetching = true; deviceMsg = ''; drawDevice();
    try {
      const out = await fetchThingSpeak(device, key, from, to);
      deviceFields = out.fields;
      b.device = device;
      try { key ? localStorage.setItem('gyle.tskey.' + channel, key) : localStorage.removeItem('gyle.tskey.' + channel); } catch { /* key just is not remembered */ }
      const changed = JSON.stringify(b.deviceReadings || []) !== JSON.stringify(out.readings);
      if (changed) { b.deviceReadings = out.readings; ctx.touch(); }
      deviceMsg = out.readings.length ? `Fetched ${out.raw} readings${b.brewDate ? ` since ${b.brewDate}` : ''}.${changed ? ' They are saved with this brew log.' : ' Nothing new.'}` : `The channel has no gravity readings${b.brewDate ? ` since ${b.brewDate}` : ''} yet.`;
    } catch (e) {
      if (e.fields) deviceFields = e.fields;
      if (!quiet || b.deviceReadings?.length) deviceMsg = e.message;
    }
    fetching = false;
    drawDevice(); update();
  }
  Object.assign(ctx.actions, {
    'dev-fetch': () => fetchDevice(),
    'dev-unlink'(btn) {
      if (!confirmTap(btn, 'Tap again to unlink')) return;
      try { localStorage.removeItem(keyName()); } catch { /* nothing stored */ }
      delete b.device; delete b.deviceReadings;
      deviceMsg = 'Unlinked. The readings were removed from this brew.'; deviceFields = null; typedChannel = ''; typedKey = '';
      ctx.touch(); drawDevice(); update();
    },
  });

  let lastLevel = -1;
  function drawTimer() {
    lastLevel = -1;
    const el = $('#timer-card');
    if (!el) return;
    const head = state => `<div class="sec-head"><h2>Timer</h2><span class="count">${state}</span></div>`;
    if (!segs.length) { el.innerHTML = head('') + '<p class="hint">This recipe has no timed steps.</p>'; return; }
    let st = timer.state;
    if (st && st.brewId !== id && st.started && !st.done) {
      el.innerHTML = head('in use') + `<p class="hint">The timer is running for ${esc(st.brewName)}.</p><div class="foot-actions"><button type="button" class="btn" data-act="t-take">Use it for this brew instead</button></div>`;
      return;
    }
    if (!st || st.brewId !== id) { timer.open(id, b.name, segs, true); return; } // redraws through the change event
    const seg = st.segments[st.seg], running = timer.running;
    const note = { granted: 'Notifications are on.', denied: 'Notifications are blocked for this site in your browser settings. The timer will still beep and show an alert here.', unsupported: 'This browser cannot show notifications here. The timer will still beep and show an alert on screen.' }[timer.notifyStatus()];
    el.innerHTML = head(running ? 'running' : st.done ? 'finished' : st.started ? 'paused' : 'ready') + `
      <div class="segs">${st.segments.map((x, i) => `<button type="button" class="seg${i === st.seg ? ' on' : ''}" data-act="t-seg" data-i="${i}"${i === st.seg ? ' aria-current="step"' : ''}>${esc(x.name)} <b>${x.min}</b></button>`).join('')}</div>
      <div class="t-face${running ? ' run' : ''}"><div class="t-glass" id="t-glass"></div><div class="t-read"><output class="t-time" id="t-time"></output><div class="t-next" id="t-next"></div></div></div>
      <div class="actions">
        ${running ? '<button type="button" class="btn primary" data-act="t-pause">Pause</button>' : `<button type="button" class="btn primary" data-act="t-start"${st.remaining <= 0 ? ' disabled' : ''}>${st.started && !st.done && st.remaining < seg.min * 60000 ? 'Resume' : 'Start'}</button>`}
        <button type="button" class="btn" data-act="t-adj" data-d="-1" aria-label="Take one minute off">−1 min</button>
        <button type="button" class="btn" data-act="t-adj" data-d="1" aria-label="Add one minute">+1 min</button>
        <button type="button" class="btn ghost" data-act="t-reset">Reset</button>
      </div>
      ${seg.alerts.length ? `<ol class="t-alerts">${seg.alerts.map((a, j) => `<li class="${st.fired[`${st.seg}:${j}`] ? 'done' : ''}"><b>${a.at > 0 ? `${a.at} min left` : 'At the end'}</b><span>${esc(a.text)}</span></li>`).join('')}</ol>` : ''}
      <div class="t-opts">
        <label for="t-wake"><input type="checkbox" id="t-wake"${timer.prefs.wake ? ' checked' : ''}><span>Keep the screen on while the timer runs</span></label>
        <p class="hint">${note || 'Get a notification when a step ends or an addition is due.'}
          ${note ? '' : '<button type="button" class="btn small" data-act="t-notify">Turn on notifications</button>'}
          <button type="button" class="btn small ghost" data-act="t-test">Test alert</button></p>
      </div>`;
    tickTimer();
  }
  function tickTimer() {
    const st = timer.state, out = $('#t-time');
    if (!out || !st || st.brewId !== id) return;
    const rem = timer.remaining(), seg = st.segments[st.seg];
    out.textContent = clock(rem);
    const level = Math.round(Math.min(1, rem / (seg.min * 60000)) * 200) / 200; // the pint drains as the step runs down
    if (level !== lastLevel) { $('#t-glass').innerHTML = pint(C.srmToHex(plan.srm), 62, level); lastLevel = level; }
    const next = seg.alerts.filter((a, j) => !st.fired[`${st.seg}:${j}`] && a.at > 0 && a.at * 60000 < rem).sort((a, c) => c.at - a.at)[0];
    const after = st.segments[st.seg + 1];
    $('#t-next').textContent = st.done ? (after ? `Done. Next step: ${after.name}.` : 'Done. That was the last timed step.')
      : next ? `${next.text} in ${clock(rem - next.at * 60000)}`
      : `${seg.name}, ${seg.min} min`;
  }
  view.innerHTML = `
    <div class="page-head"><a class="back" href="#brews">← Brews</a>
      <div class="actions"><button type="button" class="btn primary" id="save-btn" data-act="save"></button></div></div>
    <section class="label-card">
      <div class="label-main"><span class="overline">Brew log · ${esc(r.style || 'no style')}</span>
        <label class="title-fld" for="f-name"><span class="sr">Brew name</span><input id="f-name" class="title-input" data-p="name" value="${esc(b.name)}"></label></div>
      <div class="label-art">${pint(C.srmToHex(plan.srm), 84, 1, true)}<span class="stamp"><b>${n(plan.abv)}</b>% plan</span></div>
    </section>
    <section class="card"><div class="row">
      ${field({ label: 'Status', opts: STATUSES }, 'status', b.status)}
      ${field({ label: 'Brew date', type: 'date' }, 'brewDate', b.brewDate)}
      ${field({ label: 'Packaged', type: 'date' }, 'packagedDate', b.packagedDate)}
    </div><p class="hint">Recipe snapshot: ${store.get('recipes', b.recipeId) ? `<a href="#recipe/${b.recipeId}">${esc(vName(r))}</a>` : esc(vName(r))}, ${n(+r.batchSize, 0)} L on ${esc(eq.name || 'the default equipment')}. Later edits to the recipe or profile do not change this log.</p></section>
    <section class="card"><div class="sec-head"><h2>Measurements</h2></div><div class="row">
      ${field({ label: 'Pre-boil L', num: 1 }, 'measured.preBoilVol', b.measured.preBoilVol)}
      ${field({ label: 'Pre-boil SG', num: 1, step: 0.001 }, 'measured.preBoilSG', b.measured.preBoilSG)}
      ${field({ label: 'OG', num: 1, step: 0.001 }, 'measured.og', b.measured.og)}
      ${field({ label: 'Into fermenter L', num: 1 }, 'measured.fermenterVol', b.measured.fermenterVol)}
      ${field({ label: 'FG', num: 1, step: 0.001 }, 'measured.fg', b.measured.fg)}
    </div><div id="pva"></div></section>
    <section class="card" id="timer-card"></section>
    <section class="card"><div class="sec-head"><h2>Brew day</h2><span class="count" id="done-count"></span></div>
      <ol class="steps">${steps.map((s, i) => `<li><label for="st-${i}"><input type="checkbox" id="st-${i}" data-p="checklist.s${i}"${b.checklist['s' + i] ? ' checked' : ''}><span>${esc(s)}</span></label></li>`).join('')}</ol></section>
    <section class="card" id="sec-device"></section>
    <section class="card" id="sec-readings"></section>
    <section class="card"><div class="sec-head"><h2>Notes & tasting</h2></div>
      ${field({ label: 'Brew notes', area: 4, cls: 'block' }, 'notes', b.notes)}
      ${field({ label: 'Tasting notes', area: 4, cls: 'block' }, 'tasting', b.tasting)}
      <div class="row">${field({ label: 'Rating, 1 to 5', num: 1 }, 'rating', b.rating)}</div></section>
    <div class="foot-actions"><a class="btn" href="#sheet/brew/${id}">Brew sheet</a><button type="button" class="btn danger" data-act="delete">Delete brew log</button></div>`;
  renderList('readings');

  function update() {
    const m = b.measured;
    const typed = [...b.readings].filter(x => x.sg).sort((a, c) => (a.date || '').localeCompare(c.date || '')).at(-1);
    const auto = b.deviceReadings?.at(-1);
    const last = auto && (!typed || auto.t.slice(0, 10) >= (typed.date || '')) ? auto : typed;
    const fg = m.fg || last?.sg, fgNote = !m.fg && last ? (last === auto ? ' (latest from hydrometer)' : ' (latest reading)') : '';
    const eff = C.measuredEfficiency(r, m.og, m.fermenterVol, eq);
    const diff = (actual, planned, d, tol) => {
      if (!Number.isFinite(actual) || !actual) return '<td>–</td>';
      const delta = actual - planned;
      return `<td class="${Math.abs(delta) <= tol ? 'ok' : delta < 0 ? 'low' : 'high'}">${actual.toFixed(d)}</td>`;
    };
    $('#pva').innerHTML = `<table class="pva"><thead><tr><th></th><th>Plan</th><th>Actual</th></tr></thead><tbody>
      <tr><th>Pre-boil gravity</th><td>${sg(plan.preBoilSG)}</td>${diff(m.preBoilSG, plan.preBoilSG, 3, 0.002)}</tr>
      <tr><th>OG</th><td>${sg(plan.og)}</td>${diff(m.og, plan.og, 3, 0.002)}</tr>
      <tr><th>FG${fgNote}</th><td>${sg(plan.fg)}</td>${diff(fg, plan.fg, 3, 0.002)}</tr>
      <tr><th>ABV %</th><td>${n(plan.abv)}</td>${diff(m.og && fg ? C.abv(m.og, fg) : NaN, plan.abv, 1, 0.3)}</tr>
      <tr><th>Attenuation %</th><td>${n(plan.attenuation, 0)}</td>${diff(m.og && fg ? (m.og - fg) / (m.og - 1) * 100 : NaN, plan.attenuation, 0, 3)}</tr>
      <tr><th>Efficiency %</th><td>${n(+r.efficiency, 0)}</td>${diff(eff ?? NaN, +r.efficiency, 0, 3)}</tr>
      <tr><th>Into fermenter L</th><td>${n(+r.batchSize)}</td>${diff(m.fermenterVol, +r.batchSize, 1, 0.5)}</tr>
    </tbody></table>`;
    $('#done-count').textContent = `${steps.filter((_, i) => b.checklist['s' + i]).length} of ${steps.length} done`;
    const c = $('#chart');
    if (c) c.innerHTML = readingsChart(b.readings, m.og, plan.fg, b.deviceReadings || []);
    saveState('brews', id);
  }
  update();
  drawTimer();
  drawDevice();
  // While a brew is fermenting, pull new hydrometer readings each time its log is opened.
  if (b.device?.channel && ['fermenting', 'conditioning'].includes(b.status)) fetchDevice(true);
}

// ---------- brew sheet ----------
// The sheet for a recipe (#sheet/<recipe id>) has blanks to fill in by hand. The sheet for a
// brew log (#sheet/brew/<brew id>) uses the log's recipe snapshot and fills in what was measured.
function sheetModel(r, eq, b = null) {
  const s = C.recipeStats(r, eq), m = b?.measured || {};
  const val = (v, f) => (v == null || v === '' || !Number.isFinite(+v) ? null : f(+v));
  const steps = brewSteps(r, eq);
  const acid = r.water?.acid?.ml > 0 ? `${n(+r.water.acid.ml)} ml ${(C.ACIDS[r.water.acid.type] || C.ACIDS.lactic88).name.toLowerCase()}` : '';
  const ph = s.grainKg > 0 ? C.mashPh(r, C.waterWithSalts(sourceFor(r), r.water?.salts, s.totalWater), s.mashWater, grainDiPh) : null;
  const sections = [];
  sections.push({ title: 'Fermentables', table: {
    cols: [{ h: 'Name', w: 0.5 }, { h: 'Type', w: 0.17 }, { h: 'EBC', w: 0.1, right: 1 }, { h: 'kg', w: 0.12, right: 1 }, { h: '%', w: 0.11, right: 1 }],
    rows: (r.fermentables || []).map((f, i) => [f.name, f.type || 'grain', n(+f.color, 0), n(+f.amount, 2), n(s.fermPct[i], 0)]),
  } });
  sections.push({ title: 'Hops', table: {
    cols: [{ h: 'Name', w: 0.3 }, { h: 'When', w: 0.36 }, { h: 'Alpha', w: 0.12, right: 1 }, { h: 'g', w: 0.1, right: 1 }, { h: 'IBU', w: 0.12, right: 1 }],
    rows: (r.hops || []).map((h, i) => [h.name, hopWhen(h), n(+h.alpha, 1), n(+h.amount, 0), h.use === 'dry hop' ? '' : n(s.hopIbus[i], 0)]),
  } });
  if (r.mash?.length && s.grainKg > 0) sections.push({ title: 'Mash', half: true, table: {
    cols: [{ h: 'Step', w: 0.56 }, { h: '°C', w: 0.22, right: 1 }, { h: 'Min', w: 0.22, right: 1 }],
    rows: r.mash.map(x => [x.name, n(+x.temp, 1), n(+x.time, 0)]),
  }, note: `Mash ${n(s.grainKg, 2)} kg in ${n(s.mashWater)} L at ${n(s.strikeTemp)} °C strike. Sparge ${n(s.spargeWater)} L.` });
  sections.push({ title: 'Water', half: true, table: {
    cols: [{ h: 'Item', w: 0.55 }, { h: 'Amount', w: 0.45, right: 1 }],
    rows: [
      ['Source water', sourceFor(r).name],
      ...(targetFor(r) ? [['Target profile', targetFor(r).name]] : []),
      ...Object.entries(C.SALTS).filter(([k]) => r.water?.salts?.[k] > 0).map(([k, d]) => [d.name, `${n(+r.water.salts[k])} g`]),
      ...(acid ? [['Acid, in the mash water', acid]] : []),
      ...(ph ? [['Estimated mash pH', n(ph.ph, 2)]] : []),
    ],
  }, note: `Salts go in all ${n(s.totalWater)} L of brewing water.` });
  if (r.yeasts?.length) sections.push({ title: 'Yeast', half: true, table: {
    cols: [{ h: 'Name', w: 0.5 }, { h: 'Form', w: 0.2 }, { h: 'Atten.', w: 0.16, right: 1 }, { h: 'Packs', w: 0.14, right: 1 }],
    rows: r.yeasts.map(y => [[y.name, y.lab && `(${y.lab})`].filter(Boolean).join(' '), y.form || '', `${n(+y.attenuation, 0)} %`, n(+y.amount || 0, 0)]),
  } });
  if (r.fermentation?.length) sections.push({ title: 'Fermentation', half: true, table: {
    cols: [{ h: 'Step', w: 0.56 }, { h: '°C', w: 0.22, right: 1 }, { h: 'Days', w: 0.22, right: 1 }],
    rows: r.fermentation.map(x => [x.name, n(+x.temp, 1), n(+x.days, 0)]),
  } });
  if (r.miscs?.length) sections.push({ title: 'Other additions', table: {
    cols: [{ h: 'Name', w: 0.4 }, { h: 'Type', w: 0.18 }, { h: 'When', w: 0.24 }, { h: 'Amount', w: 0.18, right: 1 }],
    rows: r.miscs.map(x => [x.name, x.type || 'other', miscWhen({ ...x, type: '' }), `${x.amount} ${x.unit === 'each' ? '' : x.unit}`.trim()]),
  } });
  sections.push({ title: 'Brew day', checklist: steps.map((text, i) => ({ text, done: !!b?.checklist?.['s' + i] })) });
  sections.push({ title: 'Measurements', table: {
    cols: [{ h: '', w: 0.46 }, { h: 'Plan', w: 0.27, right: 1 }, { h: 'Actual', w: 0.27, right: 1 }],
    rows: [
      ["Mash pH", ph ? n(targetPh(r), 2) : '–', null],
      ['Pre-boil volume, L', n(s.preBoilVol), val(m.preBoilVol, v => n(v))],
      ['Pre-boil gravity', sg(s.preBoilSG), val(m.preBoilSG, sg)],
      ['Original gravity', sg(s.og), val(m.og, sg)],
      ['Into the fermenter, L', n(+r.batchSize), val(m.fermenterVol, v => n(v))],
      ['Pitch temperature, °C', n(+(r.fermentation?.[0]?.temp ?? 19), 0), null],
      ['Final gravity', sg(s.fg), val(m.fg, sg)],
      ['ABV %', n(s.abv), m.og && m.fg ? n(C.abv(+m.og, +m.fg)) : null],
    ],
  } });
  const notes = [r.versionNote && `What changed in version ${versionOf(r)}: ${r.versionNote}`, r.notes, b?.notes].filter(Boolean).join('\n\n');
  sections.push({ title: 'Notes', text: notes, lines: b?.notes ? 3 : 6 });
  return {
    title: b ? b.name : vName(r),
    subtitle: [b ? vName(r) : versionOf(r) > 1 ? `Version ${versionOf(r)}` : '', r.style || 'No style', `${n(+r.batchSize, 0)} L`, r.basedOn ? `based on ${vName(r.basedOn)}` : ''].filter(Boolean).join(' · '),
    colour: C.srmToHex(s.srm),
    meta: [['Brewer', r.author || null], ['Equipment', eq.name || 'Default'], ['Brew date', b?.brewDate || null], ['Boil', `${n(+r.boilTime, 0)} min`]],
    stats: [['OG', sg(s.og)], ['FG', sg(s.fg)], ['ABV', `${n(s.abv)} %`], ['IBU', n(s.ibu, 0)], ['Colour', `${n(s.ebc, 0)} EBC`], ['Efficiency', `${n(+r.efficiency, 0)} %`], ['CO2', `${n(+r.carbonation)} vols`]],
    sections,
    footer: `Gyle brew sheet · ${vName(r)} · printed ${today()}`,
  };
}
const targetPh = r => +r.water?.targetPh || 5.4;

function sheetView(arg) {
  const [kind, bid] = arg.split('/');
  const b = kind === 'brew' ? store.get('brews', bid) : null;
  const r = b ? b.recipe : store.get('recipes', arg);
  if (!r) return notFound(kind === 'brew' ? 'brew' : 'recipe', kind === 'brew' ? '#brews' : '#recipes');
  const eq = b ? b.equipment || equipFor(r) : equipFor(r);
  const back = b ? `#brew/${bid}` : `#recipe/${arg}`;
  const model = sheetModel(r, eq, b);
  ctx = {
    actions: {
      print: () => window.print(),
      pdf: () => download(`${slug(model.title)}-brew-sheet.pdf`, sheetPdf(model), 'application/pdf'),
    },
  };
  view.innerHTML = `
    <div class="page-head no-print"><a class="back" href="${back}">← ${b ? 'Brew log' : 'Recipe'}</a>
      <div class="actions"><button type="button" class="btn" data-act="print">Print</button><button type="button" class="btn primary" data-act="pdf">Download PDF</button></div></div>
    <p class="hint on-wall no-print">${b ? 'Filled in from this brew log. ' : 'Blanks are for writing in on brew day. '}Print uses your browser's print dialog, which can also save a PDF.</p>
    ${sheetHtml(model)}`;
}

// ---------- tools ----------
const TOOLS = [
  { id: 'abv', title: 'ABV and attenuation', fields: [['og', 'Original gravity', 1.05], ['fg', 'Final gravity', 1.01]],
    out: v => [['ABV', `${n(C.abv(v.og, v.fg))} %`], ['Apparent attenuation', `${n((v.og - v.fg) / (v.og - 1) * 100, 0)} %`]] },
  { id: 'hydro', title: 'Hydrometer temperature correction', fields: [['sg', 'Reading', 1.05], ['t', 'Sample temp °C', 30], ['cal', 'Calibration temp °C', 20]],
    out: v => [['Corrected gravity', sg(C.hydrometerCorrect(v.sg, v.t, v.cal))]] },
  { id: 'refrac', title: 'Refractometer', fields: [['ob', 'Original Brix', 12.5], ['fb', 'Current Brix', 6.5], ['wcf', 'Wort correction factor', 1.04]],
    out: v => {
      const og = C.platoToSg(v.ob / v.wcf), fg = C.refractometerFG(v.ob, v.fb, v.wcf);
      return [['Original gravity', sg(og)], ['Current gravity, alcohol-corrected', sg(fg)], ['ABV so far', `${n(C.abv(og, fg))} %`]];
    } },
  { id: 'prime', title: 'Priming sugar', fields: [['vol', 'Beer volume L', 20], ['temp', 'Warmest beer temp °C', 20], ['co2', 'Target vols CO₂', 2.4]],
    out: v => {
      const p = C.primingSugar(v.vol, v.temp, v.co2);
      return [['CO₂ already in the beer', `${n(p.residual, 2)} vols`], ['Dextrose', `${n(p.dextrose, 0)} g`], ['Table sugar', `${n(p.sucrose, 0)} g`], ['Dry malt extract', `${n(p.dme, 0)} g`]];
    } },
  { id: 'dilute', title: 'Dilution and boil-off', fields: [['v', 'Current volume L', 25], ['sg', 'Current gravity', 1.045], ['target', 'Target gravity', 1.05]],
    out: v => {
      const end = C.volumeAtGravity(v.v, v.sg, v.target), d = end - v.v;
      return [['Volume at target', `${n(end)} L`], [d >= 0 ? 'Water to add' : 'Boil off', `${n(Math.abs(d))} L`]];
    } },
  { id: 'strike', title: 'Strike water', fields: [['kg', 'Grain kg', 5], ['ratio', 'Water L per kg', 3], ['grain', 'Grain temp °C', 18], ['mash', 'Target mash temp °C', 66]],
    out: v => [['Strike water', `${n(v.kg * v.ratio)} L`], ['Heat it to', `${n(C.strikeTemp(v.ratio, v.grain, v.mash))} °C`]] },
  { id: 'convert', title: 'Gravity conversion', fields: [['sg', 'Specific gravity', 1.05]],
    out: v => [['Plato / Brix', `${n(C.sgToPlato(v.sg))} °P`], ['Gravity points', n((v.sg - 1) * 1000, 0)]] },
  { id: 'pitch', title: 'Yeast pitch rate', fields: [['vol', 'Wort volume L', 21], ['og', 'Original gravity', 1.05], ['rate', 'Rate, M cells/ml/°P (0.75 ale, 1.5 lager)', 0.75]],
    out: v => {
      const cells = C.pitchCells(v.vol, v.og, v.rate);
      return [['Cells needed', `${n(cells, 0)} billion`], ['Fresh liquid packs (100 billion each)', n(cells / 100, 1)]];
    } },
];
const toolVals = {};

const TOOL_DESC = {
  abv: 'Alcohol and apparent attenuation from an original and a final gravity.',
  hydro: 'Correct a hydrometer reading taken above or below its calibration temperature.',
  refrac: 'Turn Brix readings into gravity, including readings taken once alcohol is present.',
  prime: 'How much sugar to add at bottling for the carbonation you want.',
  dilute: 'How much water to add, or how much to boil off, to hit a target gravity.',
  strike: 'Volume and temperature of mash water for a target mash temperature.',
  convert: 'Specific gravity to Plato, Brix and gravity points.',
  pitch: 'Yeast cells needed for a batch, by volume and gravity.',
};

// The tools index: one link per calculator.
function toolsView() {
  ctx = {};
  view.innerHTML = `<div class="page-head"><h1>Tools</h1></div><div class="list">${TOOLS.map(t => `<a class="item tool-link" href="#tool/${t.id}">
      <span class="item-main"><strong>${t.title}</strong><small>${TOOL_DESC[t.id]}</small></span><span class="go" aria-hidden="true">→</span>
    </a>`).join('')}</div>`;
}

// One calculator on its own page. Values are kept while the app stays open.
function toolView(id) {
  const t = TOOLS.find(x => x.id === id);
  if (!t) return notFound('tool', '#tools');
  const v = (toolVals[t.id] ??= Object.fromEntries(t.fields.map(([k, , d]) => [k, d])));
  const draw = () => {
    const ok = Object.values(v).every(Number.isFinite);
    $('#out-' + t.id).innerHTML = ok ? t.out(v).map(([k, val]) => `<div><dt>${k}</dt><dd>${val}</dd></div>`).join('') : '<div><dt>Fill in every field</dt><dd>–</dd></div>';
  };
  ctx = {
    raw(el) {
      if (!el.dataset.tool) return;
      v[el.dataset.tool] = parseFloat(el.value);
      draw();
    },
    actions: {
      reset() { delete toolVals[t.id]; toolView(id); },
    },
  };
  view.innerHTML = `<div class="page-head"><a class="back" href="#tools">← Tools</a></div>
    <section class="card tool"><div class="sec-head"><h2>${t.title}</h2></div>
      <p class="hint">${TOOL_DESC[t.id]}</p>
      <div class="tool-fields">${t.fields.map(([k, label]) =>
        `<label class="fld" for="t-${t.id}-${k}"><span>${label}</span><input id="t-${t.id}-${k}" type="number" step="${v[k] > 0.9 && v[k] < 1.2 && !/factor|Rate/.test(label) ? 0.001 : 'any'}" inputmode="decimal" data-tool="${k}" value="${v[k]}"></label>`).join('')}</div>
      <dl class="results" id="out-${t.id}"></dl>
      <div class="foot-actions"><button type="button" class="btn small ghost" data-act="reset">Reset to defaults</button></div>
    </section>`;
  draw();
}

// ---------- settings ----------
const EQUIP_LABELS = {
  batchSize: 'Batch size L', efficiency: 'Efficiency %', boilTime: 'Boil min', boilOff: 'Boil-off L/hour',
  kettleLoss: 'Kettle loss L', mashLoss: 'Mash tun loss L', absorption: 'Absorption L/kg', mashRatio: 'Mash ratio L/kg', grainTemp: 'Grain temp °C',
};

let storageNote = ''; // a message to show on the Storage card the next time Settings is drawn
function settingsView() {
  const doc = clone(store.get('settings', 'settings') || {});
  doc.profiles = clone(profiles());
  doc.defaultProfile = defaultProfile().id;
  delete doc.equipment; // older single-profile settings become the first profile
  doc.waters ??= [];
  const val = id => ($('#' + id)?.value ?? '').trim();
  const touch = () => store.put('settings', 'settings', doc);
  const drawProfiles = () => {
    const inUse = id => store.list('recipes').filter(r => (r.data.equipment || doc.defaultProfile) === id).length;
    $('#profiles').innerHTML = doc.profiles.map((p, i) => `<div class="profile">
      <div class="row">${field({ label: 'Profile name', cls: 'w-name' }, `profiles.${i}.name`, p.name)}
        ${Object.keys(EQUIP_LABELS).map(k => field({ label: EQUIP_LABELS[k], num: 1 }, `profiles.${i}.${k}`, p[k])).join('')}</div>
      <div class="profile-foot"><span class="count">${inUse(p.id)} recipe${inUse(p.id) === 1 ? '' : 's'}</span>
        ${p.id === doc.defaultProfile ? '<span class="pill s-finished">Default</span>' : `<button type="button" class="btn small" data-act="default" data-i="${i}">Make default</button>`}
        <button type="button" class="btn small" data-act="copy" data-i="${i}">Duplicate</button>
        ${doc.profiles.length > 1 ? `<button type="button" class="btn small danger" data-act="drop" data-i="${i}">Delete</button>` : ''}</div>
    </div>`).join('');
    saveState('settings', 'settings');
  };
  const drawWaters = () => {
    $('#waters').innerHTML = doc.waters.length ? doc.waters.map((w, i) => `<div class="profile">
      <div class="row">${field({ label: 'Water name', cls: 'w-name' }, `waters.${i}.name`, w.name)}</div>
      <div class="row ions-row">${C.IONS.map(k => field({ label: `${ION_LABELS[k]} ppm`, num: 1, step: 1 }, `waters.${i}.${k}`, w[k])).join('')}</div>
      <div class="profile-foot"><span class="count"></span>
        ${w.id === doc.defaultWater ? '<span class="pill s-finished">Default</span>' : `<button type="button" class="btn small" data-act="default-water" data-i="${i}">Make default</button>`}
        <button type="button" class="btn small danger" data-act="drop-water" data-i="${i}">Delete</button></div>
    </div>`).join('') : '<p class="empty">No water profiles yet. Recipes start from RO or distilled water until you add your own.</p>';
    saveState('settings', 'settings');
  };
  ctx = {
    doc,
    touch,
    refresh: () => saveState('settings', 'settings'),
    update: () => saveState('settings', 'settings'),
    actions: {
      save: () => commit('settings', 'settings'),
      'add-water'() {
        const w = { id: 'w-' + uid(), name: doc.waters.length ? 'New water' : 'My tap water', ca: 0, mg: 0, na: 0, cl: 0, so4: 0, hco3: 0 };
        doc.waters.push(w);
        doc.defaultWater ??= w.id;
        touch(); drawWaters();
      },
      'default-water'(b) { doc.defaultWater = doc.waters[+b.dataset.i].id; touch(); drawWaters(); },
      'drop-water'(b) {
        if (!confirmTap(b, 'Tap again to delete')) return;
        const [gone] = doc.waters.splice(+b.dataset.i, 1);
        if (doc.defaultWater === gone.id) doc.defaultWater = doc.waters[0]?.id;
        touch(); drawWaters();
      },
      'add-profile'() {
        doc.profiles.push({ ...C.DEFAULT_EQUIP, id: 'p-' + uid(), name: 'New profile' });
        touch(); drawProfiles();
      },
      copy(b) {
        const src = doc.profiles[+b.dataset.i];
        doc.profiles.push({ ...clone(src), id: 'p-' + uid(), name: src.name + ' (copy)' });
        touch(); drawProfiles();
      },
      default(b) { doc.defaultProfile = doc.profiles[+b.dataset.i].id; touch(); drawProfiles(); },
      drop(b) {
        if (!confirmTap(b, 'Tap again to delete')) return;
        const [gone] = doc.profiles.splice(+b.dataset.i, 1);
        if (doc.defaultProfile === gone.id) doc.defaultProfile = doc.profiles[0].id;
        touch(); drawProfiles();
        toast('Profile deleted. Recipes that used it now use the default.');
      },
      // ---- storage ----
      mode(btn) {
        if (btn.dataset.v === 'local') store.detach();
        store.setMode(btn.dataset.v);
        storageMsg = '';
        drawStorage();
        if (store.connected) store.sync();
      },
      async connect() {
        const [owner, repo] = val('gh-repo').replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '').split('/');
        if (!owner || !repo) return toast('Enter the repo as owner/name.', true);
        store.git.configure({ owner, repo, branch: val('gh-branch') || 'main', token: val('gh-token') });
        store.setMode('git');
        say('Checking…');
        try {
          const info = await store.git.verify();
          await store.sync();
          storageMsg = store.status.state === 'error' ? store.status.message
            : !store.git.config.token ? 'Connected read-only. Add a token to save changes.'
            : info.canPush ? `Connected to ${owner}/${repo}. Changes are committed to ${store.git.config.branch}.`
            : 'Connected, but this token cannot write to the repo. Give it Contents: Read and write.';
        } catch (e) { storageMsg = e.message; }
        drawStorage();
      },
      disconnect() {
        store.git.configure({ owner: '', repo: '', token: '' });
        store.detach();
        storageMsg = 'Disconnected. Your recipes are still on this device.';
        drawStorage();
      },
      async 'sb-signup'() { await signIn(true); },
      'sb-oauth'(btn) {
        if (!projectReady()) return;
        store.setMode('supabase');
        store.account.oauth(btn.dataset.v);
      },
      async 'sb-recover'() {
        if (!projectReady()) return;
        if (!val('sb-email')) return say('Enter your email address first, then press Forgot password.');
        try { await store.account.recover(val('sb-email')); say('If that address has an account, a reset link is on its way. Open it on this device.'); } catch (e) { say(e.message); }
      },
      async 'sb-signout'(btn) {
        if (store.dirtyCount) {
          try { await store.push(); } catch { if (!confirmTap(btn, 'Unsaved changes. Tap again to sign out anyway')) return; }
        }
        await store.account.signOut();
        store.wipe();
        storageNote = 'Signed out. Your recipes are in your account, no longer on this device.';
        settingsView();
      },
      'sb-sync': () => store.sync(),
    },
    submit(form) {
      if (form.id === 'sb-form') signIn(false);
      if (form.id === 'sb-newpass') newPassword();
    },
  };
  // Storage card: where the data lives, with the connection or sign-in form for the chosen option.
  let storageMsg = storageNote || (store.status.state === 'error' ? store.status.message : '');
  storageNote = '';
  const say = m => { storageMsg = m; const el = $('#storage-msg'); if (el) el.textContent = m; };
  const projectReady = () => {
    if (!store.account.builtIn) store.account.configure({ url: val('sb-url'), key: val('sb-key') });
    if (!store.account.configured) { say('Enter the Supabase project URL and public key first.'); return false; }
    return true;
  };
  async function signIn(create) {
    if (!projectReady()) return;
    const email = val('sb-email'), password = $('#sb-password')?.value || '';
    if (!email || !password) return say('Enter your email address and a password.');
    say(create ? 'Creating your account…' : 'Signing in…');
    try {
      if (create && await store.account.signUp(email, password) === 'confirm') {
        return say('Check your email for a confirmation link, then come back here and sign in.');
      }
      if (!create) await store.account.signIn(email, password);
      store.setMode('supabase');
      await store.sync();
      storageNote = store.status.state === 'error' ? store.status.message : 'Signed in. Changes now save to your account automatically.';
      settingsView();
    } catch (e) { say(/invalid login/i.test(e.message) ? 'That email and password do not match an account.' : e.message); }
  }
  async function newPassword() {
    const pw = $('#sb-new')?.value || '';
    if (pw.length < 8) return say('Use at least 8 characters.');
    try { await store.account.setPassword(pw); storageMsg = 'Password changed.'; drawStorage(); } catch (e) { say(e.message); }
  }
  function drawStorage() {
    const el = $('#storage');
    if (!el) return;
    const g = store.git.config, acct = store.account, mode = store.mode;
    const seg = (v, t) => `<button type="button" class="seg${mode === v ? ' on' : ''}" data-act="mode" data-v="${v}" aria-pressed="${mode === v}">${t}</button>`;
    const body = mode === 'git' ? `
      <p class="hint">Recipes are saved as BeerJSON files in <code>recipes/</code>, brew logs in <code>brews/</code>. Every save is a commit, so git keeps the full history.</p>
      <div class="row">
        <label class="fld w-name" for="gh-repo"><span>Repo, as owner/name</span><input id="gh-repo" value="${esc(g.owner && g.repo ? `${g.owner}/${g.repo}` : '')}" autocapitalize="off" autocomplete="off" spellcheck="false"></label>
        <label class="fld" for="gh-branch"><span>Branch</span><input id="gh-branch" value="${esc(g.branch)}" autocapitalize="off" spellcheck="false"></label>
      </div>
      <div class="row"><label class="fld w-name" for="gh-token"><span>Personal access token</span><input id="gh-token" type="password" value="${esc(g.token)}" autocomplete="off"></label></div>
      <p class="hint">Create a fine-grained token at GitHub → Settings → Developer settings, limited to this one repo, with <b>Contents: Read and write</b>. It is stored only in this browser.</p>
      <div class="foot-actions"><button type="button" class="btn primary" data-act="connect">Connect and sync</button>${store.git.ready ? '<button type="button" class="btn" data-act="disconnect">Disconnect</button>' : ''}</div>`
      : mode === 'supabase' ? `
      <p class="hint">Sign in and your recipes, brew logs and settings are kept in your account and saved as you go. Use the same sign-in on your phone and computer.</p>
      ${acct.builtIn ? '' : `<div class="row">
        <label class="fld w-name" for="sb-url"><span>Supabase project URL</span><input id="sb-url" value="${esc(acct.url)}" placeholder="https://xxxx.supabase.co" autocapitalize="off" autocomplete="off" spellcheck="false"></label>
        <label class="fld w-name" for="sb-key"><span>Public (publishable or anon) key</span><input id="sb-key" value="${esc(acct.key)}" autocapitalize="off" autocomplete="off" spellcheck="false"></label>
      </div>`}
      ${acct.recovering ? `<form id="sb-newpass" novalidate><div class="row">
          <label class="fld w-name" for="sb-new"><span>Choose a new password</span><input id="sb-new" type="password" autocomplete="new-password"></label>
          <button type="submit" class="btn primary">Set password</button></div></form>`
        : acct.user ? `<div class="summary"><span>Signed in as <b>${esc(acct.user.email || 'your account')}</b></span></div>
        <div class="foot-actions"><button type="button" class="btn" data-act="sb-sync">Sync now</button><button type="button" class="btn" data-act="sb-signout">Sign out</button></div>`
        : `<form id="sb-form" novalidate><div class="row">
          <label class="fld w-name" for="sb-email"><span>Email</span><input id="sb-email" type="email" autocomplete="username" autocapitalize="off" spellcheck="false"></label>
          <label class="fld w-name" for="sb-password"><span>Password</span><input id="sb-password" type="password" autocomplete="current-password"></label>
        </div>
        <div class="foot-actions"><button type="submit" class="btn primary">Sign in</button><button type="button" class="btn" data-act="sb-signup">Create account</button>
          <button type="button" class="btn ghost" data-act="sb-recover">Forgot password</button></div></form>
        <div class="foot-actions alt"><button type="button" class="btn small" data-act="sb-oauth" data-v="github">Continue with GitHub</button><button type="button" class="btn small" data-act="sb-oauth" data-v="google">Continue with Google</button></div>
        <p class="hint">Signing in copies any recipes already on this device into your account.</p>`}`
      : '<p class="hint">Nothing leaves this browser. Clearing its site data would delete everything, so export the recipes you care about, or choose one of the other options to keep a proper copy.</p>';
    el.innerHTML = `<div class="segs" role="group" aria-label="Where to keep your data">${seg('local', 'This device')}${seg('supabase', 'Gyle account')}${seg('git', 'GitHub repo')}</div>
      ${body}<p class="hint" id="storage-msg" role="status">${esc(storageMsg)}</p>`;
  }
  view.innerHTML = `
    <div class="page-head"><h1>Settings</h1></div>
    <section class="card"><div class="sec-head"><h2>Equipment profiles</h2><button type="button" class="btn small primary" id="save-btn" data-act="save"></button></div>
      <p class="hint">One profile per setup you brew on. Each recipe picks a profile, which sets its water volumes, pre-boil gravity and IBU. New recipes start from the default.</p>
      <div id="profiles"></div>
      <div class="foot-actions"><button type="button" class="btn" data-act="add-profile">Add profile</button></div>
    </section>
    <section class="card"><div class="sec-head"><h2>Water profiles</h2></div>
      <p class="hint">Enter the mineral content of the water you brew with, from your supplier's report or a test kit. Recipes use the default as their starting water, and any profile here can also be picked as a target.</p>
      <div id="waters"></div>
      <div class="foot-actions"><button type="button" class="btn" data-act="add-water">Add water profile</button></div>
    </section>
    <section class="card"><div class="sec-head"><h2>Storage</h2></div>
      <p class="hint">Where your recipes, brew logs and settings are kept. Whichever you choose, this browser keeps a working copy so Gyle still works offline.</p>
      <div id="storage"></div>
    </section>`;
  drawProfiles();
  drawWaters();
  drawStorage();
}

// ---------- shell ----------
function notFound(what, back) {
  ctx = {};
  view.innerHTML = `<div class="empty-state"><h2>That ${what} is not here</h2><p>It may have been deleted, or not synced to this device yet.</p><a class="btn" href="${back}">Back</a></div>`;
}

const ROUTES = { recipes: recipesView, recipe: recipeView, sheet: sheetView, brews: brewsView, brew: brewView, tools: toolsView, tool: toolView, settings: settingsView };
const TAB_OF = { recipe: 'recipes', brew: 'brews', tool: 'tools' };
let routeKey = '';

function route(keepScroll = false) {
  const [name, ...rest] = location.hash.replace(/^#/, '').split('/');
  const key = ROUTES[name] ? name : 'recipes';
  routeKey = key + '/' + rest.join('/');
  const tab = key === 'sheet' ? (rest[0] === 'brew' ? 'brews' : 'recipes') : TAB_OF[key] || key;
  document.querySelectorAll('#tabs a').forEach(a => a.toggleAttribute('aria-current', a.dataset.tab === tab));
  ROUTES[key](rest.join('/'));
  if (keepScroll !== true) window.scrollTo(0, 0);
}

function drawChip() {
  const chip = $('#sync-chip'), { state } = store.status, dirty = store.dirtyCount;
  const [cls, text] = state === 'syncing' ? ['busy', 'Syncing…']
    : !store.connected ? ['off', 'This device only']
    : dirty ? ['dirty', store.words.pending(dirty)]
    : state === 'error' ? ['bad', 'Sync problem']
    : ['ok', 'In sync'];
  chip.className = 'sync ' + cls;
  chip.textContent = text;
  chip.title = state === 'error' ? store.status.message : store.connected ? 'Sync now' : 'Choose where to keep your recipes';
}

$('#sync-chip').addEventListener('click', async () => {
  if (!store.connected) { location.hash = '#settings'; return; }
  if (store.dirtyCount) {
    if (!store.canWrite) { toast(store.words.need, true); location.hash = '#settings'; return; }
    try { await store.push(); toast(store.words.all); } catch (e) { toast(e.message, true); }
  } else {
    await store.sync();
    if (store.status.state === 'error') toast(store.status.message, true);
  }
});

function drawTimerChip() {
  const chip = $('#timer-chip'), st = timer.state;
  chip.hidden = !st?.started;
  if (!st?.started) return;
  chip.href = '#brew/' + st.brewId;
  chip.className = 'tchip' + (timer.running ? ' run' : st.done ? ' done' : '');
  chip.textContent = `${st.segments[st.seg].name} ${st.done ? 'done' : clock(timer.remaining())}`;
}
timer.on((kind, payload) => {
  drawTimerChip();
  if (kind === 'alert') toast(`${payload.title}. ${payload.body}`, 'alert');
  ctx.timer?.(kind);
});

function datalists() {
  const dl = (id, items) => `<datalist id="${id}">${items.map(x => `<option value="${esc(x.name)}">`).join('')}</datalist>`;
  document.body.insertAdjacentHTML('beforeend', dl('dl-style', STYLES));
}

store.init();
datalists();
let lastSynced = false;
store.on(() => {
  drawChip();
  const synced = store.status.state === 'synced';
  // After a pull, list pages redraw; open editors only refresh their save button so typing is never interrupted.
  if (synced && !lastSynced && /^(recipes|brews)\/$/.test(routeKey)) route(true);
  else if (synced && !lastSynced && view.querySelector('.empty-state') && /^(recipe|brew)\//.test(routeKey)) route(true);
  else if (ctx.ref && ctx.ref() !== ctx.doc) route(true); // storage had a newer copy of the open document
  else ctx.refresh?.();
  lastSynced = synced;
});
window.addEventListener('hashchange', () => route());
window.addEventListener('beforeunload', () => store.persist());
// Arriving from a sign-in link (email confirmation, password reset, GitHub or Google)?
const arrived = await store.account.takeRedirect();
if (arrived?.ok) store.setMode('supabase');
drawChip();
drawTimerChip();
route();
if (arrived?.error) toast(`Sign-in did not complete: ${arrived.error}`, true);
else if (arrived?.recovering) toast('Choose a new password in Settings.');
else if (arrived?.ok) toast('Signed in.');
store.sync();

// First run without a repo (a local test, say): load the example recipe that ships in recipes/.
(async () => {
  try {
    if (store.connected || store.list('recipes').length || localStorage.getItem('gyle.seeded')) return;
    const res = await fetch('recipes/house-pale-ale.json');
    if (!res.ok) return;
    store.put('recipes', 'house-pale-ale', fromBeerJSON(await res.json())[0]);
    localStorage.setItem('gyle.seeded', '1');
  } catch { /* no example available; the empty state explains what to do */ }
})();
