// Test of the Android app on an emulator or a phone, against a simulated Supabase (no real account needed).
// It drives the page inside the app through the WebView's debugging port, and the phone through adb.
// Needs: a debug build installed (cd android && ./gradlew installDebug), one device in `adb devices`,
// and Node 22 or later (Node 21: add --experimental-websocket).
//   node tests/android/device.mjs
// The test turns on airplane mode while it runs, so no request can reach a real Supabase project, and it
// clears the app's data, so do not run it on a phone where you use Gyle.
// Checks 7 and 8 tap through the emulator's camera and file picker. Other phones name those buttons
// differently, and then these two checks report that nothing was added.
// It prints one line per check; read the output, there are no assertions on the UI text.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ADB = process.env.ADB || 'adb', PKG = 'io.github.shaslam.gyle', PORT = 9222;
const adb = (...args) => execFileSync(ADB, args, { encoding: 'utf8', maxBuffer: 64e6, timeout: 60000 });
const sh = cmd => { try { return adb('shell', cmd).replace(/\r/g, ''); } catch (e) { return String(e.stdout || ''); } }; // a command that finds nothing is not an error
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 15000, step = 300) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(step)) { try { const v = await fn(); if (v) return v; } catch { /* not yet */ } } return null; };

// ---- a simulated Supabase: sign-in, the documents table and the photos bucket ----
const users = {}, tokens = {}, rows = new Map(), files = new Set(), log = [];
// The account already holds one recipe. The demo of the app must not add to it.
rows.set('recipes/house-pale-ale', { data: JSON.parse(readFileSync(new URL('../../recipes/house-pale-ale.json', import.meta.url), 'utf8')), updated_at: 'v0' });
let n = 0;
const session = (uid, email) => { n++; tokens[`at${n}`] = uid; return { access_token: `at${n}`, refresh_token: `rt${n}`, expires_in: 3600, token_type: 'bearer', user: { id: uid, email } }; };
function supabase(req) {
  const u = new URL(req.url), q = u.searchParams, path = u.pathname;
  let body = {};
  try { body = JSON.parse(req.postData || '{}'); } catch { /* a photo */ }
  log.push(`${req.method} ${path}${u.search}`);
  if (req.method === 'OPTIONS') return [204, null];
  if (path === '/auth/v1/signup') { users[body.email] = { id: 'u1', password: body.password }; return [200, session('u1', body.email)]; }
  if (path === '/auth/v1/token') return users[body.email]?.password === body.password ? [200, session('u1', body.email)] : [400, { error_code: 'invalid_credentials', msg: 'Invalid login credentials' }];
  if (path === '/auth/v1/logout') return [204, null];
  if (path === '/auth/v1/settings') return [200, { external: { email: true, github: false, google: false } }];
  const auth = Object.entries(req.headers).find(([k]) => k.toLowerCase() === 'authorization')?.[1] || '';
  const uid = tokens[auth.replace('Bearer ', '')];
  if (!uid) return [401, { msg: 'bad jwt' }];
  if (path === '/auth/v1/user') return [200, { id: uid, email: Object.keys(users)[0] || 'stu@example.com' }];
  if (path === '/rest/v1/documents') {
    const kind = (q.get('kind') || '').replace('eq.', ''), id = (q.get('id') || '').replace('eq.', '');
    if (req.method === 'GET') return [200, [...rows].filter(([k]) => k.startsWith(kind + '/') && (!id || k === `${kind}/${id}`)).map(([k, v]) => Object.fromEntries(q.get('select').split(',').map(f => [f, { id: k.split('/')[1], ...v }[f]])))];
    if (req.method === 'POST') { rows.set(`${body.kind}/${body.id}`, { data: body.data, updated_at: `v${++n}` }); return [201, [{ updated_at: `v${n}` }]]; }
    if (req.method === 'DELETE') { rows.delete(`${kind}/${id}`); return [204, null]; }
  }
  if (path.startsWith('/storage/v1/object/')) { if (req.method === 'POST') files.add(path.split('/').pop()); return [200, { Key: path }]; }
  return [404, { message: 'not found' }];
}

