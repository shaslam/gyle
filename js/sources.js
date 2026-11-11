// Reading sources: where a brew's automatic gravity readings come from.
// Each source turns a remote feed into the same shape:
//   { readings: [{ t: ISO time, sg, temp, battery }], fields: { 1: 'gravity', … } }
// ThingSpeak is the first; others (Brewfather, a database service) can be added beside it.

import { platoToSg } from './calc.js';

const pad = x => String(x).padStart(2, '0');
const tsTime = d => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;

// Work out which ThingSpeak field holds what from the names given to the channel's fields.
export function guessFields(names) {
  const find = re => Object.keys(names).find(k => re.test(names[k] || ''));
  return {
    gravity: find(/grav|plato|\bsg\b|extract/i),
    temp: find(/temp/i),
    battery: find(/batt|volt/i),
  };
}

// One reading per hour is plenty for a fermentation curve and keeps the brew file small.
export function hourly(readings) {
  const buckets = new Map();
  for (const r of readings) {
    const k = r.t.slice(0, 13);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(r);
  }
  const avg = (list, f) => { const v = list.map(x => x[f]).filter(Number.isFinite); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  return [...buckets].sort((a, b) => a[0].localeCompare(b[0])).map(([k, list]) => ({
    t: k + ':00:00Z',
    sg: +avg(list, 'sg').toFixed(4),
    temp: avg(list, 'temp') == null ? null : +avg(list, 'temp').toFixed(1),
    battery: list.at(-1).battery ?? null,
  }));
}

// Fetch a ThingSpeak channel's feed between two dates.
// device = { channel, gravityField?, tempField?, batteryField? }; key is the channel's Read API key (not needed for public channels).
export async function fetchThingSpeak(device, key, from, to) {
  const q = new URLSearchParams();
  if (key) q.set('api_key', key);
  if (from) q.set('start', tsTime(from));
  if (to) q.set('end', tsTime(to));
  if (!from) q.set('results', '8000');
  let res;
  try {
    res = await fetch(`https://api.thingspeak.com/channels/${encodeURIComponent(device.channel)}/feeds.json?${q}`, { cache: 'no-store' });
  } catch {
    throw new Error('Could not reach ThingSpeak. Check your connection.');
  }
  if (res.status === 404) throw new Error('ThingSpeak has no channel with that ID.');
  if (res.status === 400 || res.status === 401 || res.status === 403) throw new Error('ThingSpeak refused access. A private channel needs its Read API key.');
  if (!res.ok) throw new Error(`ThingSpeak error ${res.status}.`);
  const data = await res.json();
  if (data === -1 || !data.channel) throw new Error('ThingSpeak refused access. A private channel needs its Read API key.');

  const names = {};
  for (let i = 1; i <= 8; i++) if (data.channel['field' + i]) names[i] = data.channel['field' + i];
  const guess = guessFields(names);
  const gf = device.gravityField || guess.gravity, tf = device.tempField || guess.temp, bf = device.batteryField || guess.battery;
  if (!gf) throw Object.assign(new Error('Could not tell which field holds gravity. Choose it below.'), { fields: names });

  const num = v => { const x = parseFloat(v); return Number.isFinite(x) ? x : null; };
  const readings = (data.feeds || []).map(f => {
    let sg = num(f['field' + gf]);
    if (sg != null && sg > 1.5) sg = platoToSg(sg); // the iSpindel reports Plato unless its formula outputs SG
    return { t: f.created_at, sg, temp: tf ? num(f['field' + tf]) : null, battery: bf ? num(f['field' + bf]) : null };
  }).filter(r => r.sg != null && r.sg > 0.98 && r.sg < 1.2);
  return { readings: hourly(readings), fields: names, used: { gravity: gf, temp: tf, battery: bf }, raw: (data.feeds || []).length };
}

// The readings taken while the hydrometer floated in the beer. Gravity only falls during
// fermentation, so a reading well above the lowest one before it came after the hydrometer
// was taken out (for packaging or cleaning). Those readings are left out.
export function inBeer(readings, slack = 0.010) {
  let low = Infinity;
  return (readings || []).filter(r => {
    if (r.sg > low + slack) return false;
    low = Math.min(low, r.sg);
    return true;
  });
}

// "Stable" means the last `days` of readings stayed within two gravity points.
export function stableFor(readings, days = 2) {
  if (!readings?.length) return false;
  const end = Date.parse(readings.at(-1).t), start = end - days * 864e5;
  if (Date.parse(readings[0].t) > start) return false; // not enough history yet
  const recent = readings.filter(r => Date.parse(r.t) >= start).map(r => r.sg);
  return recent.length >= 12 && Math.max(...recent) - Math.min(...recent) <= 0.002;
}
