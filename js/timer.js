// Brew-day timer. One timer at a time, shared by the whole app, so it keeps
// counting while you look at a recipe or a calculator. The end time is saved in
// the browser: reloading the page or waking the phone picks the countdown up
// where it should be, and anything missed in the meantime is announced at once.
//
// A timer is a list of segments (mash steps, the boil, a whirlpool stand):
//   { name, min, alerts: [{ at: minutes remaining, text }] }

import { native } from './native.js';

const KEY = 'gyle.timer.v1';
const PREFS = 'gyle.timer.prefs.v1';
const read = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const write = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked */ } };

let state = read(KEY, null);
const prefs = { wake: true, ...read(PREFS, {}) };
const listeners = new Set();
let audio = null, wakeLock = null, swReg = null;

const save = () => { write(KEY, state); plan(); };
const emit = (kind, payload) => listeners.forEach(fn => fn(kind, payload));

// ---- ways of getting your attention ----
function unlockAudio() {
  try {
    audio ??= new (window.AudioContext || window.webkitAudioContext)();
    audio.resume?.();
  } catch { /* no audio */ }
}
function beep() {
  if (!audio) return;
  try {
    const t = audio.currentTime;
    [0, 0.35, 0.7].forEach(d => {
      const osc = audio.createOscillator(), gain = audio.createGain();
      osc.frequency.value = 880;
      osc.connect(gain); gain.connect(audio.destination);
      gain.gain.setValueAtTime(0.0001, t + d);
      gain.gain.exponentialRampToValueAtTime(0.4, t + d + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.28);
      osc.start(t + d); osc.stop(t + d + 0.3);
    });
  } catch { /* no audio */ }
}
async function serviceWorker() {
  try {
    swReg ??= await navigator.serviceWorker.register('sw.js');
    await navigator.serviceWorker.ready;
    return swReg;
  } catch { return null; }
}
async function notify(title, body, key) {
  if (native) { try { native.showAlert(key || `now|${Date.now()}`, title, body); } catch { /* sound and the on-screen alert remain */ } return; }
  try {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const opts = { body, tag: 'gyle-timer', renotify: true, requireInteraction: true };
    const reg = await serviceWorker(); // Android Chrome only shows notifications through a service worker
    if (reg) await reg.showNotification(title, opts); else new Notification(title, opts);
  } catch { /* fall back to sound and the on-screen alert */ }
}
async function acquireWake() {
  if (!prefs.wake || !state?.endsAt || wakeLock) return;
  if (native) { native.keepAwake(true); wakeLock = { release: () => native.keepAwake(false) }; return; }
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch { wakeLock = null; }
}
function releaseWake() { try { wakeLock?.release(); } catch { /* already gone */ } wakeLock = null; }

function fire(title, body, key) {
  beep();
  try { navigator.vibrate?.([300, 150, 300, 150, 300]); } catch { /* not allowed */ }
  notify(title, body, key);
  emit('alert', { title, body });
}

// In the Android and iOS apps the page stops when the phone is locked, so the app itself shows the alerts.
// It gets the list of alerts still to come each time the timer changes. Each alert has a key, and
// the app shows a key once only: an alert that the app and this page both raise appears one time.
const alertKey = at => `${state.brewId}|${state.seg}|${state.endsAt}|${at}`;
function plan() {
  if (!native) return;
  const list = [];
  if (state?.endsAt) {
    const seg = state.segments[state.seg], next = state.segments[state.seg + 1];
    const before = new Map(), atEnd = [];
    seg.alerts.forEach((a, j) => {
      if (state.fired[`${state.seg}:${j}`]) return;
      if (a.at > 0) before.set(a.at, [...(before.get(a.at) || []), a.text]); else atEnd.push(a.text);
    });
    for (const [at, texts] of before) list.push({ key: alertKey(at), at: state.endsAt - at * 60000, title: `${seg.name}: ${at} min left`, body: texts.join('. ') });
    list.push({ key: alertKey('end'), at: state.endsAt, title: `${seg.name} finished`, body: atEnd.join('. ') || (next ? `Next: ${next.name}` : 'All timed steps are done') });
  }
  try { native.setAlarms(JSON.stringify(list.filter(x => x.at > Date.now()))); } catch { /* alerts still show while the app is open */ }
}
plan(); // a timer that was running when the app closed
if (native) acquireWake();