// ---- the page inside the app ----
let ws, seq = 0, top = 0;
const waiting = new Map();
async function attach() {
  const pid = await until(() => sh(`pidof ${PKG}`).trim());
  adb('forward', `tcp:${PORT}`, `localabstract:webview_devtools_remote_${pid}`);
  const page = await until(async () => (await (await fetch(`http://localhost:${PORT}/json`)).json()).find(t => t.type === 'page' && t.url.includes('appassets')));
  top = JSON.parse(page.description).screenY; // where the page starts on the screen, below the status bar
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = bad; });
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id) { const w = waiting.get(m.id); waiting.delete(m.id); if (m.error) w?.bad(new Error(m.error.message)); else w?.ok(m.result); }
    else if (m.method === 'Fetch.requestPaused') {
      const [status, body] = supabase(m.params.request);
      send('Fetch.fulfillRequest', { requestId: m.params.requestId, responseCode: status, body: Buffer.from(body == null ? '' : JSON.stringify(body)).toString('base64'),
        responseHeaders: Object.entries({ 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'content-type': 'application/json' }).map(([name, value]) => ({ name, value })) }).catch(() => {});
    }
  };
  await send('Fetch.enable', { patterns: [{ urlPattern: 'https://*.supabase.co/*' }] });
  await until(() => js("document.querySelector('#sync-chip')?.textContent"));
}
// A call to the page. It fails after 30 seconds without an answer, so a lost connection cannot hang the test.
const send = (method, params = {}) => new Promise((ok, bad) => {
  const id = ++seq;
  waiting.set(id, { ok, bad });
  setTimeout(() => { if (waiting.delete(id)) bad(new Error(`no answer from the page to ${method}`)); }, 30000);
  ws.send(JSON.stringify({ id, method, params }));
});
async function js(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
const text = sel => js(`document.querySelector(${JSON.stringify(sel)})?.innerText.replace(/\\s+/g, ' ').trim()`);
const click = sel => js(`document.querySelector(${JSON.stringify(sel)}).click()`);
const go = async hash => { await js(`location.hash = ${JSON.stringify(hash)}`); await sleep(700); };
const chip = () => text('#sync-chip');
// A real touch on something in the page, for the things Android only does after a touch.
async function tap(sel) {
  const [x, y] = await js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return [(r.x + r.width / 2) * devicePixelRatio, (r.y + r.height / 2) * devicePixelRatio]; })()`);
  sh(`input tap ${Math.round(x)} ${Math.round(y + top)}`);
}

// ---- the phone ----
const front = () => (sh('dumpsys activity activities').match(/topResumedActivity=.*? ([\w.]+\/[\w.$]+)/) || [])[1] || '';
// What is on the screen outside the page: [{ text, x, y }] for everything with a label.
function screen() {
  const xml = sh('uiautomator dump /sdcard/gyle-ui.xml >/dev/null 2>&1; cat /sdcard/gyle-ui.xml');
  return [...xml.matchAll(/<node [^>]*?text="([^"]*)"[^>]*?content-desc="([^"]*)"[^>]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g)]
    .map(m => ({ text: m[1] || m[2], x: (+m[3] + +m[5]) / 2, y: (+m[4] + +m[6]) / 2 })).filter(o => o.text);
}
async function tapText(pattern, ms = 8000) {
  const hit = await until(() => screen().find(o => pattern.test(o.text)), ms, 500);
  if (hit) sh(`input tap ${Math.round(hit.x)} ${Math.round(hit.y)}`);
  return hit?.text || null;
}
// The app's notifications: [{ title, body, when }].
const notes = () => sh('dumpsys notification --noredact').split(/NotificationRecord\(/).filter(s => s.includes(`pkg=${PKG}`))
  .map(s => ({ title: (s.match(/android\.title=\w+ \((.*)\)/) || [])[1], body: (s.match(/android\.text=\w+ \((.*)\)/) || [])[1], when: +(s.match(/ when=(\d+)/) || [])[1] }));
// The app's next timer alarm, as Android holds it: the time, and whether it is an exact alarm-clock alarm.
const alarm = () => { const m = sh('dumpsys alarm').match(new RegExp(`tag=\\*walarm\\*:${PKG}/\\.AlarmReceiver\\s+type=RTC_WAKEUP origWhen=\\S+ ([\\d:]+)[^\\n]*\\n(?:[^\\n]*\\n){2,3}?\\s+Alarm clock:`)); return m ? `alarm clock at ${m[1]}` : 'none'; };
// Whether the app's window keeps the screen on. The WebView also keeps it on while a debugger is
// attached, so the test lets go of the page to read the flag.
async function screenHeld() {
  ws.close(); await sleep(1000);
  const held = /KEEP_SCREEN_ON/.test((sh('dumpsys window windows').match(new RegExp(`Window\\{[^}]*${PKG}/[^}]*\\}:[\\s\\S]{0,2500}?fl=([^\\n]*)`)) || [])[1] || '');
  await attach();
  return held;
}
const start = () => sh(`am start -W -n ${PKG}/.MainActivity`);
// How many windows the app has. An Android dialog (the date picker, or the system's list for a <select>) is a second one.
const windows = () => (sh('dumpsys window windows').match(new RegExp(`^\\s*Window #\\d+ Window\\{[^}]*${PKG}/`, 'gm')) || []).length;

