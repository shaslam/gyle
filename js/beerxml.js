// BeerXML 1.0 import and export (the format BeerSmith and Brewfather both export).
// BeerXML units: kg, litres, °C, minutes; colour in Lovibond (read as SRM, the usual practice); yield in %.

import { srmToEbc, ebcToSrm, yieldToPotential, potentialToYield } from './units.js';
import { blankRecipe } from './beerjson.js';

// BeerSmith files often declare ISO-8859-1; decode with whatever the file says.
export function decodeXmlBytes(buffer) {
  const head = new TextDecoder('ascii').decode(new Uint8Array(buffer).slice(0, 200));
  const enc = /encoding=["']([\w-]+)["']/i.exec(head)?.[1] || 'utf-8';
  try { return new TextDecoder(enc).decode(buffer); } catch { return new TextDecoder().decode(buffer); }
}

// BeerSmith writes HTML entities (&deg; and friends) that XML does not define. Neutralise them.
const NAMED = { deg: '°', nbsp: ' ', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', ndash: '–', mdash: '—', frac12: '½', eacute: 'é', ouml: 'ö', uuml: 'ü', auml: 'ä' };
const cleanEntities = xml => xml.replace(/&(\w+);/g, (m, k) => NAMED[k] ?? m).replace(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);)/gi, '&amp;');

const kid = (el, tag) => el && [...el.children].find(c => c.tagName.toUpperCase() === tag);
const kids = (el, wrap, tag) => [...(kid(el, wrap)?.children || [])].filter(c => c.tagName.toUpperCase() === tag);
const txt = (el, tag, d = '') => (kid(el, tag)?.textContent ?? d).trim();
const numOf = (el, tag, d = 0) => {
  const x = parseFloat(txt(el, tag));
  return Number.isFinite(x) ? x : d;
};
const round = (x, d = 3) => +x.toFixed(d);

const HOP_USE = { boil: 'boil', 'dry hop': 'dry hop', mash: 'mash', 'first wort': 'first wort', aroma: 'whirlpool' };
const FERM_TYPE = { grain: 'grain', adjunct: 'grain', sugar: 'sugar', extract: 'extract', 'dry extract': 'dry extract' };
const MISC_USE = { boil: 'boil', mash: 'mash', primary: 'fermentation', secondary: 'fermentation', bottling: 'package' };

function recipeFromXml(x) {
  const r = blankRecipe();
  const boilTime = numOf(x, 'BOIL_TIME', 60);
  Object.assign(r, {
    name: txt(x, 'NAME', 'Untitled'),
    author: txt(x, 'BREWER'),
    type: txt(x, 'TYPE', 'All Grain').toLowerCase(),
    style: txt(kid(x, 'STYLE'), 'NAME'),
    batchSize: round(numOf(x, 'BATCH_SIZE', 21), 2),
    boilTime: round(boilTime, 0),
    efficiency: round(numOf(x, 'EFFICIENCY', 72), 1),
    notes: [txt(x, 'NOTES'), txt(x, 'TASTE_NOTES')].filter(Boolean).join('\n\n'),
    carbonation: round(numOf(x, 'CARBONATION', 2.4), 2),
  });

  r.fermentables = kids(x, 'FERMENTABLES', 'FERMENTABLE').map(f => ({
    name: txt(f, 'NAME'),
    type: FERM_TYPE[txt(f, 'TYPE', 'Grain').toLowerCase()] || 'other',
    amount: round(numOf(f, 'AMOUNT')),
    potential: round(yieldToPotential(numOf(f, 'YIELD', 80))),
    color: round(srmToEbc(numOf(f, 'COLOR')), 1), // malt °L taken as equal to SRM, as BeerSmith and Brewfather do
  }));

  r.hops = kids(x, 'HOPS', 'HOP').map(h => {
    const use = HOP_USE[txt(h, 'USE', 'Boil').toLowerCase()] || 'boil';
    const t = numOf(h, 'TIME');
    const hop = {
      name: txt(h, 'NAME'), form: /leaf|plug/i.test(txt(h, 'FORM')) ? 'leaf' : 'pellet',
      alpha: round(numOf(h, 'ALPHA'), 2), amount: round(numOf(h, 'AMOUNT') * 1000, 1), use,
    };
    if (use === 'dry hop') hop.time = round(t / 1440, 1);
    else if (use === 'boil') hop.time = round(t, 0);
    else if (use === 'whirlpool') { hop.time = round(t || 20, 0); hop.temp = 80; }
    return hop;
  });

  r.yeasts = kids(x, 'YEASTS', 'YEAST').map(y => ({
    name: [txt(y, 'PRODUCT_ID'), txt(y, 'NAME')].filter(Boolean).join(' '),
    lab: txt(y, 'LABORATORY'), form: txt(y, 'FORM', 'Dry').toLowerCase(),
    attenuation: round(numOf(y, 'ATTENUATION', 75), 1), amount: 1,
  }));

  r.miscs = kids(x, 'MISCS', 'MISC').map(m => {
    const isWeight = txt(m, 'AMOUNT_IS_WEIGHT').toLowerCase() === 'true';
    return {
      name: txt(m, 'NAME'), type: txt(m, 'TYPE', 'Other').toLowerCase(),
      amount: round(numOf(m, 'AMOUNT') * 1000, 2), unit: isWeight ? 'g' : 'ml',
      use: MISC_USE[txt(m, 'USE', 'Boil').toLowerCase()] || 'boil', time: round(numOf(m, 'TIME'), 0),
    };
  });

  const steps = kids(kid(x, 'MASH'), 'MASH_STEPS', 'MASH_STEP');
  if (steps.length) {
    r.mash = steps.map(s => ({
      name: txt(s, 'NAME', 'Step'), temp: round(numOf(s, 'STEP_TEMP', 66), 1), time: round(numOf(s, 'STEP_TIME', 60), 0),
    }));
  }

  const ferm = [['Primary', 'PRIMARY'], ['Secondary', 'SECONDARY'], ['Tertiary', 'TERTIARY']]
    .map(([name, k]) => ({ name, temp: round(numOf(x, k + '_TEMP', 19), 1), days: round(numOf(x, k + '_AGE'), 1) }))
    .filter(s => s.days > 0);
  if (ferm.length) r.fermentation = ferm;

  const d = Date.parse(txt(x, 'DATE'));
  if (!Number.isNaN(d)) r.created = new Date(d).toISOString().slice(0, 10);
  return r;
}

