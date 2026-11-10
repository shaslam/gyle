// Brewing maths. Everything is metric internally: litres, kilograms, grams, °C, EBC.

export const L_PER_GAL = 3.785411784;
export const LB_PER_KG = 2.20462262;

export const DEFAULT_EQUIP = {
  batchSize: 21,     // litres into the fermenter
  efficiency: 72,    // brewhouse efficiency, %
  boilTime: 60,      // minutes
  boilOff: 3.5,      // litres per hour
  kettleLoss: 1.5,   // litres left behind as trub
  absorption: 1.0,   // litres of water held per kg of grain
  mashLoss: 0,       // litres left in the mash tun (dead space)
  mashRatio: 3.0,    // litres of water per kg of grain
  grainTemp: 18,     // °C
};

const num = (v, d = 0) => {
  const x = parseFloat(v);
  return Number.isFinite(x) ? x : d;
};

export const isMashed = f => (f.type || 'grain') === 'grain';

// ---- unit conversions -------------------------------------------------
export const ebcToSrm = e => e / 1.97;
export const srmToEbc = s => s * 1.97;
export const lovibondToSrm = l => Math.max(0, 1.3546 * l - 0.76);
export const srmToLovibond = s => (s + 0.76) / 1.3546;
export const cToF = c => c * 9 / 5 + 32;
export const sgToPlato = sg => -616.868 + 1111.14 * sg - 630.272 * sg * sg + 135.997 * sg ** 3;
export const platoToSg = p => 1 + p / (258.6 - (p / 258.2) * 227.1);
export const yieldToPotential = pct => 1 + (pct / 100) * 0.04621;
export const potentialToYield = sg => ((sg - 1) / 0.04621) * 100;

const SRM_HEX = ['#FFF4B8', '#FFE699', '#FFD878', '#FFCA5A', '#FFBF42', '#FBB123', '#F8A600', '#F39C00', '#EA8F00',
  '#E58500', '#DE7C00', '#D77200', '#CF6900', '#CB6200', '#C35900', '#BB5100', '#B54C00', '#B04500', '#A63E00',
  '#A13700', '#9B3200', '#952D00', '#8E2900', '#882300', '#821E00', '#7B1A00', '#771900', '#701400', '#6A0E00',
  '#660D00', '#5E0B00', '#5A0A02', '#600903', '#520907', '#4C0505', '#470606', '#440607', '#3F0708', '#3B0607',
  '#3A070B', '#36080A'];
export const srmToHex = srm => SRM_HEX[Math.max(0, Math.min(40, Math.round(num(srm))))];

// ---- core formulas ----------------------------------------------------
export const abv = (og, fg) => (og - fg) * 131.25;

// Tinseth utilisation for `minutes` of boiling at wort gravity `sg`.
export const tinseth = (minutes, sg) =>
  1.65 * Math.pow(0.000125, sg - 1) * (1 - Math.exp(-0.04 * minutes)) / 4.15;

// Isomerisation rate below boiling, relative to 100 °C (Malowicki & Shellhammer).
export const isoRate = tempC => Math.exp(-9773 / (tempC + 273.15)) / Math.exp(-9773 / 373.15);

export function hopIbu(hop, { boilTime, boilSG, postBoilVol }) {
  const grams = num(hop.amount), alpha = num(hop.alpha);
  if (!grams || !alpha || !postBoilVol) return 0;
  let minutes = 0, factor = 1;
  switch (hop.use || 'boil') {
    case 'boil': minutes = num(hop.time); break;
    case 'first wort': minutes = boilTime; factor = 1.1; break;
    case 'whirlpool': minutes = num(hop.time) * isoRate(num(hop.temp, 80)); break;
    case 'mash': minutes = boilTime; factor = 0.2; break;
    default: return 0; // dry hop
  }
  if ((hop.form || 'pellet') === 'pellet') factor *= 1.1;
  const mgPerL = (alpha / 100) * grams * 1000 / postBoilVol;
  return tinseth(minutes, boilSG) * mgPerL * factor;
}