// ---- the checks ----
sh('cmd connectivity airplane-mode enable');
sh(`pm clear ${PKG}`); sh('rm -f /sdcard/Download/house-pale-ale*'); sh('cmd notification set_dnd off 2>/dev/null; true');
start(); await attach(); await sleep(1500);
const recipes = () => js("[...document.querySelectorAll('#recipe-list strong')].map(x => x.textContent).join()");
const cards = () => js("[...document.querySelectorAll('#view .card h2')].map(x => x.textContent).join(' / ')");
const shown = sel => js(`(e => !!e && !e.hidden && getComputedStyle(e).display !== 'none')(document.querySelector('${sel}'))`);
console.log('1 app starts:', await text('#view h1'), '|', await cards(), '| tab bar', await shown('#tabs'), '| other sign-in buttons', await js("document.querySelectorAll('#sb-providers button').length"),
  '| page', await js('location.origin'), '| bridge', await js("Object.keys(window.GyleNative || {}).length"), 'methods | wider than the screen:', await js('document.documentElement.scrollWidth > innerWidth'));
await tap('[data-act=demo]'); await sleep(1200);
console.log('  the demo: chip', await chip(), '| strip', await shown('#demo-bar'), '| recipes', await recipes(), '| brews', await js("Object.keys(JSON.parse(localStorage.getItem('gyle.cache.v1')).brews).length"));

await tap('#demo-bar'); await sleep(800);
console.log('2 from the demo strip:', await cards(), '| mode buttons', await js("document.querySelectorAll('#storage .seg').length"), '| GitHub fields', await js("document.querySelectorAll('#gh-repo').length"));
await js("document.querySelector('#sb-email').value = 'stu@example.com'; document.querySelector('#sb-password').value = 'hunter22'");
await click('[data-act=sb-signup]'); await sleep(2500);
console.log('  signed up: toast', await text('#toast'), '| recipes', await recipes(), '| strip', await shown('#demo-bar'), '| came back to:', decodeURIComponent(log.find(l => l.includes('signup')).split('redirect_to=')[1]));
await until(async () => await chip() === 'In sync', 8000);
console.log('  the demo stayed out of the account: chip', await chip(), '| rows', [...rows.keys()].join());

