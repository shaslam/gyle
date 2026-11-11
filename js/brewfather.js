// Brewfather's complete backup (Settings → Export → Complete backup in Brewfather): a zip with
// one backup.json. This turns it into Gyle's own models. It is pure: app.js decides ids, names
// and what is already there.
//
// What comes across: every recipe (as it is now), every batch as a brew log with its notes,
// measurements and iSpindel/Tilt readings, the equipment profiles, and the water profiles that
// recipes use. Inventory, recipe version history (Brewfather keeps full copies, which Gyle does
// not need), device settings and calendar events are left out.
//
// Brewfather stores colours in SRM, weights in kg (hops in g), volumes in litres and
// temperatures in °C, the same as Gyle apart from colour.

import { hourly } from './sources.js';
import { DEFAULT_EQUIP } from './calc.js';

export const isBrewfatherBackup = j => typeof j?._type === 'string' && /^Brewfather_Export/.test(j._type) && !!j.data;

const num = (x, d = null) => { const v = parseFloat(x); return Number.isFinite(v) ? v : d; };
const round = (x, d = 3) => (Number.isFinite(x) ? +x.toFixed(d) : x);
const lower = s => String(s || '').trim().toLowerCase();

// Brewfather dates come as milliseconds, { _seconds }, { seconds } or ISO text.
function toDate(x) {
  let ms = null;
  if (typeof x === 'number') ms = x;
  else if (typeof x === 'string') ms = Date.parse(x);
  else if (x && typeof x === 'object') ms = (x._seconds ?? x.seconds) * 1000;
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : null;
}

export const slug = s => (s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, 40) || 'recipe';
// A short, stable piece of a Brewfather id, so that importing the same backup twice finds what is already there.
const tag = id => String(id || 'none').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
export const recipeId = r => `bf-${slug(r.name)}-${tag(r._id)}`;
export const brewId = b => `bf-${toDate(b.brewDate) || 'undated'}-${slug(b.recipe?.name)}-${tag(b._id)}`;
const equipId = e => `bf-${tag(e._id)}`;
const waterId = w => (/^default-(ro|distilled)$/.test(w?._id) ? 'ro' : `bf-${tag(w._id)}`);

// ---------- equipment and water ----------
export function equipmentFrom(e) {
  const v = (k, d) => round(num(e[k], d), 2);
  return {
    id: equipId(e), name: e.name || 'Brewfather equipment',
    batchSize: v('batchSize', DEFAULT_EQUIP.batchSize),
    efficiency: v('brewhouseEfficiency', num(e.efficiency, DEFAULT_EQUIP.efficiency)),
    boilTime: v('boilTime', DEFAULT_EQUIP.boilTime),
    boilOff: v('boilOffPerHr', DEFAULT_EQUIP.boilOff),
    kettleLoss: v('trubChillerLoss', DEFAULT_EQUIP.kettleLoss),
    mashLoss: v('mashTunDeadSpace', DEFAULT_EQUIP.mashLoss),
    absorption: v('grainAbsorptionRate', DEFAULT_EQUIP.absorption),
    mashRatio: v('waterGrainRatio', DEFAULT_EQUIP.mashRatio),
    grainTemp: v('grainTemperature', DEFAULT_EQUIP.grainTemp),
  };
}

export const waterFrom = w => ({
  id: waterId(w), name: w.name || 'Brewfather water',
  ca: round(num(w.calcium, 0), 1), mg: round(num(w.magnesium, 0), 1), na: round(num(w.sodium, 0), 1),
  cl: round(num(w.chloride, 0), 1), so4: round(num(w.sulfate, 0), 1), hco3: round(num(w.bicarbonate, 0), 1),
});