// Everything the recipe editor shows, from one recipe and one equipment profile.
export function recipeStats(r, equip = {}) {
  const eq = { ...DEFAULT_EQUIP, ...equip };
  const batch = num(r.batchSize, eq.batchSize);
  const boilTime = num(r.boilTime, eq.boilTime);
  const eff = num(r.efficiency, eq.efficiency) / 100;
  const gal = batch / L_PER_GAL;
  const ferms = r.fermentables || [];

  let mashPts = 0, sugarPts = 0, mcu = 0, grainKg = 0, totalKg = 0;
  for (const f of ferms) {
    const kg = num(f.amount), lb = kg * LB_PER_KG;
    const ppg = (num(f.potential, 1.037) - 1) * 1000;
    if (isMashed(f)) { mashPts += lb * ppg; grainKg += kg; } else sugarPts += lb * ppg;
    mcu += lb * srmToLovibond(ebcToSrm(num(f.color)));
    totalKg += kg;
  }
  const points = gal > 0 ? (mashPts * eff + sugarPts) / gal : 0;
  const og = 1 + points / 1000;

  const yeasts = (r.yeasts || []).filter(y => num(y.attenuation) > 0);
  const attenuation = yeasts.length ? yeasts.reduce((a, y) => a + num(y.attenuation), 0) / yeasts.length : 75;
  const fg = 1 + (points * (1 - attenuation / 100)) / 1000;

  const srm = gal > 0 && mcu > 0 ? 1.4922 * Math.pow(mcu / gal, 0.6859) : 0;

  const postBoilVol = batch + num(eq.kettleLoss);
  const preBoilVol = postBoilVol + num(eq.boilOff) * boilTime / 60;
  const preBoilSG = 1 + (points * postBoilVol / preBoilVol) / 1000;
  const boilSG = (preBoilSG + og) / 2;

  const hopIbus = (r.hops || []).map(h => hopIbu(h, { boilTime, boilSG, postBoilVol }));
  const ibu = hopIbus.reduce((a, b) => a + b, 0);

  const ratio = num(r.mashRatio, eq.mashRatio);
  const mashWater = grainKg * ratio;
  const spargeWater = grainKg > 0 ? Math.max(0, preBoilVol + num(eq.mashLoss) - (mashWater - grainKg * num(eq.absorption))) : 0;
  const mashTemp = num(r.mash?.[0]?.temp, 66);
  const strikeTemp = ratio > 0 ? (0.41 / ratio) * (mashTemp - num(eq.grainTemp)) + mashTemp : mashTemp;

  return {
    og, fg, abv: abv(og, fg), ibu, srm, ebc: srmToEbc(srm), buGu: points > 0 ? ibu / points : 0,
    attenuation, grainKg, totalKg, mashPts, sugarPts,
    fermPct: ferms.map(f => (totalKg > 0 ? num(f.amount) / totalKg * 100 : 0)),
    hopIbus, postBoilVol, preBoilVol, preBoilSG,
    mashWater, spargeWater, totalWater: grainKg > 0 ? mashWater + spargeWater : preBoilVol, strikeTemp,
  };
}

// Brewhouse efficiency actually achieved, from a measured OG and volume into the fermenter.
export function measuredEfficiency(r, og, volumeL, equip = {}) {
  const s = recipeStats(r, equip);
  if (!s.mashPts || !og || !volumeL) return null;
  const pts = (og - 1) * 1000 * (volumeL / L_PER_GAL);
  return (pts - s.sugarPts) / s.mashPts * 100;
}

// ---- standalone tools -------------------------------------------------
const hydroPoly = f => 1.00130346 - 0.000134722124 * f + 0.00000204052596 * f * f - 0.00000000232820948 * f ** 3;
export const hydrometerCorrect = (sg, tempC, calC = 20) => sg * hydroPoly(cToF(tempC)) / hydroPoly(cToF(calC));

// Refractometer with alcohol present (Terrill cubic). Brix readings are divided by the wort correction factor.
export function refractometerFG(originalBrix, currentBrix, wcf = 1.04) {
  const i = originalBrix / wcf, f = currentBrix / wcf;
  return 1 - 0.0044993 * i + 0.011774 * f + 0.00027581 * i * i - 0.0012717 * f * f - 0.00000728 * i ** 3 + 0.000063293 * f ** 3;
}

// CO2 already dissolved in beer that finished fermenting at tempC, in volumes.
export const residualCO2 = tempC => {
  const f = cToF(tempC);
  return 3.0378 - 0.050062 * f + 0.00026555 * f * f;
};

// Grams of priming sugar for `litres` of beer.
export function primingSugar(litres, tempC, targetVols) {
  const need = Math.max(0, targetVols - residualCO2(tempC));
  const dextrose = need * litres * 4.01;
  return { residual: residualCO2(tempC), dextrose, sucrose: dextrose * 0.91, dme: dextrose * 1.47 };
}

// Volume you end up with when moving wort from one gravity to another by adding water or boiling.
export const volumeAtGravity = (volume, sg, targetSg) => (targetSg > 1 ? volume * (sg - 1) / (targetSg - 1) : volume);

export const strikeTemp = (ratio, grainTemp, mashTemp) => (0.41 / ratio) * (mashTemp - grainTemp) + mashTemp;

// Billions of cells for a pitch rate in million cells / ml / °P.
export const pitchCells = (litres, og, rate = 0.75) => rate * litres * sgToPlato(og);

// ---- water chemistry ---------------------------------------------------
export const IONS = ['ca', 'mg', 'na', 'cl', 'so4', 'hco3'];