function tick() {
  if (!state?.endsAt) return;
  const rem = state.endsAt - Date.now();
  const seg = state.segments[state.seg];
  const due = [], ats = [];
  seg.alerts.forEach((a, j) => {
    const k = `${state.seg}:${j}`;
    if (!state.fired[k] && rem <= a.at * 60000) { state.fired[k] = 1; due.push(a.text); ats.push(a.at); }
  });
  if (rem <= 0) {
    const key = alertKey('end');
    state.endsAt = null; state.remaining = 0; state.done = true;
    save(); releaseWake();
    const next = state.segments[state.seg + 1];
    fire(`${seg.name} finished`, due.join('. ') || (next ? `Next: ${next.name}` : 'All timed steps are done'), key);
    emit('change');
    return;
  }
  if (due.length) {
    save();
    fire(`${seg.name}: ${Math.round(rem / 60000)} min left`, due.join('. '), alertKey(Math.min(...ats)));
    emit('change');
  }
  emit('tick');
}
setInterval(tick, 500);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { tick(); acquireWake(); }
});

// An app sends this event when the person answered its question about notifications.
if (native) window.addEventListener('gyle-notify', () => {
  if (timer.notifyStatus() === 'granted') notify('Gyle notifications are on', 'You will be told when a step ends or a hop addition is due.');
  emit('change');
});

export const timer = {
  get state() { return state; },
  get running() { return !!state?.endsAt; },
  get prefs() { return prefs; },
  on(fn) { listeners.add(fn); },
  remaining() { return state ? (state.endsAt ? Math.max(0, state.endsAt - Date.now()) : state.remaining) : 0; },

  // Point the timer at a brew. Keeps a timer already set up for the same brew unless `force`.
  open(brewId, brewName, segments, force = false) {
    if (state?.brewId === brewId && !force) return;
    releaseWake();
    state = { brewId, brewName, segments, seg: 0, endsAt: null, remaining: (segments[0]?.min || 0) * 60000, fired: {}, started: false, done: false };
    save(); emit('change');
  },
  start() {
    if (!state || state.endsAt || state.remaining <= 0) return;
    unlockAudio();
    state.endsAt = Date.now() + state.remaining;
    state.started = true; state.done = false;
    save(); acquireWake(); emit('change'); tick();
  },
  pause() {
    if (!state?.endsAt) return;
    state.remaining = this.remaining(); state.endsAt = null;
    save(); releaseWake(); emit('change');
  },
  // Jump to a segment and reset it to its full time.
  select(i) {
    if (!state?.segments[i]) return;
    state.seg = i; state.endsAt = null; state.done = false;
    state.remaining = state.segments[i].min * 60000;
    Object.keys(state.fired).filter(k => k.startsWith(i + ':')).forEach(k => delete state.fired[k]);
    save(); releaseWake(); emit('change');
  },
  adjust(minutes) {
    if (!state) return;
    if (state.endsAt) state.endsAt = Math.max(Date.now() + 1000, state.endsAt + minutes * 60000);
    else { state.remaining = Math.max(0, state.remaining + minutes * 60000); state.done = state.done && state.remaining <= 0; }
    save(); emit('change');
  },
  clear() { state = null; save(); releaseWake(); emit('change'); },

  setWake(on) { prefs.wake = !!on; write(PREFS, prefs); if (on) acquireWake(); else releaseWake(); },
  // 'granted' | 'denied' | 'default' (not asked yet) | 'unsupported'
  notifyStatus() { try { return native ? native.notifyStatus() : 'Notification' in window ? Notification.permission : 'unsupported'; } catch { return 'unsupported'; } },
  async askToNotify() {
    unlockAudio();
    if (native) { native.askToNotify(); return; } // the answer arrives as a 'gyle-notify' event, below
    try {
      const p = await Notification.requestPermission();
      if (p === 'granted') { await serviceWorker(); notify('Gyle notifications are on', 'You will be told when a step ends or a hop addition is due.'); }
    } catch { /* unsupported here */ }
    emit('change');
  },
  test() { unlockAudio(); fire('Test alert', 'This is what a timer alert looks and sounds like.'); },
};
