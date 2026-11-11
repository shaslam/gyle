// Recipes are stored in the repo as BeerJSON 1.0 documents, one recipe per file.
// The app edits a flatter, all-metric model; this file converts both ways.
// Three things BeerJSON has no field for are kept under x_ keys: a hop's
// first-wort / whirlpool use (x_use), whirlpool temperature (x_temp) and the
// mash water-to-grain ratio (x_mash_ratio). x_equipment is the id of the
// equipment profile the recipe was designed on, and x_status is 'planning', 'ready' or 'archived'.
// Versions: x_family is shared by every version of a recipe (the id of the first one), x_version
// counts from 1, x_version_note says what changed, and x_based_on names the recipe a new
// recipe was started from ({ id, name, version }). Other software ignores all of them.

import { lovibondToSrm, srmToEbc, platoToSg, yieldToPotential, findStyleSafe } from './units.js';

const U = (value, unit) => ({ unit, value: Number.isFinite(+value) ? +value : 0 });
const today = () => new Date().toISOString().slice(0, 10);

export function blankRecipe(equip = {}) {
  return {
    name: 'New recipe', author: '', type: 'all grain', style: '',
    batchSize: equip.batchSize ?? 21, boilTime: equip.boilTime ?? 60, efficiency: equip.efficiency ?? 72,
    mashRatio: equip.mashRatio ?? 3,
    ...(equip.id ? { equipment: equip.id } : {}),
    fermentables: [], hops: [], yeasts: [], miscs: [],
    mash: [{ name: 'Saccharification', temp: 66, time: 60 }],
    fermentation: [{ name: 'Primary', temp: 19, days: 14 }],
    carbonation: 2.4, notes: '', status: 'planning', created: today(), modified: today(),
  };
}

// ---- app model -> BeerJSON --------------------------------------------
const hopTiming = (h, boilTime) => {
  switch (h.use) {
    case 'dry hop': return { use: 'add_to_fermentation', duration: U(h.time, 'day') };
    case 'mash': return { use: 'add_to_mash' };
    case 'first wort': return { use: 'add_to_boil', duration: U(boilTime, 'min') };
    default: return { use: 'add_to_boil', duration: U(h.time, 'min') };
  }
};
const MISC_USE = { mash: 'add_to_mash', boil: 'add_to_boil', fermentation: 'add_to_fermentation', package: 'add_to_package' };

export function toBeerJSON(r) {
  const style = findStyleSafe(r.style);
  const recipe = {
    name: r.name || 'Untitled',
    type: r.type || 'all grain',
    author: r.author || 'Unknown',
    created: r.created || today(),
    batch_size: U(r.batchSize, 'l'),
    efficiency: { brewhouse: U(r.efficiency, '%') },
    boil: { boil_time: U(r.boilTime, 'min') },
    ...(r.style ? {
      style: {
        name: r.style, type: 'beer', style_guide: style ? 'BJCP 2021' : 'Custom',
        category: style ? style.code.replace(/\D+$/, '') : '',
        ...(style ? { category_number: parseInt(style.code, 10), style_letter: style.code.replace(/^\d+/, '') } : {}),
      },
    } : {}),
    ingredients: {
      fermentable_additions: (r.fermentables || []).map(f => ({
        name: f.name, type: f.type || 'grain', amount: U(f.amount, 'kg'),
        color: U(f.color, 'EBC'), yield: { potential: U(f.potential, 'sg') },
      })),
      hop_additions: (r.hops || []).map(h => ({
        name: h.name, form: h.form || 'pellet', alpha_acid: U(h.alpha, '%'), amount: U(h.amount, 'g'),
        timing: hopTiming(h, r.boilTime),
        ...(h.use === 'first wort' || h.use === 'whirlpool' ? { x_use: h.use } : {}),
        ...(h.use === 'whirlpool' ? { x_temp: U(h.temp ?? 80, 'C') } : {}),
      })),
      culture_additions: (r.yeasts || []).map(y => ({
        name: y.name, type: y.type || 'ale', form: y.form || 'dry', producer: y.lab || '',
        attenuation: U(y.attenuation, '%'), amount: U(y.amount ?? 1, 'pkg'),
      })),
      miscellaneous_additions: (r.miscs || []).map(m => ({
        name: m.name, type: m.type || 'other', amount: U(m.amount, m.unit || 'g'),
        timing: { use: MISC_USE[m.use] || 'add_to_boil', ...(m.time != null ? { duration: U(m.time, 'min') } : {}) },
      })),
    },
    mash: {
      name: 'Mash', grain_temperature: U(18, 'C'),
      mash_steps: (r.mash || []).map(s => ({
        name: s.name, type: 'infusion', step_temperature: U(s.temp, 'C'), step_time: U(s.time, 'min'),
      })),
    },
    fermentation: {
      name: 'Fermentation',
      fermentation_steps: (r.fermentation || []).map(s => ({
        name: s.name, start_temperature: U(s.temp, 'C'), step_time: U(s.days, 'day'),
      })),
    },
    carbonation: +r.carbonation || 0,
    notes: r.notes || '',
    x_mash_ratio: U(r.mashRatio ?? 3, 'l/kg'),
    x_modified: r.modified || today(),
    ...(r.equipment ? { x_equipment: r.equipment } : {}),
    x_status: r.status === 'ready' || r.status === 'archived' ? r.status : 'planning',
    ...(r.water ? { x_water: r.water } : {}),
    ...(r.family ? { x_family: r.family } : {}),
    ...(r.version > 1 ? { x_version: r.version } : {}),
    ...(r.versionNote ? { x_version_note: r.versionNote } : {}),
    ...(r.basedOn ? { x_based_on: r.basedOn } : {}),
  };
  return { beerjson: { version: 1.0, recipes: [recipe] } };
}