// ppm of each ion added by 1 gram of salt in 1 litre of water.
export const SALTS = {
  gypsum: { name: 'Gypsum', formula: 'CaSO₄', ca: 232.8, so4: 557.7 },
  cacl2: { name: 'Calcium chloride', formula: 'CaCl₂', ca: 272.6, cl: 482.3 },
  epsom: { name: 'Epsom salt', formula: 'MgSO₄', mg: 98.6, so4: 389.6 },
  salt: { name: 'Table salt', formula: 'NaCl', na: 393.4, cl: 606.6 },
  soda: { name: 'Baking soda', formula: 'NaHCO₃', na: 273.7, hco3: 726.3 },
};

// Ion profile (ppm) after dissolving `salts` (grams of each) in `litres` of `source` water.
export function waterWithSalts(source = {}, salts = {}, litres = 0) {
  const out = Object.fromEntries(IONS.map(i => [i, num(source[i])]));
  if (litres > 0) {
    for (const [k, def] of Object.entries(SALTS)) {
      const gPerL = num(salts[k]) / litres;
      for (const i of IONS) out[i] += gPerL * (def[i] || 0);
    }
  }
  return out;
}

// Grams of each salt that bring `source` closest to `target` in `litres` of water.
// Non-negative least squares by coordinate descent: salts can only add ions, never remove them.
export function suggestSalts(source = {}, target = {}, litres = 0) {
  const weight = { ca: 1, mg: 1, na: 3, cl: 1, so4: 1, hco3: 0.2 }; // sodium is the easy one to overdo; bicarbonate matters least
  const keys = Object.keys(SALTS);
  const x = Object.fromEntries(keys.map(k => [k, 0])); // grams per litre
  const residual = i => num(target[i]) - num(source[i]) - keys.reduce((a, k) => a + x[k] * (SALTS[k][i] || 0), 0);
  for (let pass = 0; pass < 400; pass++) {
    for (const k of keys) {
      let top = 0, bottom = 0;
      for (const i of IONS) {
        const a = SALTS[k][i] || 0;
        if (!a) continue;
        top += weight[i] * a * (residual(i) + a * x[k]);
        bottom += weight[i] * a * a;
      }
      x[k] = Math.max(0, top / bottom);
    }
  }
  return Object.fromEntries(keys.map(k => [k, +(x[k] * litres).toFixed(1)]));
}

// ---- mash pH -------------------------------------------------------------
// milliequivalents of acid per millilitre at mash pH
export const ACIDS = {
  lactic80: { name: 'Lactic acid 80%', meq: 10.6 },
  lactic88: { name: 'Lactic acid 88%', meq: 11.8 },
  phos10: { name: 'Phosphoric acid 10%', meq: 1.07 },
  phos75: { name: 'Phosphoric acid 75%', meq: 12.1 },
  phos85: { name: 'Phosphoric acid 85%', meq: 14.6 },
};
const MASH_BUFFER = 45;       // mEq of acid to move 1 kg of grist by 1 pH unit
const ACID_MALT_MEQ = 333;    // mEq per kg of acidulated malt (about 3% lactic acid by weight)
export const isAcidMalt = f => /acid|sauer/i.test(f.name || '');

// Residual alkalinity (Kolbach), mEq per litre: what is left of the bicarbonate after calcium and magnesium react.
export const residualAlkalinity = w => num(w.hco3) / 61.02 - num(w.ca) / 20.04 / 3.5 - num(w.mg) / 12.15 / 7;

// Estimated mash pH. A charge balance: each malt would settle at its own pH in distilled water;
// alkalinity in the water pulls the mash up, acid pulls it down, and the grist resists with a fixed buffer.
// `diPhOf(fermentable)` gives a malt's distilled-water pH. Expect about ±0.1; check with a meter.
export function mashPh(r, water, mashWaterL, diPhOf) {
  const grains = (r.fermentables || []).filter(f => isMashed(f) && num(f.amount) > 0);
  const grist = grains.reduce((a, f) => a + num(f.amount), 0);
  const plain = grains.filter(f => !isAcidMalt(f));
  const plainKg = plain.reduce((a, f) => a + num(f.amount), 0);
  if (!grist || !plainKg || !mashWaterL) return null;
  const diPh = plain.reduce((a, f) => a + num(f.amount) * diPhOf(f), 0) / plainKg;
  const waterMeq = residualAlkalinity(water) * mashWaterL;
  const maltMeq = grains.filter(isAcidMalt).reduce((a, f) => a + num(f.amount), 0) * ACID_MALT_MEQ;
  const acid = ACIDS[r.water?.acid?.type] || ACIDS.lactic88;
  const acidMeq = num(r.water?.acid?.ml) * acid.meq;
  const ph = diPh + (waterMeq - maltMeq - acidMeq) / (MASH_BUFFER * grist);
  // Millilitres of the chosen acid that would bring the mash to `target` (0 if it is already there or below).
  const mlFor = target => Math.max(0, ((diPh - target) * MASH_BUFFER * grist + waterMeq - maltMeq) / acid.meq);
  return { ph, diPh, phNoAcid: ph + acidMeq / (MASH_BUFFER * grist), mlFor, acid };
}
