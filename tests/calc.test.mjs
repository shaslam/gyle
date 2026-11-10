// Run with:  node tests/calc.test.mjs
import assert from 'node:assert/strict';
import * as C from '../js/calc.js';
import { toBeerJSON, fromBeerJSON, blankRecipe } from '../js/beerjson.js';
import { toBeerXML } from '../js/beerxml.js';
import { grainDiPh } from '../js/data.js';

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
for (const k of ['name', 'style', 'batchSize', 'boilTime', 'efficiency', 'fermentables', 'hops', 'yeasts', 'mash', 'fermentation', 'carbonation']) {
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
console.log('All checks passed.');
console.log(`House Pale Ale: OG ${s.og.toFixed(3)}  FG ${s.fg.toFixed(3)}  ABV ${s.abv.toFixed(1)}  IBU ${s.ibu.toFixed(0)}  EBC ${s.ebc.toFixed(0)}`);
