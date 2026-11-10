import { ebcToSrm, srmToLovibond } from './calc.js';

// Built-in reference data. These are typical values to start from: edit freely,
// and check a maltster's or hop supplier's sheet when the exact number matters.

// BJCP 2021 vital statistics. [min, max] for each; colour in SRM.
const S = (code, name, og, fg, ibu, srm, abv) => ({ code, name, og, fg, ibu, srm, abv });
export const STYLES = [
  S('1A', 'American Light Lager', [1.028, 1.040], [0.998, 1.008], [8, 12], [2, 3], [2.8, 4.2]),
  S('1B', 'American Lager', [1.040, 1.050], [1.004, 1.010], [8, 18], [2, 3.5], [4.2, 5.3]),
  S('2A', 'International Pale Lager', [1.042, 1.050], [1.008, 1.012], [18, 25], [2, 6], [4.5, 6.0]),
  S('3B', 'Czech Premium Pale Lager', [1.044, 1.060], [1.013, 1.017], [30, 45], [3.5, 6], [4.2, 5.8]),
  S('4A', 'Munich Helles', [1.044, 1.048], [1.006, 1.012], [16, 22], [3, 5], [4.7, 5.4]),
  S('5B', 'Kölsch', [1.044, 1.050], [1.007, 1.011], [18, 30], [3.5, 5], [4.4, 5.2]),
  S('5D', 'German Pils', [1.044, 1.050], [1.008, 1.013], [22, 40], [2, 4], [4.4, 5.2]),
  S('6A', 'Märzen', [1.054, 1.060], [1.010, 1.014], [18, 24], [8, 17], [5.6, 6.3]),
  S('7A', 'Vienna Lager', [1.048, 1.055], [1.010, 1.014], [18, 30], [9, 15], [4.7, 5.5]),
  S('8A', 'Munich Dunkel', [1.048, 1.056], [1.010, 1.016], [18, 28], [17, 28], [4.5, 5.6]),
  S('9A', 'Doppelbock', [1.072, 1.112], [1.016, 1.024], [16, 26], [6, 25], [7.0, 10.0]),
  S('10A', 'Weissbier', [1.044, 1.053], [1.008, 1.014], [8, 15], [2, 6], [4.3, 5.6]),
  S('11A', 'Ordinary Bitter', [1.030, 1.039], [1.007, 1.011], [25, 35], [8, 14], [3.2, 3.8]),
  S('11B', 'Best Bitter', [1.040, 1.048], [1.008, 1.012], [25, 40], [8, 16], [3.8, 4.6]),
  S('11C', 'Strong Bitter', [1.048, 1.060], [1.010, 1.016], [30, 50], [8, 18], [4.6, 6.2]),
  S('12A', 'British Golden Ale', [1.038, 1.053], [1.006, 1.012], [20, 45], [2, 5], [3.8, 5.0]),
  S('12C', 'English IPA', [1.050, 1.070], [1.010, 1.015], [40, 60], [6, 14], [5.0, 7.5]),
  S('13A', 'Dark Mild', [1.030, 1.038], [1.008, 1.013], [10, 25], [14, 25], [3.0, 3.8]),
  S('13B', 'British Brown Ale', [1.040, 1.052], [1.008, 1.013], [20, 30], [12, 22], [4.2, 5.9]),
  S('13C', 'English Porter', [1.040, 1.052], [1.008, 1.014], [18, 35], [20, 30], [4.0, 5.4]),
  S('14C', 'Scottish Export', [1.040, 1.060], [1.010, 1.016], [15, 30], [12, 20], [3.9, 6.0]),
  S('15A', 'Irish Red Ale', [1.036, 1.046], [1.010, 1.014], [18, 28], [9, 14], [3.8, 5.0]),
  S('15B', 'Irish Stout', [1.036, 1.044], [1.007, 1.011], [25, 45], [25, 40], [3.8, 5.0]),
  S('16A', 'Sweet Stout', [1.044, 1.060], [1.012, 1.024], [20, 40], [30, 40], [4.0, 6.0]),
  S('16B', 'Oatmeal Stout', [1.045, 1.065], [1.010, 1.018], [25, 40], [22, 40], [4.2, 5.9]),
  S('17D', 'English Barley Wine', [1.080, 1.120], [1.018, 1.030], [35, 70], [8, 22], [8.0, 12.0]),
  S('18A', 'Blonde Ale', [1.038, 1.054], [1.008, 1.013], [15, 28], [3, 6], [3.8, 5.5]),
  S('18B', 'American Pale Ale', [1.045, 1.060], [1.010, 1.015], [30, 50], [5, 10], [4.5, 6.2]),
  S('19A', 'American Amber Ale', [1.045, 1.060], [1.010, 1.015], [25, 40], [10, 17], [4.5, 6.2]),
  S('19C', 'American Brown Ale', [1.045, 1.060], [1.010, 1.016], [20, 30], [18, 35], [4.3, 6.2]),
  S('20A', 'American Porter', [1.050, 1.070], [1.012, 1.018], [25, 50], [22, 40], [4.8, 6.5]),
  S('20B', 'American Stout', [1.050, 1.075], [1.010, 1.022], [35, 75], [30, 40], [5.0, 7.0]),
  S('20C', 'Imperial Stout', [1.075, 1.115], [1.018, 1.030], [50, 90], [30, 40], [8.0, 12.0]),
  S('21A', 'American IPA', [1.056, 1.070], [1.008, 1.014], [40, 70], [6, 14], [5.5, 7.5]),
  S('21C', 'Hazy IPA', [1.060, 1.085], [1.010, 1.015], [25, 60], [3, 7], [6.0, 9.0]),
  S('22A', 'Double IPA', [1.065, 1.085], [1.008, 1.018], [60, 100], [6, 14], [7.5, 10.0]),
  S('22C', 'American Barleywine', [1.080, 1.120], [1.016, 1.030], [50, 100], [9, 18], [8.0, 12.0]),
  S('24A', 'Witbier', [1.044, 1.052], [1.008, 1.012], [8, 20], [2, 4], [4.5, 5.5]),
  S('25B', 'Saison', [1.048, 1.065], [1.002, 1.008], [20, 35], [5, 14], [5.0, 7.0]),
  S('25C', 'Belgian Golden Strong Ale', [1.070, 1.095], [1.005, 1.016], [22, 35], [3, 6], [7.5, 10.5]),
  S('26A', 'Belgian Single', [1.044, 1.054], [1.004, 1.010], [25, 45], [3, 5], [4.8, 6.0]),
  S('26B', 'Belgian Dubbel', [1.062, 1.075], [1.008, 1.018], [15, 25], [10, 17], [6.0, 7.6]),
  S('26C', 'Belgian Tripel', [1.075, 1.085], [1.008, 1.014], [20, 40], [4.5, 7], [7.5, 9.5]),
  S('26D', 'Belgian Dark Strong Ale', [1.075, 1.110], [1.010, 1.024], [20, 35], [12, 22], [8.0, 12.0]),
];

