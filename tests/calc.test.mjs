// Run with:  node tests/calc.test.mjs
import assert from 'node:assert/strict';
import * as C from '../js/calc.js';
import { toBeerJSON, fromBeerJSON, blankRecipe } from '../js/beerjson.js';
import { toBeerXML } from '../js/beerxml.js';
import { grainDiPh } from '../js/data.js';
import { sheetPdf } from '../js/brewsheet.js';
import { toWinAnsi } from '../js/pdf.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: got ${a}, expected ${b} ±${tol}`);

const recipe = {
  ...blankRecipe(), name: 'House Pale Ale', style: 'American Pale Ale', batchSize: 21, boilTime: 60, efficiency: 72,
  fermentables: [
    { name: 'Maris Otter', type: 'grain', amount: 4.2, potential: 1.038, color: 6 },
    { name: 'Crystal Light', type: 'grain', amount: 0.3, potential: 1.034, color: 80 },
    { name: 'Wheat Malt', type: 'grain', amount: 0.2, potential: 1.038, color: 4 },
  ],
  hops: [
    { name: 'Magnum', amount: 18, alpha: 13, form: 'pellet', use: 'boil', time: 60 },
    { name: 'Cascade', amount: 25, alpha: 6.5, form: 'pellet', use: 'boil', time: 10 },
    { name: 'Cascade', amount: 30, alpha: 6.5, form: 'pellet', use: 'whirlpool', time: 20, temp: 80 },
    { name: 'Citra', amount: 40, alpha: 12.5, form: 'pellet', use: 'dry hop', time: 4 },
  ],
  yeasts: [{ name: 'SafAle US-05', lab: 'Fermentis', form: 'dry', attenuation: 81, amount: 1 }],
  family: 'house-pale-ale', version: 2, versionNote: 'More Citra',
  basedOn: { id: 'best-bitter-x1', name: 'Best Bitter', version: 3 },
};

const s = C.recipeStats(recipe);
// Hand check: 4.7 kg at ~37.7 ppg, 72 % into 5.548 gal ≈ 50.6 points.
near(s.og, 1.0506, 0.001, 'OG');
near(s.fg, 1 + 0.0506 * 0.19, 0.0005, 'FG');
near(s.abv, 5.4, 0.2, 'ABV');
assert.ok(s.ibu > 30 && s.ibu < 45, `IBU plausible, got ${s.ibu}`);
assert.equal(s.hopIbus[3], 0, 'dry hops add no IBU');
assert.ok(s.hopIbus[2] < s.hopIbus[1], 'whirlpool below a 10 min boil addition of similar size');
assert.ok(s.ebc > 12 && s.ebc < 22, `colour plausible, got ${s.ebc} EBC`);

// Colour matches Brewfather on a Black IPA it exported: 4.5 kg Maris Otter (3 SRM), 140 g chocolate (450),
// 100 g black patent (500), 18 L batch. Brewfather gives 22.7 SRM (44.7 EBC) with about 20 L at the end of the boil.
{
  const bipa = { batchSize: 18, fermentables: [
    { type: 'grain', amount: 4.5, color: C.srmToEbc(3) },
    { type: 'grain', amount: 0.14, color: C.srmToEbc(450) },
    { type: 'grain', amount: 0.1, color: C.srmToEbc(500) }] };
  near(C.recipeStats(bipa, { kettleLoss: 2 }).srm, 22.7, 0.2, 'Black IPA colour against Brewfather');
}
near(s.preBoilVol, 21 + 1.5 + 3.5, 0.001, 'pre-boil volume');
near(s.mashWater + s.spargeWater - s.grainKg * 1.0, s.preBoilVol, 0.001, 'water balance');

