// Demo data for the Android and iOS apps: four recipes and four brew logs, so a person can look
// around before they make an account. Dates count back from today, so the demo always looks
// recent. Nothing here goes into an account: store.adopt() removes the demo at sign-in.
//
// demoData() gives { recipes: { id: recipe }, brews: { id: brew } } in the app's own model.
// A brew here has no recipe snapshot, equipment or checklist yet: loadDemo() in app.js adds
// those. `stepsDone` says how much of the brew-day checklist is ticked (1 = all of it).

const DAY = 864e5;
const iso = d => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString(); // local time, written as ISO
const pellet = (name, alpha, amount, use, time, temp) => ({ name, form: 'pellet', alpha, amount, use, time, ...(temp ? { temp } : {}) });
const grain = (name, amount, potential, color) => ({ name, type: 'grain', amount, potential, color });
const dry = (name, lab, attenuation) => ({ name, lab, form: 'dry', attenuation, amount: 1 });

export function demoData(now = new Date()) {
  const day = n => iso(new Date(now.getTime() - n * DAY)).slice(0, 10);      // the date n days ago
  const at = (n, time) => `${day(n)}T${time}`;                                // a time on that day
  const base = { author: '', type: 'all grain', batchSize: 21, boilTime: 60, efficiency: 72, mashRatio: 3 };

  const recipes = {
    'house-pale-ale': {
      ...base, name: 'House Pale Ale', style: 'American Pale Ale', status: 'ready', carbonation: 2.4, created: day(120), modified: day(8),
      fermentables: [grain('Maris Otter', 4.2, 1.038, 6), grain('Crystal Light', 0.3, 1.034, 80), grain('Wheat Malt', 0.2, 1.038, 4)],
      hops: [pellet('Magnum', 13, 18, 'boil', 60), pellet('Cascade', 6.5, 25, 'boil', 10), pellet('Cascade', 6.5, 30, 'whirlpool', 20, 80), pellet('Citra', 12.5, 40, 'dry hop', 4)],
      yeasts: [dry('SafAle US-05', 'Fermentis', 81)],
      miscs: [{ name: 'Irish moss', type: 'fining', amount: 5, unit: 'g', use: 'boil', time: 10 }],
      mash: [{ name: 'Saccharification', temp: 66, time: 60 }],
      fermentation: [{ name: 'Primary', temp: 19, days: 14 }],
      notes: 'The house beer. Dry hop when the gravity is close to final.',
    },
    'demo-best-bitter': {
      ...base, name: 'Copper Kettle Best Bitter', style: 'Best Bitter', status: 'ready', carbonation: 1.9, created: day(75), modified: day(50),
      fermentables: [grain('Maris Otter', 3.55, 1.038, 6), grain('Crystal Medium', 0.35, 1.034, 150), grain('Wheat Malt', 0.15, 1.038, 4)],
      hops: [pellet('Challenger', 7.5, 24, 'boil', 60), pellet('East Kent Goldings', 5, 20, 'boil', 15), pellet('East Kent Goldings', 5, 25, 'whirlpool', 15, 80)],
      yeasts: [dry('SafAle S-04', 'Fermentis', 75)],
      miscs: [{ name: 'Irish moss', type: 'fining', amount: 5, unit: 'g', use: 'boil', time: 10 }],
      mash: [{ name: 'Saccharification', temp: 66, time: 60 }],
      fermentation: [{ name: 'Primary', temp: 19, days: 10 }],
      notes: 'A pub bitter. Low carbonation suits it.',
    },
    'demo-oatmeal-stout': {
      ...base, name: 'Night Shift Oatmeal Stout', style: 'Oatmeal Stout', status: 'planning', carbonation: 2.1, created: day(20), modified: day(3),
      fermentables: [grain('Maris Otter', 4, 1.038, 6), grain('Flaked Oats', 0.5, 1.033, 2), grain('Crystal Dark', 0.25, 1.033, 240), grain('Chocolate Malt', 0.25, 1.03, 900), grain('Roasted Barley', 0.2, 1.025, 1200)],
      hops: [pellet('Challenger', 7.5, 30, 'boil', 60), pellet('Fuggle', 4.5, 20, 'boil', 15)],
      yeasts: [dry('LalBrew Nottingham', 'Lallemand', 78)],
      miscs: [],
      mash: [{ name: 'Saccharification', temp: 67, time: 60 }],
      fermentation: [{ name: 'Primary', temp: 18, days: 14 }],
      notes: 'For the winter. Not brewed yet.',
    },
    'demo-kolsch': {
      ...base, name: 'Garden Party Kölsch', style: 'Kölsch', status: 'planning', carbonation: 2.6, created: day(12), modified: day(12),
      fermentables: [grain('Pilsner Malt', 3.9, 1.037, 3.5), grain('Munich Malt I', 0.4, 1.037, 15), grain('Wheat Malt', 0.2, 1.038, 4)],
      hops: [pellet('Hallertau Mittelfrüh', 4, 35, 'boil', 60), pellet('Tettnang', 4.5, 20, 'boil', 10)],
      yeasts: [dry('SafAle K-97', 'Fermentis', 81)],
      miscs: [],
      mash: [{ name: 'Saccharification', temp: 65, time: 60 }, { name: 'Mash out', temp: 75, time: 10 }],
      fermentation: [{ name: 'Primary', temp: 16, days: 14 }, { name: 'Cold conditioning', temp: 4, days: 21 }],
      notes: 'Two mash steps, so the brew-day timer has two mash segments.',
    },
  };

  const brew = (name, recipeId, status, ago, more) => ({
    name, recipeId, status, brewDate: day(ago), packagedDate: '', stepsDone: 1,
    measured: { preBoilVol: null, preBoilSG: null, og: null, fermenterVol: null, fg: null },
    readings: [], timeline: [], notes: '', tasting: '', rating: null, ...more,
  });
  const brews = {
    [`${day(96)}-house-pale-ale-demo1`]: brew('House Pale Ale #1', 'house-pale-ale', 'finished', 96, {
      packagedDate: day(80), rating: 4,
      measured: { preBoilVol: 26.5, preBoilSG: 1.042, og: 1.05, fermenterVol: 21, fg: 1.01 },
      readings: [
        { date: day(96), sg: 1.05, temp: 19, note: 'Pitched' },
        { date: day(93), sg: 1.024, temp: 19.5, note: '' },
        { date: day(90), sg: 1.012, temp: 19, note: 'Dry hops in' },
        { date: day(86), sg: 1.01, temp: 19, note: '' },
        { date: day(83), sg: 1.01, temp: 18.5, note: 'Stable' },
      ],
      timeline: [
        { id: 'demo1-a', t: at(96, '09:10'), text: 'Mashed in at 66 °C.', stage: 'brew day' },
        { id: 'demo1-b', t: at(96, '13:30'), text: '21 L in the fermenter at 1.050. One point under the target.', stage: 'brew day' },
        { id: 'demo1-c', t: at(90, '19:00'), text: 'Added the Citra dry hops.', stage: 'fermenting' },
        { id: 'demo1-d', t: at(80, '11:00'), text: 'Kegged. Clear, with a good hop aroma.', stage: 'packaged' },
      ],
      tasting: 'Citrus and a little pine. Clean and dry. Next time, a touch more crystal malt.',
    }),
    [`${day(47)}-copper-kettle-best-bitter-demo2`]: brew('Copper Kettle Best Bitter #2', 'demo-best-bitter', 'packaged', 47, {
      packagedDate: day(35), rating: 5,
      measured: { preBoilVol: 26, preBoilSG: 1.037, og: 1.044, fermenterVol: 21, fg: 1.011 },
      readings: [
        { date: day(47), sg: 1.044, temp: 19, note: 'Pitched' },
        { date: day(44), sg: 1.018, temp: 19.5, note: '' },
        { date: day(40), sg: 1.011, temp: 19, note: '' },
        { date: day(37), sg: 1.011, temp: 19, note: 'Stable' },
      ],
      timeline: [
        { id: 'demo2-a', t: at(47, '10:00'), text: 'Brew day went to plan. Hit 1.044.', stage: 'brew day' },
        { id: 'demo2-b', t: at(35, '18:30'), text: 'Bottled 40 bottles with 85 g of sugar.', stage: 'packaged' },
      ],
      tasting: 'Toffee and marmalade, firm bitterness. The best one so far.',
    }),
    [`${day(6)}-house-pale-ale-demo3`]: brew('House Pale Ale #3', 'house-pale-ale', 'fermenting', 6, {
      measured: { preBoilVol: 26.5, preBoilSG: 1.043, og: 1.051, fermenterVol: 21, fg: null },
      readings: [
        { date: day(6), sg: 1.051, temp: 19, note: 'Pitched' },
        { date: day(4), sg: 1.032, temp: 19.5, note: 'Busy airlock' },
        { date: day(2), sg: 1.016, temp: 19.5, note: '' },
        { date: day(0), sg: 1.012, temp: 19, note: '' },
      ],
      timeline: [
        { id: 'demo3-a', t: at(6, '09:30'), text: 'Mashed in. The water was a little hot, so the mash started at 67 °C.', stage: 'brew day' },
        { id: 'demo3-b', t: at(6, '14:00'), text: 'In the fermenter at 1.051.', stage: 'brew day' },
        { id: 'demo3-c', t: at(4, '08:00'), text: 'Thick foam on top and a lot of bubbles.', stage: 'fermenting' },
      ],
      notes: 'Dry hop when the gravity reaches 1.012.',
    }),
    [`${day(0)}-night-shift-oatmeal-stout-demo4`]: brew('Night Shift Oatmeal Stout #4', 'demo-oatmeal-stout', 'planned', 0, {
      stepsDone: 0,
      notes: 'Not brewed yet. Scroll down to the timer and the brew-day checklist to try them.',
    }),
  };
  return { recipes, brews };
}