export const findStyle = name => {
  const k = (name || '').trim().toLowerCase();
  return k ? STYLES.find(s => s.name.toLowerCase() === k) : undefined;
};

// name, type, potential (SG of 1 lb in 1 US gal), colour in EBC, and a family used to suggest substitutes
const F = (name, type, potential, color, group) => ({ name, type, potential, color, group });
export const FERMENTABLES = [
  F('Pilsner Malt', 'grain', 1.037, 3.5, 'base'), F('Pale Ale Malt', 'grain', 1.037, 6, 'base'),
  F('Maris Otter', 'grain', 1.038, 6, 'base'), F('Golden Promise', 'grain', 1.037, 5, 'base'),
  F('Vienna Malt', 'grain', 1.036, 8, 'kilned'), F('Munich Malt I', 'grain', 1.037, 15, 'kilned'),
  F('Munich Malt II', 'grain', 1.037, 23, 'kilned'), F('Melanoidin Malt', 'grain', 1.037, 70, 'kilned'),
  F('Biscuit Malt', 'grain', 1.036, 50, 'toasted'), F('Amber Malt', 'grain', 1.034, 60, 'toasted'),
  F('Brown Malt', 'grain', 1.032, 150, 'toasted'),
  F('Wheat Malt', 'grain', 1.038, 4, 'wheat and rye'), F('Rye Malt', 'grain', 1.035, 6, 'wheat and rye'),
  F('Smoked Malt', 'grain', 1.037, 6, 'smoked'), F('Acidulated Malt', 'grain', 1.027, 4, 'acid'),
  F('Flaked Oats', 'grain', 1.033, 2, 'flaked'), F('Flaked Barley', 'grain', 1.032, 3, 'flaked'),
  F('Flaked Wheat', 'grain', 1.035, 3, 'flaked'), F('Flaked Maize', 'grain', 1.037, 2, 'flaked'),
  F('Carapils', 'grain', 1.033, 4, 'crystal'), F('Crystal Light', 'grain', 1.034, 80, 'crystal'),
  F('CaraMunich II', 'grain', 1.034, 120, 'crystal'), F('Crystal Medium', 'grain', 1.034, 150, 'crystal'),
  F('Crystal Dark', 'grain', 1.033, 240, 'crystal'), F('Special B', 'grain', 1.030, 300, 'crystal'),
  F('Pale Chocolate Malt', 'grain', 1.033, 500, 'roast'), F('Chocolate Malt', 'grain', 1.030, 900, 'roast'),
  F('Carafa Special II', 'grain', 1.032, 1150, 'roast'), F('Roasted Barley', 'grain', 1.025, 1200, 'roast'),
  F('Black Malt', 'grain', 1.025, 1300, 'roast'),
  F('Light Dry Malt Extract', 'dry extract', 1.044, 16, 'extract'), F('Wheat Dry Malt Extract', 'dry extract', 1.044, 16, 'extract'),
  F('Light Liquid Malt Extract', 'extract', 1.036, 10, 'extract'),
  F('Table Sugar', 'sugar', 1.046, 0, 'sugar'), F('Dextrose', 'sugar', 1.042, 0, 'sugar'),
  F('Dark Candi Sugar', 'sugar', 1.036, 180, 'sugar'), F('Honey', 'honey', 1.035, 2, 'sugar'),
];