// ---- BeerJSON -> app model --------------------------------------------
const VOL = { l: 1, ml: 0.001, gal: 3.785411784, qt: 0.946352946, pint: 0.473176473, cup: 0.2365882365, floz: 0.0295735296, tbsp: 0.0147867648, tsp: 0.0049289216, bbl: 117.347765, igal: 4.54609, ibbl: 163.659 };
const MASS = { kg: 1, g: 0.001, mg: 0.000001, lb: 0.45359237, oz: 0.028349523 };
const TIME = { min: 1, sec: 1 / 60, hr: 60, day: 1440, week: 10080 };
const v = q => (q && typeof q === 'object' ? +q.value : +q);
const litres = q => (q ? v(q) * (VOL[q.unit] ?? 1) : undefined);
const kilos = q => (q ? v(q) * (MASS[q.unit] ?? 1) : undefined);
const minutes = q => (q ? v(q) * (TIME[q.unit] ?? 1) : undefined);
const celsius = q => (q ? (q.unit === 'F' ? (v(q) - 32) * 5 / 9 : v(q)) : undefined);
const ebc = q => {
  if (!q) return 0;
  if (q.unit === 'SRM') return srmToEbc(v(q));
  if (q.unit === 'Lovi') return srmToEbc(lovibondToSrm(v(q)));
  return v(q);
};
const gravity = q => (q ? (q.unit === 'plato' || q.unit === 'brix' ? platoToSg(v(q)) : v(q)) : undefined);
const round = (x, d = 3) => (Number.isFinite(x) ? +x.toFixed(d) : x);

function potential(y) {
  if (!y) return 1.037;
  if (y.potential) return round(gravity(y.potential));
  const pct = y.fine_grind ?? y.coarse_grind;
  return pct ? round(yieldToPotential(v(pct))) : 1.037;
}

function hopFromJSON(h, boilTime) {
  const t = h.timing || {};
  const dur = t.duration ?? t.time;
  let use = 'boil';
  if (h.x_use === 'first wort' || h.x_use === 'whirlpool') use = h.x_use;
  else if (t.use === 'add_to_fermentation' || t.use === 'add_to_package') use = 'dry hop';
  else if (t.use === 'add_to_mash') use = 'mash';
  const out = {
    name: h.name || '', form: /leaf|whole|plug/i.test(h.form || '') ? 'leaf' : 'pellet',
    alpha: round(v(h.alpha_acid) || 0, 2), amount: round((kilos(h.amount) ?? 0) * 1000, 1), use,
  };
  if (use === 'dry hop') out.time = round((minutes(dur) ?? 5760) / 1440, 1);
  else if (use === 'boil' || use === 'whirlpool') out.time = round(minutes(dur) ?? (use === 'boil' ? boilTime : 20), 0);
  if (use === 'whirlpool') out.temp = round(celsius(h.x_temp) ?? 80, 0);
  return out;
}