// Brewfather's salt names -> Gyle's (js/calc.js SALTS).
const SALT_KEYS = { calciumSulfate: 'gypsum', calciumChloride: 'cacl2', magnesiumSulfate: 'epsom', sodiumChloride: 'salt', sodiumBicarbonate: 'soda' };
function acidKey(a) {
  const c = num(a.concentration, 0);
  if (lower(a.type) === 'lactic') return c >= 84 ? 'lactic88' : 'lactic80';
  if (lower(a.type) === 'phosphoric') return c >= 80 ? 'phos85' : c >= 50 ? 'phos75' : 'phos10';
  return null;
}

// The recipe's water: source, target, salts (mash and sparge added together, as Gyle treats salts
// as dissolved in all the brewing water) and the mash acid.
function waterSetting(w, targets) {
  if (!w) return null;
  const out = {};
  if (w.source?._id) out.source = waterId(w.source);
  if (w.target?._id && targets.has(w.target._id)) out.target = waterId(w.target);
  const salts = {};
  for (const adj of [w.mashAdjustments, w.enableSpargeAdjustments ? w.spargeAdjustments : null]) {
    for (const [bf, key] of Object.entries(SALT_KEYS)) {
      const g = num(adj?.[bf], 0);
      if (g > 0) salts[key] = round((salts[key] || 0) + g, 2);
    }
  }
  if (Object.keys(salts).length) out.salts = salts;
  const acid = w.enableAcidAdjustments !== false ? (w.mashAdjustments?.acids || []).find(a => num(a.amount, 0) > 0 && acidKey(a)) : null;
  if (acid) out.acid = { type: acidKey(acid), ml: round(num(acid.amount), 2) };
  return Object.keys(out).length ? out : null;
}

// ---------- recipes ----------
const FERM_TYPE = { grain: 'grain', 'liquid extract': 'extract', 'dry extract': 'dry extract', extract: 'extract', sugar: 'sugar', adjunct: 'grain', honey: 'honey' };
const MISC_USE = { mash: 'mash', sparge: 'mash', boil: 'boil', flameout: 'boil', whirlpool: 'boil', primary: 'fermentation', secondary: 'fermentation', bottling: 'package', packaging: 'package' };

function hopFrom(h, r) {
  const use = { boil: 'boil', 'first wort': 'first wort', aroma: 'whirlpool', 'dry hop': 'dry hop', mash: 'mash' }[lower(h.use)] || 'boil';
  const out = {
    name: h.name || '', form: /leaf|whole|plug/i.test(h.type || '') ? 'leaf' : 'pellet',
    alpha: round(num(h.alpha, 0), 2), amount: round(num(h.amount, 0), 1), use,
  };
  if (use === 'boil' || use === 'whirlpool') out.time = round(num(h.time, use === 'boil' ? num(r.boilTime, 60) : 20), 0);
  if (use === 'dry hop') out.time = round(num(h.time, 4), 1);
  // A hopstand without its own temperature uses the equipment's hopstand temperature, as Brewfather does.
  if (use === 'whirlpool') out.temp = round(num(h.temp) ?? num(r.equipment?.hopstandTemperature) ?? num(r.avgWeightedHopstandTemp) ?? 80, 0);
  return out;
}

function miscFrom(m) {
  let amount = num(m.amount, 0), unit = lower(m.unit);
  if (unit === 'items' || unit === 'pkg' || unit === 'each' || !unit) unit = 'each';
  else if (unit === 'tsp') { amount *= 4.93; unit = 'ml'; }
  else if (unit === 'tbsp') { amount *= 14.79; unit = 'ml'; }
  else if (unit === 'oz') { amount *= 28.35; unit = 'g'; }
  else if (unit === 'kg') { amount *= 1000; unit = 'g'; }
  else if (unit === 'l') { amount *= 1000; unit = 'ml'; }
  else if (unit !== 'g' && unit !== 'ml') unit = 'g';
  const use = MISC_USE[lower(m.use)] || 'boil';
  return { name: m.name || '', type: lower(m.type) || 'other', amount: round(amount, 2), unit, use, time: lower(m.use) === 'flameout' ? 0 : round(num(m.time, 0), 0) };
}