// Fermentables that could stand in for `f`: same family first, closest in colour first.
// For something not in the list, the family is guessed from its type and colour.
export function similarFermentables(f, count = 4) {
  const key = (f.name || '').trim().toLowerCase();
  const known = FERMENTABLES.find(x => x.name.toLowerCase() === key);
  const mashed = (f.type || 'grain') === 'grain';
  const colour = x => Math.log((+x.color || 0) + 4);
  const others = FERMENTABLES.filter(x => x.name.toLowerCase() !== key && (x.type === 'grain') === mashed);
  const nearest = others.slice().sort((a, b) => Math.abs(colour(a) - colour(f)) - Math.abs(colour(b) - colour(f)));
  const group = known?.group ?? nearest[0]?.group;
  const score = x => (x.group === group ? 0 : 3) + Math.abs(colour(x) - colour(f)) + Math.abs(x.potential - (+f.potential || 1.037)) * 20;
  // Smoked and acid malts change the beer too much to offer as a stand-in for anything else.
  const ranked = others.filter(x => x.group === group || !['smoked', 'acid'].includes(x.group)).sort((a, b) => score(a) - score(b));
  // Offer the whole family; reach outside it only when the family is too small to give three options.
  const family = ranked.filter(x => x.group === group).length;
  return ranked.slice(0, Math.min(count, Math.max(3, family)));
}

// Aroma axes for the hop spider charts. Each hop is scored 0 to 5 on every axis, in this order.
export const AROMA_AXES = ['Citrus', 'Tropical', 'Stone fruit', 'Berry', 'Floral', 'Herbal, spicy', 'Pine, resin', 'Earthy, woody'];