const MISC_USE_BACK = { add_to_mash: 'mash', add_to_boil: 'boil', add_to_fermentation: 'fermentation', add_to_package: 'package' };

function miscFromJSON(m) {
  const a = m.amount || {};
  let amount = v(a) || 0, unit = 'each';
  if (a.unit in MASS) { amount = kilos(a) * 1000; unit = 'g'; }
  else if (a.unit in VOL) { amount = litres(a) * 1000; unit = 'ml'; }
  return {
    name: m.name || '', type: m.type || 'other', amount: round(amount, 2), unit,
    use: MISC_USE_BACK[m.timing?.use] || 'boil', time: round(minutes(m.timing?.duration ?? m.timing?.time) ?? 0, 0),
  };
}

export function recipeFromJSON(j) {
  const ing = j.ingredients || {};
  const boilTime = round(minutes(j.boil?.boil_time) ?? 60, 0);
  const r = blankRecipe();
  Object.assign(r, {
    name: j.name || 'Untitled',
    author: j.author && j.author !== 'Unknown' ? j.author : '',
    type: j.type || 'all grain',
    style: j.style?.name || '',
    batchSize: round(litres(j.batch_size) ?? 21, 2),
    boilTime,
    efficiency: round(v(j.efficiency?.brewhouse) || 72, 1),
    mashRatio: round(v(j.x_mash_ratio) || 3, 2),
    ...(j.x_equipment ? { equipment: j.x_equipment } : {}),
    status: j.x_status === 'ready' || j.x_status === 'archived' ? j.x_status : 'planning',
    ...(j.x_water ? { water: j.x_water } : {}),
    ...(j.x_family ? { family: String(j.x_family) } : {}),
    ...(j.x_version > 1 ? { version: Math.round(+j.x_version) } : {}),
    ...(j.x_version_note ? { versionNote: String(j.x_version_note) } : {}),
    ...(j.x_based_on?.name ? { basedOn: j.x_based_on } : {}),
    fermentables: (ing.fermentable_additions || []).map(f => ({
      name: f.name || '', type: f.type || 'grain', amount: round(kilos(f.amount) ?? 0),
      potential: potential(f.yield), color: round(ebc(f.color), 1),
    })),
    hops: (ing.hop_additions || []).map(h => hopFromJSON(h, boilTime)),
    yeasts: (ing.culture_additions || []).map(y => ({
      name: y.name || '', lab: y.producer || '', form: y.form || 'dry',
      attenuation: round(v(y.attenuation) || 75, 1), amount: y.amount?.unit === 'pkg' ? v(y.amount) : 1,
    })),
    miscs: (ing.miscellaneous_additions || []).map(miscFromJSON),
    carbonation: round(+j.carbonation || 2.4, 2),
    notes: j.notes || '',
    created: (j.created || today()).slice(0, 10),
    modified: j.x_modified || (j.created || today()).slice(0, 10),
  });
  if (j.mash?.mash_steps?.length) {
    r.mash = j.mash.mash_steps.map(s => ({
      name: s.name || 'Step', temp: round(celsius(s.step_temperature) ?? 66, 1), time: round(minutes(s.step_time) ?? 60, 0),
    }));
  }
  if (j.fermentation?.fermentation_steps?.length) {
    r.fermentation = j.fermentation.fermentation_steps.map(s => ({
      name: s.name || 'Step', temp: round(celsius(s.start_temperature) ?? 19, 1),
      days: round((minutes(s.step_time) ?? 20160) / 1440, 1),
    }));
  }
  return r;
}

export function fromBeerJSON(doc) {
  const recipes = doc?.beerjson?.recipes;
  if (!Array.isArray(recipes)) throw new Error('This JSON file is not BeerJSON (no beerjson.recipes list).');
  return recipes.map(recipeFromJSON);
}