export function parseBeerXML(xml, Parser = globalThis.DOMParser) {
  const doc = new Parser().parseFromString(cleanEntities(xml), 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('This file is not valid XML, so it could not be read as BeerXML.');
  const recipes = [...doc.getElementsByTagName('*')].filter(e => e.tagName.toUpperCase() === 'RECIPE');
  if (!recipes.length) throw new Error('No recipes found in this BeerXML file.');
  return recipes.map(recipeFromXml);
}

// ---- export ----------------------------------------------------------
const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const tag = (name, value) => `<${name}>${esc(value)}</${name}>`;
const HOP_USE_OUT = { boil: 'Boil', 'dry hop': 'Dry Hop', mash: 'Mash', 'first wort': 'First Wort', whirlpool: 'Aroma' };
const MISC_USE_OUT = { boil: 'Boil', mash: 'Mash', fermentation: 'Primary', package: 'Bottling' };
const cap = s => String(s || '').replace(/\b\w/g, c => c.toUpperCase());

export function toBeerXML(r) {
  const hopTime = h => (h.use === 'dry hop' ? (h.time || 0) * 1440 : h.use === 'first wort' || h.use === 'mash' ? r.boilTime : h.time || 0);
  const ferm = r.fermentation || [];
  const stage = (i, k) => (ferm[i] ? tag(k + '_AGE', ferm[i].days) + tag(k + '_TEMP', ferm[i].temp) : '');
  return `<?xml version="1.0" encoding="UTF-8"?>
<RECIPES><RECIPE>
${tag('NAME', r.name)}${tag('VERSION', 1)}${tag('TYPE', cap(r.type || 'all grain'))}${tag('BREWER', r.author || 'Unknown')}
${tag('BATCH_SIZE', r.batchSize)}${tag('BOIL_SIZE', r.batchSize)}${tag('BOIL_TIME', r.boilTime)}${tag('EFFICIENCY', r.efficiency)}
<STYLE>${tag('NAME', r.style || 'Custom')}${tag('VERSION', 1)}${tag('CATEGORY', '')}${tag('CATEGORY_NUMBER', '')}${tag('STYLE_LETTER', '')}${tag('STYLE_GUIDE', 'BJCP 2021')}${tag('TYPE', 'Ale')}</STYLE>
<FERMENTABLES>${(r.fermentables || []).map(f => `<FERMENTABLE>${tag('NAME', f.name)}${tag('VERSION', 1)}${tag('TYPE', cap(f.type === 'honey' || f.type === 'other' ? 'adjunct' : f.type))}${tag('AMOUNT', f.amount)}${tag('YIELD', potentialToYield(f.potential).toFixed(1))}${tag('COLOR', ebcToSrm(f.color).toFixed(1))}</FERMENTABLE>`).join('')}</FERMENTABLES>
<HOPS>${(r.hops || []).map(h => `<HOP>${tag('NAME', h.name)}${tag('VERSION', 1)}${tag('ALPHA', h.alpha)}${tag('AMOUNT', (h.amount || 0) / 1000)}${tag('USE', HOP_USE_OUT[h.use] || 'Boil')}${tag('TIME', hopTime(h))}${tag('FORM', cap(h.form || 'pellet'))}</HOP>`).join('')}</HOPS>
<YEASTS>${(r.yeasts || []).map(y => `<YEAST>${tag('NAME', y.name)}${tag('VERSION', 1)}${tag('TYPE', 'Ale')}${tag('FORM', cap(y.form || 'dry'))}${tag('AMOUNT', 0.011)}${tag('LABORATORY', y.lab)}${tag('ATTENUATION', y.attenuation)}</YEAST>`).join('')}</YEASTS>
<MISCS>${(r.miscs || []).map(m => `<MISC>${tag('NAME', m.name)}${tag('VERSION', 1)}${tag('TYPE', cap(m.type || 'other'))}${tag('USE', MISC_USE_OUT[m.use] || 'Boil')}${tag('TIME', m.time || 0)}${tag('AMOUNT', (m.amount || 0) / 1000)}${tag('AMOUNT_IS_WEIGHT', m.unit === 'g' ? 'TRUE' : 'FALSE')}</MISC>`).join('')}</MISCS>
<WATERS></WATERS>
<MASH>${tag('NAME', 'Mash')}${tag('VERSION', 1)}${tag('GRAIN_TEMP', 18)}<MASH_STEPS>${(r.mash || []).map(s => `<MASH_STEP>${tag('NAME', s.name)}${tag('VERSION', 1)}${tag('TYPE', 'Infusion')}${tag('STEP_TEMP', s.temp)}${tag('STEP_TIME', s.time)}</MASH_STEP>`).join('')}</MASH_STEPS></MASH>
${tag('NOTES', r.notes)}${tag('FERMENTATION_STAGES', Math.max(1, ferm.length))}${stage(0, 'PRIMARY')}${stage(1, 'SECONDARY')}${stage(2, 'TERTIARY')}${tag('CARBONATION', r.carbonation)}${tag('DATE', r.created)}
</RECIPE></RECIPES>
`;
}