// name, typical alpha acid %, a character family used to suggest substitutes, and aroma scores.
// The scores are a rough reading of how each hop is usually described, not lab data.
const H = (name, alpha, group, aroma) => ({ name, alpha, group, aroma });
export const HOPS = [
  H('Admiral', 14.5, 'bittering', [2, 0, 0, 0, 1, 3, 3, 3]),
  H('Amarillo', 9, 'citrus and pine', [5, 2, 3, 0, 3, 1, 1, 0]),
  H('Azacca', 14, 'tropical', [4, 5, 3, 0, 1, 1, 2, 0]),
  H('Bramling Cross', 6, 'english', [2, 0, 1, 5, 1, 3, 0, 2]),
  H('Cascade', 6.5, 'citrus and pine', [5, 1, 1, 0, 3, 2, 2, 0]),
  H('Centennial', 10, 'citrus and pine', [5, 1, 1, 0, 4, 1, 3, 0]),
  H('Challenger', 7.5, 'english', [2, 0, 0, 1, 2, 4, 1, 3]),
  H('Chinook', 13, 'citrus and pine', [4, 1, 0, 0, 1, 3, 5, 1]),
  H('Citra', 12.5, 'tropical', [5, 5, 3, 1, 1, 0, 2, 0]),
  H('Columbus', 15, 'citrus and pine', [3, 0, 0, 0, 1, 4, 5, 3]),
  H('East Kent Goldings', 5, 'english', [2, 0, 1, 0, 4, 3, 0, 3]),
  H('El Dorado', 15, 'tropical', [3, 5, 5, 1, 1, 0, 1, 0]),
  H('Ella', 15, 'tropical', [2, 3, 2, 0, 4, 3, 1, 0]),
  H('First Gold', 7.5, 'english', [4, 0, 2, 0, 3, 3, 0, 2]),
  H('Fuggle', 4.5, 'english', [0, 0, 0, 0, 2, 4, 1, 5]),
  H('Galaxy', 14, 'tropical', [4, 5, 5, 0, 1, 0, 2, 0]),
  H('Hallertau Mittelfrüh', 4, 'noble', [1, 0, 0, 0, 4, 4, 0, 2]),
  H('Hersbrucker', 3, 'noble', [1, 0, 1, 0, 4, 4, 0, 2]),
  H('Idaho 7', 13, 'tropical', [4, 4, 4, 0, 1, 1, 4, 0]),
  H('Magnum', 13, 'bittering', [1, 0, 0, 0, 1, 3, 2, 1]),
  H('Mosaic', 12, 'tropical', [3, 5, 3, 5, 1, 1, 2, 1]),
  H('Motueka', 7, 'new zealand', [5, 4, 1, 0, 2, 2, 0, 0]),
  H('Nectaron', 11, 'new zealand', [4, 5, 5, 0, 1, 0, 1, 0]),
  H('Nelson Sauvin', 12, 'new zealand', [3, 4, 3, 3, 1, 1, 1, 0]),
  H('Northern Brewer', 9, 'noble', [0, 0, 0, 0, 1, 4, 4, 4]),
  H('Nugget', 13, 'bittering', [1, 0, 0, 0, 1, 4, 4, 2]),
  H('Pacific Jade', 13, 'new zealand', [3, 1, 0, 0, 1, 5, 1, 1]),
  H('Perle', 8, 'noble', [1, 0, 0, 0, 3, 5, 1, 1]),
  H('Riwaka', 5.5, 'new zealand', [5, 5, 1, 0, 1, 1, 2, 0]),
  H('Saaz', 3.5, 'noble', [0, 0, 0, 0, 3, 5, 0, 3]),
  H('Sabro', 15, 'tropical', [4, 5, 3, 0, 1, 2, 0, 2]),
  H('Simcoe', 13, 'citrus and pine', [4, 3, 2, 2, 0, 1, 5, 2]),
  H('Sorachi Ace', 12, 'lemon and dill', [5, 1, 0, 0, 1, 5, 0, 1]),
  H('Strata', 12, 'tropical', [3, 5, 2, 3, 0, 2, 4, 0]),
  H('Styrian Goldings', 5, 'english', [1, 0, 0, 0, 3, 4, 1, 3]),
  H('Target', 11, 'bittering', [2, 0, 0, 0, 1, 4, 3, 3]),
  H('Tettnang', 4.5, 'noble', [1, 0, 0, 0, 4, 5, 0, 2]),
  H('Vic Secret', 15.5, 'tropical', [2, 5, 3, 0, 1, 2, 4, 0]),
  H('Warrior', 16, 'bittering', [2, 0, 0, 0, 1, 2, 3, 0]),
  H('Willamette', 5, 'english', [1, 0, 1, 1, 4, 3, 0, 4]),
];

// Hops that could stand in for `h`: same character family first, closest alpha first.
// For a long boil addition the character matters little, so clean bittering hops rank well too.
export function similarHops(h, count = 4) {
  const key = (h.name || '').trim().toLowerCase();
  const known = HOPS.find(x => x.name.toLowerCase() === key);
  const alpha = +h.alpha || known?.alpha || 6;
  const others = HOPS.filter(x => x.name.toLowerCase() !== key);
  const group = known?.group ?? others.slice().sort((a, b) => Math.abs(a.alpha - alpha) - Math.abs(b.alpha - alpha))[0]?.group;
  const bittering = h.use === 'first wort' || ((h.use || 'boil') === 'boil' && +h.time >= 30);
  const score = x => (x.group === group ? 0 : bittering && x.group === 'bittering' ? 0.6 : 3) + Math.abs(x.alpha - alpha) / 6;
  const ranked = others.sort((a, b) => score(a) - score(b));
  const close = ranked.filter(x => score(x) < 3).length;
  return ranked.slice(0, Math.min(count, Math.max(3, close)));
}