// One Brewfather recipe -> Gyle's recipe model. `equipment` maps Brewfather equipment ids/names to Gyle profile ids.
export function recipeFrom(r, equipment = new Map(), targets = new Set()) {
  const water = waterSetting(r.water, targets);
  // Salt and acid rows that Brewfather adds from its water calculator are already in the water setting.
  const miscs = (r.miscs || []).filter(m => !(water && m.waterAdjustment)).map(miscFrom);
  const eq = r.equipment ? (equipment.get(r.equipment._id) || equipment.get(r.equipment.name)) : null;
  const yeastName = y => (y.productId && !String(y.name || '').includes(y.productId) ? `${y.name} (${y.productId})` : y.name || '');
  return {
    name: String(r.name || 'Untitled').trim(), author: r.author || '', type: lower(r.type) || 'all grain',
    style: r.style?.name || '',
    batchSize: round(num(r.batchSize, 21), 2), boilTime: round(num(r.boilTime, 60), 0), efficiency: round(num(r.efficiency, 72), 1),
    mashRatio: round(num(r.equipment?.waterGrainRatio, 3), 2),
    ...(eq ? { equipment: eq } : {}),
    fermentables: (r.fermentables || []).map(f => ({
      name: f.name || '', type: FERM_TYPE[lower(f.type)] || 'other', amount: round(num(f.amount, 0), 3),
      potential: round(num(f.potential, 1.037), 4), color: round(num(f.color, 0) * 1.97, 1), // SRM -> EBC
    })),
    hops: (r.hops || []).map(h => hopFrom(h, r)),
    yeasts: (r.yeasts || []).map(y => ({
      name: yeastName(y), lab: y.laboratory || '', form: lower(y.form) || 'dry',
      attenuation: round(num(y.attenuation, 75), 1), amount: lower(y.unit) === 'pkg' ? num(y.amount, 1) : 1,
    })),
    miscs,
    mash: (r.mash?.steps || []).map(s => ({ name: s.name || s.type || 'Step', temp: round(num(s.stepTemp, 66), 1), time: round(num(s.stepTime, 60), 0) })),
    fermentation: (r.fermentation?.steps || []).map(s => ({ name: s.name || s.type || 'Step', temp: round(num(s.stepTemp, 19), 1), days: round(num(s.stepTime, 7), 1) })),
    ...(water ? { water } : {}),
    carbonation: round(num(r.carbonation, 2.4), 2), notes: r.notes || '', status: 'planning',
    created: toDate(r._created) || toDate(r._timestamp_ms) || new Date().toISOString().slice(0, 10),
    modified: toDate(r._timestamp_ms) || toDate(r._created) || new Date().toISOString().slice(0, 10),
  };
}

// ---------- batches ----------
const STATUS = { planning: 'planned', brewing: 'brew day', fermenting: 'fermenting', conditioning: 'conditioning', completed: 'finished', archived: 'finished' };

// Device readings (iSpindel, Tilt and others) for one batch, one per hour like a ThingSpeak link.
function deviceReadings(docs, batchId) {
  const raw = [];
  for (const d of docs) {
    if (!d.path?.includes(`batches/${batchId}/readings_accumulated/`)) continue;
    for (const x of Object.values(d.data?.data || {})) {
      const sg = num(x.sg), t = num(x.time);
      // Ignore readings taken out of the beer (an iSpindel lying flat reads far too high).
      if (sg == null || t == null || sg < 0.98 || sg > 1.15) continue;
      raw.push({ t: new Date(t).toISOString(), sg, temp: num(x.temp), battery: num(x.battery) });
    }
  }
  return raw.length ? hourly(raw) : [];
}