// Tinseth reference: 60 min at 1.050 is about 23 % utilisation.
near(C.tinseth(60, 1.05), 0.231, 0.003, 'Tinseth utilisation');
near(C.sgToPlato(1.048), 11.9, 0.1, 'SG to Plato');
near(C.platoToSg(12), 1.0484, 0.0005, 'Plato to SG');
near(C.abv(1.05, 1.01), 5.25, 0.001, 'ABV');
near(C.hydrometerCorrect(1.05, 20, 20), 1.05, 1e-9, 'no correction at calibration temp');
assert.ok(C.hydrometerCorrect(1.05, 40, 20) > 1.055, 'hot samples read low');
near(C.residualCO2(20), 0.86, 0.03, 'residual CO2 at 20 °C');
near(C.primingSugar(20, 20, 2.4).dextrose, 123, 4, 'priming dextrose');
near(C.volumeAtGravity(25, 1.04, 1.05), 20, 1e-9, 'boil-off volume');
near(C.strikeTemp(3, 18, 66), 72.56, 0.01, 'strike temperature');
near(C.pitchCells(21, 1.048), 187, 3, 'pitch cells');
near(C.refractometerFG(12, 6, 1.04), 1.010, 0.003, 'refractometer FG');
near(C.measuredEfficiency(recipe, s.og, 21), 72, 0.01, 'measured efficiency round trip');

// BeerJSON round trip keeps everything the editor uses.
const back = fromBeerJSON(JSON.parse(JSON.stringify(toBeerJSON(recipe))))[0];
for (const k of ['name', 'style', 'batchSize', 'boilTime', 'efficiency', 'fermentables', 'hops', 'yeasts', 'mash', 'fermentation', 'carbonation', 'family', 'version', 'versionNote', 'basedOn']) {
  assert.deepEqual(back[k], recipe[k], `BeerJSON round trip: ${k}`);
}
const s2 = C.recipeStats(back);
near(s2.og, s.og, 1e-9, 'round trip OG');
near(s2.ibu, s.ibu, 1e-9, 'round trip IBU');

// Foreign BeerJSON in US units converts to metric.
const us = fromBeerJSON({ beerjson: { version: 1, recipes: [{
  name: 'US units', type: 'all grain', author: 'x', batch_size: { unit: 'gal', value: 5 },
  efficiency: { brewhouse: { unit: '%', value: 70 } }, boil: { boil_time: { unit: 'hr', value: 1 } },
  ingredients: {
    fermentable_additions: [{ name: '2-row', type: 'grain', amount: { unit: 'lb', value: 10 }, color: { unit: 'Lovi', value: 2 }, yield: { fine_grind: { unit: '%', value: 80 } } }],
    hop_additions: [{ name: 'Cascade', alpha_acid: { unit: '%', value: 6 }, amount: { unit: 'oz', value: 1 }, timing: { use: 'add_to_boil', time: { unit: 'min', value: 60 } } }],
  },
}] } })[0];
near(us.batchSize, 18.93, 0.01, 'gallons to litres');
near(us.fermentables[0].amount, 4.536, 0.001, 'pounds to kg');
near(us.fermentables[0].potential, 1.037, 0.0005, 'yield to potential');
near(us.hops[0].amount, 28.3, 0.1, 'ounces to grams');
assert.equal(us.hops[0].time, 60);
assert.equal(us.boilTime, 60);

// Water: 1 g of gypsum in 1 L, and salts suggested from RO water land close to the target.
near(C.waterWithSalts({}, { gypsum: 1 }, 1).ca, 232.8, 0.01, 'gypsum calcium');
near(C.waterWithSalts({ ca: 20 }, { cacl2: 3 }, 30).cl, 48.2, 0.1, 'calcium chloride in 30 L');
const balanced = { ca: 80, mg: 5, na: 25, cl: 75, so4: 80, hco3: 100 };
const made = C.waterWithSalts({}, C.suggestSalts({}, balanced, 30), 30);
for (const i of ['ca', 'mg', 'cl', 'so4']) near(made[i], balanced[i], 15, `suggested salts: ${i}`);
assert.ok(Object.values(C.suggestSalts(balanced, { ca: 7, cl: 5, so4: 5 }, 30)).every(g => g === 0), 'cannot remove minerals');