const Y = (name, lab, attenuation, form = 'dry') => ({ name, lab, attenuation, form });
export const YEASTS = [
  Y('SafAle US-05', 'Fermentis', 81), Y('SafAle S-04', 'Fermentis', 75), Y('SafAle K-97', 'Fermentis', 81),
  Y('SafAle WB-06', 'Fermentis', 86), Y('SafAle T-58', 'Fermentis', 76), Y('SafAle BE-134', 'Fermentis', 90),
  Y('SafLager W-34/70', 'Fermentis', 83), Y('SafLager S-23', 'Fermentis', 82),
  Y('LalBrew Nottingham', 'Lallemand', 78), Y('LalBrew Verdant IPA', 'Lallemand', 78),
  Y('LalBrew BRY-97', 'Lallemand', 80), Y('LalBrew Belle Saison', 'Lallemand', 90),
  Y('LalBrew Voss Kveik', 'Lallemand', 78), Y('LalBrew Diamond Lager', 'Lallemand', 80),
  Y('M44 US West Coast', 'Mangrove Jack', 79), Y('M36 Liberty Bell', 'Mangrove Jack', 76),
  Y('1056 American Ale', 'Wyeast', 75, 'liquid'), Y('1318 London Ale III', 'Wyeast', 73, 'liquid'),
  Y('1968 London ESB', 'Wyeast', 69, 'liquid'), Y('3068 Weihenstephan Weizen', 'Wyeast', 75, 'liquid'),
  Y('3787 Trappist High Gravity', 'Wyeast', 76, 'liquid'), Y('WLP001 California Ale', 'White Labs', 77, 'liquid'),
  Y('WLP002 English Ale', 'White Labs', 67, 'liquid'), Y('WLP530 Abbey Ale', 'White Labs', 78, 'liquid'),
  Y('WLP830 German Lager', 'White Labs', 77, 'liquid'),
];

export const byName = (list, name) => {
  const k = (name || '').trim().toLowerCase();
  return k ? list.find(x => x.name.toLowerCase() === k) : undefined;
};

// Target water profiles, ppm. Typical published figures: treat them as starting points.
const W = (id, name, ca, mg, na, cl, so4, hco3) => ({ id, name, ca, mg, na, cl, so4, hco3 });
export const WATER_TARGETS = [
  W('balanced', 'Balanced', 80, 5, 25, 75, 80, 100),
  W('hoppy', 'Hoppy and crisp', 110, 10, 15, 50, 200, 40),
  W('malty', 'Malty and full', 60, 5, 15, 95, 55, 40),
  W('hazy', 'Hazy and juicy', 110, 10, 15, 175, 75, 30),
  W('pilsen', 'Pilsen (very soft)', 7, 3, 2, 5, 5, 25),
  W('burton', 'Burton on Trent', 275, 40, 25, 35, 610, 270),
  W('london', 'London', 70, 6, 15, 38, 40, 166),
  W('dublin', 'Dublin', 120, 4, 12, 19, 55, 315),
  W('munich', 'Munich', 77, 17, 4, 8, 18, 295),
];
export const RO_WATER = W('ro', 'RO or distilled', 0, 0, 0, 0, 0, 0);

// The pH a malt settles at when mashed in distilled water. Base malts sit near 5.7, crystal malts
// fall with colour, roasted malts sit near 4.7. Used by the mash pH estimate.
export function grainDiPh(f) {
  const known = FERMENTABLES.find(x => x.name.toLowerCase() === (f.name || '').trim().toLowerCase());
  const lovibond = srmToLovibond(ebcToSrm(+f.color || 0));
  const group = known?.group ?? (lovibond > 200 ? 'roast' : lovibond > 12 ? 'crystal' : 'kilned');
  switch (group) {
    case 'base': case 'smoked': return /pils/i.test(f.name) ? 5.75 : 5.72;
    case 'flaked': return 5.72;
    case 'wheat and rye': return /wheat/i.test(f.name) ? 6.0 : 5.9;
    case 'roast': return 4.71;
    case 'crystal': case 'toasted': return Math.max(4.5, 5.22 - 0.00504 * lovibond);
    default: return Math.max(5.2, 5.72 - 0.04 * Math.max(0, lovibond - 2)); // kilned: Vienna, Munich and unknown pale malts
  }
}