await go('#recipe/house-pale-ale'); await click('[data-act=export]'); await sleep(400); await click('dialog.sheet [data-fmt=json]'); await sleep(1500);
console.log('3 export: toast', await text('#toast'), '| in Downloads:', sh('ls /sdcard/Download/').trim().split('\n').join(), '| BeerJSON:', sh('cat /sdcard/Download/house-pale-ale.json').includes('"beerjson"'));
await go('#sheet/house-pale-ale'); await click('[data-act=pdf]'); await sleep(2500);
console.log('  brew sheet PDF:', sh('ls -l /sdcard/Download/ | grep pdf').trim().split(/\s+/).slice(4).join(' '), '| starts', JSON.stringify(sh('head -c 8 /sdcard/Download/house-pale-ale-brew-sheet.pdf')), '| in front:', front());
if (!front().startsWith(PKG)) { sh('input keyevent BACK'); await sleep(1000); }
await click('[data-act=print]'); await sleep(3000);
console.log('  print: in front', front()); sh('input keyevent BACK'); await sleep(1200);
if (!front().startsWith(PKG)) { sh('input keyevent BACK'); await sleep(1000); }

await go('#recipe/house-pale-ale'); await click('[data-act=brew]'); await sleep(1200);
const brew = await js('location.hash');
console.log('4 timer on', brew, '| notifications:', await js('GyleNative.notifyStatus()'), '|', await text('#timer-card .t-opts .hint'));
await click('[data-act=t-notify]');
console.log('  Android asks:', await tapText(/^Allow$/i), '| then:', await until(() => js("GyleNative.notifyStatus() === 'granted' && 'granted'")), '|', (await sleep(1000), await text('#timer-card .t-opts .hint')));
console.log('  first notification:', JSON.stringify(notes().map(o => o.title)));
await js("[...document.querySelectorAll('#timer-card [data-act=t-seg]')].find(b => b.textContent.startsWith('Boil')).click()"); await sleep(300);
await click('[data-act=t-start]'); await sleep(800);
console.log('  boil started: alarm set:', alarm(), '| screen stays on:', await screenHeld());
await click('[data-act=t-pause]'); await sleep(500);
console.log('  paused: alarm', alarm(), '| screen stays on:', await screenHeld());

// The app is closed and its process stopped while a step has 12 seconds left.
await js("(() => { const s = JSON.parse(localStorage.getItem('gyle.timer.v1')); s.remaining = 12000; s.fired = { '1:0': 1, '1:1': 1, '1:2': 1, '1:3': 1 }; localStorage.setItem('gyle.timer.v1', JSON.stringify(s)); location.reload(); })()").catch(() => {});
await sleep(2500); await attach(); await click('[data-act=t-start]'); await sleep(400);
const due = await js("JSON.parse(localStorage.getItem('gyle.timer.v1')).endsAt");
ws.close(); sh('input keyevent HOME'); await sleep(1500); sh(`am kill ${PKG}`); await sleep(500);
console.log('5 app closed with 12 s left: process', sh(`pidof ${PKG}`).trim() || 'stopped', '| alarm:', alarm());
const rang = await until(() => notes().find(o => /finished/.test(o.title || '')), 25000, 1000);
console.log('  alert while closed:', rang?.title, '|', rang?.body, '| late by', rang ? ((rang.when - due) / 1000).toFixed(1) + ' s' : '-');
start(); await attach(); await sleep(2500);
console.log('  app opened again: page', await js('location.hash'), '| timer', await text('#timer-card .count'), '| same notification, not a second one:', notes().filter(o => /finished/.test(o.title || '')).map(o => o.when).join() === String(rang?.when));

// Back, and a sign-in link from an email.
await go('#tools'); sh('input keyevent BACK'); await sleep(900);
console.log('6 Back: from #tools to', await js('location.hash'));
// A dropdown shows Gyle's own popup, not Android's list. Back closes a popup and stays on the page.
await go('#recipes'); await tap('#show'); await sleep(1200);
console.log('  dropdown: Gyle popup', await js("!!document.querySelector('dialog.choose[open]')"), '| choices', await js("document.querySelectorAll('dialog.choose .pick').length"), '| app windows', windows());
await tap('dialog.choose .pick[data-i="4"]'); await sleep(800);
console.log('  chosen:', await js("document.querySelector('#show').selectedOptions[0].text"), '| popup gone:', await js("!document.querySelector('dialog.choose')"));
await tap('#sort'); await sleep(1000); sh('input keyevent BACK'); await sleep(1000);
console.log('  Back with a popup open: popup gone', await js("!document.querySelector('dialog[open]')"), '| still on', await js('location.hash'));
await go(brew); await tap('input[type=date]'); await sleep(2000);
console.log('  a date field opens Android\'s dialog: app windows', windows()); sh('input keyevent BACK'); await sleep(800);
await go('#settings/storage'); await click('[data-act=sb-signout]'); await sleep(1500);
console.log('  signed out:', await text('#view h1'), '|', await cards());
const s = session('u1', 'stu@example.com');
sh(`am start -W -a android.intent.action.VIEW -d 'gyle://auth#access_token=${s.access_token}&refresh_token=${s.refresh_token}&expires_in=3600&token_type=bearer'`);
await sleep(3000);
console.log('  sign-in link: in front', front(), '| toast', await text('#toast'), '|', await text('#storage .summary'), '| chip', await chip());