// Mash pH: distilled water gives the grist's own pH, alkalinity raises it, acid lowers it,
// and the suggested dose lands on the target.
const ro = { ca: 0, mg: 0, na: 0, cl: 0, so4: 0, hco3: 0 };
const m0 = C.mashPh(recipe, ro, 14.1, grainDiPh);
assert.ok(m0.ph > 5.55 && m0.ph < 5.75, `pale grist in RO water, got ${m0.ph}`);
assert.ok(C.mashPh(recipe, { ...ro, hco3: 250 }, 14.1, grainDiPh).ph > m0.ph + 0.1, 'alkaline water raises mash pH');
assert.ok(C.mashPh(recipe, { ...ro, ca: 150 }, 14.1, grainDiPh).ph < m0.ph, 'calcium lowers mash pH');
const dose = m0.mlFor(5.4);
assert.ok(dose > 2 && dose < 8, `lactic dose plausible, got ${dose}`);
near(C.mashPh({ ...recipe, water: { acid: { type: 'lactic88', ml: dose } } }, ro, 14.1, grainDiPh).ph, 5.4, 1e-9, 'suggested acid hits target');
const stout = { ...recipe, fermentables: [...recipe.fermentables, { name: 'Roasted Barley', type: 'grain', amount: 0.5, potential: 1.025, color: 1200 }] };
assert.ok(C.mashPh(stout, ro, 15.6, grainDiPh).ph < m0.ph - 0.05, 'roast malt lowers mash pH');
near(C.residualAlkalinity({ ca: 110, mg: 10, hco3: 40 }) * 50, -51.6, 1, 'residual alkalinity as CaCO3');

assert.match(toBeerXML(recipe), /<NAME>House Pale Ale<\/NAME>/);

// Brew sheet PDF: a well-formed file whose cross-reference table points at each object,
// with a page break once the content runs past one page.
assert.equal(toWinAnsi('66 °C · 5 g – CO₂ → done'), '66 \xb0C \xb7 5 g \x96 CO2 -> done');
const long = Array.from({ length: 60 }, (_, i) => ({ text: `Step ${i + 1}: a fairly long instruction that wraps onto a second line on the printed page`, done: i % 3 === 0 }));
const pdf = sheetPdf({
  title: 'House Pale Ale (v2)', subtitle: 'Version 2 · American Pale Ale · 21 L', colour: '#c98a2b', footer: 'test',
  meta: [['Brewer', 'Stuart'], ['Brew date', null]], stats: [['OG', '1.051'], ['IBU', '38']],
  sections: [
    { title: 'Hops', table: { cols: [{ h: 'Name', w: 0.6 }, { h: 'g', w: 0.4, right: 1 }], rows: [['Citra', '40'], ['Actual', null]] } },
    { title: 'Mash', half: true, text: 'Left' }, { title: 'Water', half: true, note: 'Right' },
    { title: 'Brew day', checklist: long }, { title: 'Notes', lines: 4 },
  ],
});
const raw = Buffer.from(pdf).toString('latin1');
assert.ok(raw.startsWith('%PDF-1.4') && raw.trimEnd().endsWith('%%EOF'), 'PDF header and trailer');
const xrefAt = +/startxref\n(\d+)/.exec(raw)[1];
assert.ok(raw.startsWith('xref', xrefAt), 'startxref points at the xref table');
const offsets = [...raw.slice(xrefAt).matchAll(/^(\d{10}) 00000 n $/gm)].map(x => +x[1]);
offsets.forEach((o, i) => assert.ok(raw.startsWith(`${i + 1} 0 obj`, o), `xref offset of object ${i + 1}`));
const pages = +/\/Count (\d+)/.exec(raw)[1];
assert.ok(pages >= 2, `long checklist runs onto a second page, got ${pages}`);
for (const m of raw.matchAll(/<< \/Length (\d+) >>\nstream\n/g)) {
  assert.equal(raw.slice(m.index + m[0].length + +m[1], m.index + m[0].length + +m[1] + 10), '\nendstream', 'stream length');
}
assert.match(raw, /\(House Pale Ale \\\(v2\\\)\) Tj/, 'brackets in text are escaped');