export function brewFrom(b, docs, recipeIds, equipment, targets) {
  const snap = recipeFrom(b.recipe || {}, equipment, targets);
  const eq = b.recipe?.equipment ? equipmentFrom(b.recipe.equipment) : null;
  const notes = [...(b.notes || [])].filter(n => String(n.note || '').trim()).sort((x, y) => num(x.timestamp, 0) - num(y.timestamp, 0))
    .map(n => `${toDate(n.timestamp) || ''}${n.status ? ` (${n.status})` : ''}: ${String(n.note || '').trim()}`).join('\n\n');
  const finished = /completed|archived|conditioning/i.test(b.status || '') || b.bottlingDateSet;
  const rating = num(b.tasteRating, 0) > 0 ? Math.max(1, Math.min(5, Math.round(num(b.tasteRating) / 20))) : null;
  const label = b.name && b.name !== 'Batch' ? ` (${b.name})` : '';
  const readings = deviceReadings(docs, b._id);
  return {
    name: `${snap.name}${b.batchNo != null ? ` #${b.batchNo}` : ''}${label}`,
    recipeId: recipeIds.get(b.recipe?._id) || null,
    recipe: snap, ...(eq ? { equipment: { ...DEFAULT_EQUIP, ...eq } } : {}),
    status: STATUS[lower(b.status)] || 'planned',
    brewDate: toDate(b.brewDate) || '', packagedDate: finished ? toDate(b.bottlingDate) || '' : '',
    measured: {
      preBoilVol: num(b.measuredBoilSize), preBoilSG: num(b.measuredPreBoilGravity), og: num(b.measuredOg),
      fermenterVol: num(b.measuredBatchSize), fg: num(b.measuredFg),
    },
    readings: [], checklist: {}, notes, tasting: b.tasteNotes || '', rating,
    ...(readings.length ? { deviceReadings: readings } : {}),
  };
}

// ---------- the whole backup ----------
// Returns everything converted, with Gyle ids. Recipes keep their Brewfather names; app.js makes them unique.
export function fromBrewfatherBackup(j) {
  if (!isBrewfatherBackup(j)) throw new Error('This is not a Brewfather backup.');
  const data = j.data, docs = j.completeBackup?.documents || [];
  const recipesIn = (data.recipes || []).filter(r => !r.hidden);

  // Equipment: the profiles you keep in Brewfather. Recipes made on equipment that is no longer
  // in the list fall back to Gyle's default profile.
  const profiles = (data.profiles?.equipment || []).filter(e => !e.hidden).map(equipmentFrom);
  const equipment = new Map();
  for (const e of data.profiles?.equipment || []) { equipment.set(e._id, equipId(e)); if (!equipment.has(e.name)) equipment.set(e.name, equipId(e)); }

  // Water: the profiles in your Brewfather list that you made yourself or that a recipe uses, and
  // each recipe's source water. A recipe's one-off target (not in the list) is left out of its water
  // setting. RO and distilled map to Gyle's own.
  const listed = new Map((data.profiles?.water || []).map(w => [w._id, w]));
  const waters = new Map();
  const addWater = w => { if (w?._id && waterId(w) !== 'ro' && !waters.has(waterId(w))) waters.set(waterId(w), waterFrom(w)); };
  for (const r of recipesIn) {
    addWater(r.water?.source);
    if (listed.has(r.water?.target?._id)) addWater(listed.get(r.water.target._id));
  }
  for (const w of listed.values()) if (!/^default-/.test(w._id)) addWater(w);

  const targets = new Set(listed.keys());
  const recipeIds = new Map(recipesIn.map(r => [r._id, recipeId(r)]));
  const recipes = recipesIn.map(r => ({ id: recipeIds.get(r._id), data: recipeFrom(r, equipment, targets) }));
  const brews = (data.batches || []).map(b => ({ id: brewId(b), data: brewFrom(b, docs, recipeIds, equipment, targets) }));
  return { recipes, brews, profiles, waters: [...waters.values()] };
}