// A photo from the camera, into the brew's timeline and on to the account.
await go(brew); await tap('label[for=tl-file]');
const offered = (await until(() => { const o = screen().map(x => x.text); return o.includes('Camera') && o; }, 8000, 500) || []).join(', ');
// The camera shows its shutter before it is ready, so wait a moment, and press again if no picture came.
const shoot = async () => { const hit = await tapText(/^Shutter$/, 12000); return hit && await until(() => screen().some(o => /^Done$/.test(o.text)), 9000, 800) ? hit : null; };
console.log('7 Add photos offers:', offered, '| taps:', await tapText(/^Camera$/), (await sleep(3000), await shoot() || await shoot()), await tapText(/^Done$/));
await until(() => front().startsWith(PKG) && js("document.querySelector('img[data-photo]')?.naturalWidth > 0"), 15000);
console.log('  timeline photos:', await js("[...document.querySelectorAll('img[data-photo]')].map(i => i.naturalWidth + 'x' + i.naturalHeight).join()"), '| uploaded:', (await until(() => files.size, 10000), [...files].join()), '| chip', await chip());

// A recipe file from the phone's storage.
const example = join(tmpdir(), 'zz-gyle-import-test.json');
writeFileSync(example, readFileSync(new URL('../../recipes/house-pale-ale.json', import.meta.url), 'utf8').replace('"name": "House Pale Ale"', '"name": "Imported Test Ale"'));
adb('push', example, '/sdcard/Download/zz-gyle-import-test.json');
sh('content call --method scan_volume --uri content://media --arg external_primary'); // so the file picker lists the new file
await go('#recipes'); await tap('[data-act=import]');
console.log('8 Import opens:', await until(() => /documentsui/.test(front()) && front(), 8000), '| taps:', await tapText(/^zz-gyle-import-test\.json$/, 10000));
await until(() => front().startsWith(PKG), 8000); await sleep(1500);
console.log('  imported:', await js('location.hash'), '| toast', await text('#toast'), '| name', await js("document.querySelector('#f-name')?.value"));

// The keyboard, and Back on the first screen. In an emulator with a window, Google's keyboard can show
// its stylus tutorial in place of the keys, and then the page height does not change.
// The first keyboard after a start of the emulator can take some seconds to appear.
await go('#recipes'); const tall = await js('innerHeight'); await tap('#q'); await until(async () => await js('innerHeight') < tall, 10000, 500);
console.log('9 keyboard: page height', tall, '->', await js('innerHeight'), '| tab bar still on screen:', await js("document.querySelector('#tabs').getBoundingClientRect().bottom <= innerHeight + 1"));
sh('input keyevent BACK'); await sleep(800);
ws.close(); sh(`am force-stop ${PKG}`); start(); await attach(); await sleep(1000); ws.close();
sh('input keyevent BACK'); await sleep(1500);
console.log('  Back on the first screen: in front', front().startsWith(PKG) ? 'still Gyle' : 'the home screen');

sh('rm -f /sdcard/Download/house-pale-ale* /sdcard/Download/zz-gyle-import-test.json /sdcard/gyle-ui.xml');
sh(`pm clear ${PKG}`); // or the app stays signed in to the simulated account, which no real project accepts
sh('cmd connectivity airplane-mode disable');