// ---- Brewfather complete backup ----
{
  const eqBf = { _id: 'EqAbCdEf123', name: 'Kettle', batchSize: 23, brewhouseEfficiency: 64, efficiency: 60, boilTime: 60, boilOffPerHr: 2,
    trubChillerLoss: 2, mashTunDeadSpace: 1.5, grainAbsorptionRate: 0.96, waterGrainRatio: 3, grainTemperature: 20, hopstandTemperature: 85 };
  const tap = { _id: 'TapWater99', name: 'Tap', type: 'source', calcium: 18, magnesium: 3.7, sodium: 10.4, chloride: 34.1, sulfate: 31.7, bicarbonate: 43 };
  const bfRecipe = {
    _id: 'RecIpe0001xyz', name: 'Test Pale', type: 'All Grain', batchSize: 23, boilTime: 60, efficiency: 64, carbonation: 2.4,
    style: { name: 'American Pale Ale' }, equipment: eqBf, _created: { _seconds: 1674235119 }, _timestamp_ms: 1700000000000, notes: 'Good',
    fermentables: [{ name: 'Pale Ale Malt', type: 'Grain', amount: 5, potential: 1.037, color: 3 }, { name: 'Malt Extract', type: 'Liquid Extract', amount: 0.5, potential: 1.036, color: 4 }],
    hops: [
      { name: 'Magnum', type: 'Pellet', use: 'Boil', time: 60, alpha: 12, amount: 15 },
      { name: 'Cascade', type: 'Pellet', use: 'Aroma', time: 20, temp: null, alpha: 6, amount: 65 },
      { name: 'Cascade', type: 'Whole', use: 'Dry Hop', time: 3, alpha: 6, amount: 60 },
    ],
    yeasts: [{ name: 'Safale American', productId: 'US-05', laboratory: 'Fermentis', form: 'Dry', unit: 'pkg', amount: 2, attenuation: 78 }],
    miscs: [
      { name: 'Gypsum (CaSO4)', type: 'Water Agent', use: 'Mash', unit: 'g', amount: 4, waterAdjustment: true },
      { name: 'Protafloc', type: 'Fining', use: 'Boil', unit: 'items', amount: 1, time: 15 },
      { name: 'Nutrient', type: 'Other', use: 'Boil', unit: 'tsp', amount: 1, time: 10 },
    ],
    mash: { steps: [{ name: 'Sacch', stepTemp: 68, stepTime: 60 }] },
    fermentation: { steps: [{ type: 'Primary', stepTemp: 19, stepTime: 14 }] },
    water: { source: tap, target: { _id: 'OneOff', name: 'Style - General' },
      mashAdjustments: { calciumSulfate: 4, calciumChloride: 1, acids: [{ type: 'lactic', concentration: 80, amount: 2 }] },
      enableSpargeAdjustments: true, spargeAdjustments: { calciumSulfate: 1.5 }, enableAcidAdjustments: true },
  };
  const backup = {
    _type: 'Brewfather_Export_User_1',
    data: {
      recipes: [bfRecipe],
      batches: [{ _id: 'BatchAAAA1111', batchNo: 7, name: 'Batch', status: 'Completed', brewDate: Date.UTC(2025, 0, 18), bottlingDate: Date.UTC(2025, 1, 1),
        measuredOg: 1.052, measuredBatchSize: 22, tasteRating: 83, recipe: bfRecipe,
        notes: [{ timestamp: Date.UTC(2025, 0, 20), status: 'Fermenting', note: 'Krausen up' }, { timestamp: Date.UTC(2025, 0, 18), status: 'Brewing', note: '' }] }],
      profiles: { equipment: [eqBf], water: [tap, { _id: 'default-hoppy', name: 'Hoppy', type: 'target' }] },
    },
    completeBackup: { documents: [{ path: 'batches/BatchAAAA1111/readings_accumulated/x', data: { data: {
      a: { sg: 1.0501, temp: 20, battery: 4.1, time: Date.UTC(2025, 0, 19, 10, 5) },
      b: { sg: 1.0499, temp: 20.2, battery: 4.1, time: Date.UTC(2025, 0, 19, 10, 50) },
      c: { sg: 1.2137, temp: 22, battery: 4, time: Date.UTC(2025, 0, 19, 11, 5) }, // out of the beer: ignored
    } } }] },
  };
  const { fromBrewfatherBackup } = await import('../js/brewfather.js');
  const bf = fromBrewfatherBackup(backup);
  const r = bf.recipes[0].data;
  assert.equal(bf.recipes[0].id, 'bf-test-pale-recipe00', 'stable recipe id from the Brewfather id');
  assert.deepEqual(r.hops.map(h => [h.use, h.time, h.temp ?? null, h.form]), [['boil', 60, null, 'pellet'], ['whirlpool', 20, 85, 'pellet'], ['dry hop', 3, null, 'leaf']],
    'hopstand becomes a whirlpool at the equipment hopstand temperature');
  assert.deepEqual(r.fermentables.map(f => [f.type, f.color]), [['grain', 5.9], ['extract', 7.9]], 'fermentable types, SRM to EBC');
  assert.equal(r.yeasts[0].name, 'Safale American (US-05)');
  assert.equal(r.yeasts[0].amount, 2);
  assert.deepEqual(r.miscs.map(m => [m.name, m.unit, m.amount]), [['Protafloc', 'each', 1], ['Nutrient', 'ml', 4.93]], 'water calculator rows dropped, units converted');
  assert.deepEqual(r.water, { source: 'bf-tapwater', salts: { gypsum: 5.5, cacl2: 1 }, acid: { type: 'lactic80', ml: 2 } }, 'water: mash plus sparge salts, one-off target left out');
  assert.equal(r.equipment, 'bf-eqabcdef');
  assert.deepEqual([r.created, r.modified], ['2023-01-20', '2023-11-14']);
  assert.deepEqual(bf.profiles[0], { id: 'bf-eqabcdef', name: 'Kettle', batchSize: 23, efficiency: 64, boilTime: 60, boilOff: 2, kettleLoss: 2, mashLoss: 1.5, absorption: 0.96, mashRatio: 3, grainTemp: 20 });
  assert.deepEqual(bf.waters.map(w => w.id), ['bf-tapwater'], 'source water imported, built-in target not used by a recipe left out');
  const b = bf.brews[0].data;
  assert.equal(bf.brews[0].id, 'bf-2025-01-18-test-pale-batchaaa');
  assert.deepEqual([b.name, b.status, b.brewDate, b.packagedDate, b.recipeId, b.rating], ['Test Pale #7', 'finished', '2025-01-18', '2025-02-01', 'bf-test-pale-recipe00', 4]);
  assert.deepEqual([b.measured.og, b.measured.fermenterVol, b.measured.fg], [1.052, 22, null]);
  assert.equal(b.notes, '2025-01-20 (Fermenting): Krausen up', 'notes in date order, empty ones left out');
  assert.deepEqual(b.deviceReadings, [{ t: '2025-01-19T10:00:00Z', sg: 1.05, temp: 20.1, battery: 4.1 }], 'readings: one per hour, bad ones dropped');
  // the recipe survives the trip through BeerJSON storage
  const back = fromBeerJSON(toBeerJSON(r))[0];
  assert.deepEqual([back.hops, back.water, back.equipment], [r.hops, r.water, r.equipment], 'imported recipe round trip');

  // the zip reader, on a zip built here with one stored and one deflated file
  const { deflateRawSync, crc32 } = await import('node:zlib');
  const files = [['a.txt', Buffer.from('plain'), 0], ['backup.json', Buffer.from(JSON.stringify(backup)), 8]];
  const local = [], central = []; let off = 0;
  for (const [name, content, method] of files) {
    const body = method ? deflateRawSync(content) : content, nm = Buffer.from(name), crc = crc32 ? crc32(content) : 0;
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(method, 8); h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(body.length, 18); h.writeUInt32LE(content.length, 22); h.writeUInt16LE(nm.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 6); c.writeUInt16LE(method, 10); c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(body.length, 20); c.writeUInt32LE(content.length, 24); c.writeUInt16LE(nm.length, 28); c.writeUInt32LE(off, 42);
    local.push(h, nm, body); central.push(c, nm); off += 30 + nm.length + body.length;
  }
  const dir = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(off, 16);
  const { unzip } = await import('../js/unzip.js');
  const got = await unzip(Buffer.concat([...local, dir, end]));
  assert.deepEqual(got.map(f => f.name), ['a.txt', 'backup.json']);
  assert.equal(Buffer.from(got[0].bytes).toString(), 'plain');
  assert.equal(fromBrewfatherBackup(JSON.parse(Buffer.from(got[1].bytes).toString())).recipes.length, 1, 'zip: deflated backup reads back');
}
console.log('All checks passed.');
console.log(`House Pale Ale: OG ${s.og.toFixed(3)}  FG ${s.fg.toFixed(3)}  ABV ${s.abv.toFixed(1)}  IBU ${s.ibu.toFixed(0)}  EBC ${s.ebc.toFixed(0)}`);
