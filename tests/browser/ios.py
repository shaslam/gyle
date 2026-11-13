# Browser test for the web files as the iOS app runs them. It runs in WebKit, the engine that
# iOS uses. The page gets the real ios/bridge.js. A stand-in for the Swift side records every
# message and every prompt() that the bridge sends, and a simulated Supabase answers the requests.
# It tests the page's side and bridge.js only. The Swift side needs a Mac with Xcode.
# Needs: Python Playwright with its WebKit (`playwright install webkit`), and the app served on port 8765:
#   python3 -m http.server 8765   (from the repo root, in another terminal)
#   python3 tests/browser/ios.py
# It prints one line per check; read the output, there are no assertions on the UI text.
import json, base64, urllib.parse, pathlib
from playwright.sync_api import sync_playwright
ROOT=pathlib.Path(__file__).resolve().parents[2]
SB='https://mock.supabase.co'
users={}; tokens={}; log=[]; n=[0]
# The account already holds one recipe. The demo must not add to it.
rows={('recipes','house-pale-ale'): {'data': json.loads((ROOT/'recipes'/'house-pale-ale.json').read_text()), 'updated_at': 'v0'}}
services={'email': True, 'github': True, 'google': False}  # what the project has switched on
CORS={'access-control-allow-origin':'*','access-control-allow-headers':'*','access-control-allow-methods':'*'}
def J(route, status, body): route.fulfill(status=status, content_type='application/json', body=json.dumps(body), headers=CORS)
def session(uid, email):
    n[0]+=1; tokens[f'at{n[0]}']=uid
    return {"access_token":f'at{n[0]}',"refresh_token":f'rt{n[0]}',"expires_in":3600,"token_type":"bearer","user":{"id":uid,"email":email}}
def sb(route):
    r=route.request; u=urllib.parse.urlparse(r.url); q=urllib.parse.parse_qs(u.query); path=u.path
    if r.method=='OPTIONS': return route.fulfill(status=204, headers=CORS)
    body=json.loads(r.post_data) if r.post_data and r.headers.get('content-type','').startswith('application/json') else {}
    log.append(f'{r.method} {path}{"?"+u.query if u.query else ""}')
    if path=='/auth/v1/signup':
        users[body['email']]='u1'; return J(route,200,session('u1',body['email']))
    if path=='/auth/v1/recover': return J(route,200,{})
    if path=='/auth/v1/settings': return J(route,200,{"external":services})
    uid=tokens.get(r.headers.get('authorization','').replace('Bearer ',''))
    if path=='/auth/v1/user': return J(route,200,{"id":uid,"email":"stu@example.com"}) if uid else J(route,401,{"msg":"bad jwt"})
    if path=='/rest/v1/documents':
        kind=q.get('kind',[''])[0].replace('eq.',''); did=q.get('id',[''])[0].replace('eq.','')
        if r.method=='GET':
            out=[{"id":k[1],"updated_at":v['updated_at'],"data":v['data']} for k,v in rows.items() if k[0]==kind and (not did or k[1]==did)]
            return J(route,200,[{f:o[f] for f in q['select'][0].split(',')} for o in out])
        if r.method=='POST':
            n[0]+=1; rows[(body['kind'],body['id'])]={'data':body['data'],'updated_at':f'v{n[0]}'}
            return J(route,201,[{"updated_at":f'v{n[0]}'}])
        if r.method=='DELETE': rows.pop((kind,did),None); return route.fulfill(status=204, headers=CORS)
    J(route,404,{"message":"not found"})

# The stand-in for the Swift side: what WebScreen.swift receives. Every call is kept in
# window.__calls as [how it arrived, method, ...arguments].
FAKE = """
window.__calls = []; window.__notify = 'default';
Object.defineProperty(window, 'webkit', { configurable: true, value: { messageHandlers: { gyle: { postMessage: m => { window.__calls.push(['message', m.name, ...m.args]); } } } } });
window.prompt = (text, value) => {
  if (text !== 'gyle-native') return null;
  const m = JSON.parse(value); window.__calls.push(['prompt', m.name, ...m.args]);
  return m.name === 'notifyStatus' ? window.__notify : '';
};
"""

with sync_playwright() as p:
    b = p.webkit.launch()
    U='http://localhost:8765/'
    config=lambda route: route.fulfill(status=200, content_type='text/javascript', body=f"export const SUPABASE_URL = '{SB}';\nexport const SUPABASE_KEY = 'PUBKEY';\n")
    phone = {k: v for k, v in p.devices['iPhone 14'].items() if k != 'default_browser_type'}

    # The website in WebKit with no app around it (Safari on an iPhone): it must start without an error.
    ctx = b.new_context(**phone); web = ctx.new_page(); werrs=[]; web.on('pageerror', lambda e: werrs.append(str(e)))
    web.route('**/js/config.js', config); web.route(SB+'/**', sb)
    web.goto(U+'#settings/storage'); web.wait_for_timeout(1200)
    print('0 WebKit', b.version, '| website: modes', web.eval_on_selector_all('#storage .seg','o=>o.map(x=>x.textContent)'), '| chip:', web.inner_text('#sync-chip'), '| welcome screen:', web.locator('#welcome-demo').count(), '| errors:', werrs)
    ctx.close()

    ctx = b.new_context(**phone); pg = ctx.new_page()
    errs=[]; pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.add_init_script(FAKE); pg.add_init_script(path=str(ROOT/'ios'/'bridge.js')); pg.route('**/js/config.js', config); pg.route(SB+'/**', sb)
    calls=lambda name: [c[2:] for c in pg.evaluate('window.__calls') if c[1]==name]
    how=lambda name: sorted({c[0] for c in pg.evaluate('window.__calls') if c[1]==name})
    clear=lambda: pg.evaluate('window.__calls.length = 0')
    chip=lambda: pg.inner_text('#sync-chip'); msg=lambda: pg.inner_text('#storage-msg')

    names=lambda: pg.eval_on_selector_all('#recipe-list strong','o=>o.map(x=>x.textContent)')
    shown=lambda sel: pg.eval_on_selector(sel, "e => getComputedStyle(e).display !== 'none' && !e.hidden")
    cards=lambda: pg.eval_on_selector_all('#view .card h2','o=>o.map(x=>x.textContent)')

    # First open, not signed in: the welcome screen with the two ways on, and nothing else.
    pg.goto(U); pg.wait_for_timeout(1300)
    print('1 platform', pg.evaluate('window.GyleNative.platform'), '| viewport:', pg.get_attribute('meta[name=viewport]', 'content'))
    print('  first open:', pg.inner_text('#view h1'), cards(), '| tab bar', shown('#tabs'), '| chip', shown('#sync-chip'), '| demo strip', shown('#demo-bar'))
    print('  sign-in form', pg.locator('#sb-form').count(), '| buttons for the services that are on:', pg.eval_on_selector_all('#sb-providers button','o=>o.map(x=>x.textContent)'), '| demo button:', pg.inner_text('[data-act=demo]'))
    pg.goto(U+'#settings/storage'); pg.wait_for_timeout(300); print('  any other address still shows it:', pg.inner_text('#view h1'), '| recipes on the phone:', pg.evaluate("Object.keys(JSON.parse(localStorage.getItem('gyle.cache.v1') || '{}').recipes || {}).length"))

    # The demo: four recipes and four brew logs, marked as a demo on every screen.
    pg.tap('[data-act=demo]'); pg.wait_for_timeout(500)
    print('2 demo:', names(), '| chip', repr(chip()), '| strip:', pg.inner_text('#demo-bar') if shown('#demo-bar') else None, '| tab bar', shown('#tabs'), '| toast:', pg.inner_text('#toast'))
    pg.goto(U+'#brews'); pg.wait_for_timeout(500)
    print('  brews:', pg.eval_on_selector_all('#view .list .item', "o=>o.map(x=>x.querySelector('strong').textContent+' ['+x.querySelector('.pill').textContent+']')"), '| brew days chart', shown('#brew-days'))
    pg.tap('#view .list .item >> nth=1'); pg.wait_for_timeout(600)
    print('  a fermenting brew:', pg.input_value('#f-name'), '| readings', pg.locator('#sec-readings input[type=date]').count(), '| timeline entries', pg.locator('.tl-entry').count(), '| steps ticked', pg.locator('.steps input:checked').count(), 'of', pg.locator('.steps input').count())
    pg.goto(U+'#settings/storage'); pg.wait_for_timeout(300)
    print('  storage card: mode buttons', pg.locator('#storage .seg').count(), '| sign-in form', pg.locator('#sb-form').count(), '| GitHub repo fields', pg.locator('#gh-repo').count())
    print('  hints:', pg.inner_text('.card > .hint')[:60], '|', pg.inner_text('#storage .hint >> nth=-2')[:50])
    pg.reload(); pg.wait_for_timeout(900); pg.goto(U+'#recipes'); pg.wait_for_timeout(300); print('  after a restart: still the demo', len(names()), repr(chip()))

    # A dropdown opens Gyle's own popup, and a choice there reaches the page as a normal change.
    pg.tap('#show'); pg.wait_for_timeout(200)
    print('  dropdown:', pg.inner_text('dialog.choose h2'), pg.eval_on_selector_all('dialog.choose .pick', "o=>o.map(x=>x.textContent+(x.classList.contains('on')?'*':''))"))
    pg.tap('dialog.choose .pick >> text=In planning'); pg.wait_for_timeout(300)
    print('  chosen:', pg.eval_on_selector('#show', 'e=>e.selectedOptions[0].text'), '| popup gone:', pg.locator('dialog.choose').count()==0, '| list now:', names())
    pg.tap('#show'); pg.tap('dialog.choose .pick >> text=Ready and planning'); pg.wait_for_timeout(300)
    pg.tap('#sort'); pg.wait_for_timeout(200); pg.touchscreen.tap(5, 5); pg.wait_for_timeout(200)
    print('  tap outside closes it:', pg.locator('dialog.choose').count()==0, '| unchanged:', pg.eval_on_selector('#sort', 'e=>e.selectedOptions[0].text'))

    # The status of a recipe: no stamp on the cards of the queue (the group heading says it), a stamp on
    # the recipe page, and a press on that stamp opens a menu.
    print('  status: stamps on the queue cards', pg.locator('#recipe-list .pill').count(), '| groups', pg.eval_on_selector_all('#recipe-list .q-head','o=>o.map(x=>x.textContent)'))
    pg.goto(U+'#recipe/demo-kolsch'); pg.wait_for_timeout(500); pg.tap('[data-act=status-menu]'); pg.wait_for_timeout(300)
    print('  recipe page: stamp', repr(pg.inner_text('#status-toggle')), '| menu', pg.eval_on_selector_all('dialog.sheet .pick', "o=>o.map(x=>x.querySelector('span').textContent+(x.classList.contains('on')?'*':''))"))
    pg.tap('dialog.sheet .pick[data-v=ready]'); pg.wait_for_timeout(400)
    print('  chosen: stamp', repr(pg.inner_text('#status-toggle')), '| menu gone', pg.locator('dialog.sheet').count()==0); pg.goto(U+'#recipes'); pg.wait_for_timeout(400)
    print('  queue now:', pg.eval_on_selector_all('#recipe-list [data-group=ready] strong','o=>o.map(x=>x.textContent)')); pg.select_option('#sort', 'name'); pg.wait_for_timeout(300)
    print('  a list in name order keeps its stamps:', pg.eval_on_selector_all('#recipe-list .pill','o=>o.map(x=>x.textContent)')); pg.select_option('#sort', 'queue'); pg.wait_for_timeout(300)

    # From the demo to an account: the strip leads to the welcome screen. Signing in removes the demo.
    pg.tap('#demo-bar'); pg.wait_for_timeout(300)
    print('3 from the demo strip:', cards(), '|', pg.eval_on_selector_all('#welcome-demo button','o=>o.map(x=>x.textContent)'))
    pg.tap('[data-act=demo-back]'); pg.wait_for_timeout(300); print('  back to the demo:', len(names()), 'recipes'); pg.tap('#sync-chip'); pg.wait_for_timeout(300)
    pg.tap('[data-act=sb-oauth][data-v=github]'); pg.wait_for_timeout(200)
    print('  GitHub sign-in opens outside:', [urllib.parse.unquote(c[0]).replace(SB,'') for c in calls('openExternal')], how('openExternal'), '| page stayed:', pg.inner_text('#view h1'))
    pg.fill('#sb-email','stu@example.com'); pg.tap('[data-act=sb-recover]'); pg.wait_for_timeout(300)
    print('  reset link comes back to:', [urllib.parse.unquote(l.split('redirect_to=')[1]) for l in log if 'recover' in l], '|', msg())
    pg.fill('#sb-password','hunter22'); pg.tap('[data-act=sb-signup]'); pg.wait_for_timeout(1800)
    print('  signed up: toast', repr(pg.inner_text('#toast')), '| recipes', names(), '| chip', repr(chip()), '| strip', shown('#demo-bar'), '| tab bar', shown('#tabs'), '| sign-up link comes back to:', [urllib.parse.unquote(l.split('redirect_to=')[1]) for l in log if 'signup' in l])
    pg.wait_for_timeout(3000); print('  the demo did not go into the account: rows', sorted(rows), '| brews on the phone', pg.evaluate("Object.keys(JSON.parse(localStorage.getItem('gyle.cache.v1')).brews).length"), '| stored state', pg.evaluate("localStorage.getItem('gyle.storage.v1')"))

    pg.goto(U+'#recipe/house-pale-ale'); pg.wait_for_timeout(600); clear()
    pg.tap('[data-act=export]'); pg.wait_for_timeout(200); pg.tap('dialog.sheet [data-fmt=json]'); pg.wait_for_timeout(300)
    name, mime, data = calls('saveFile')[0]
    print('4 export:', name, mime, how('saveFile'), '| a BeerJSON file:', 'beerjson' in json.loads(base64.b64decode(data)), '| toast (none, iOS shows the share sheet):', repr(pg.get_attribute('#toast','class')))
    pg.goto(U+'#sheet/house-pale-ale'); pg.wait_for_timeout(500); clear()
    pg.tap('[data-act=print]'); pg.tap('[data-act=pdf]'); pg.wait_for_timeout(400)
    name, mime, data = calls('saveFile')[0]
    print('5 brew sheet: print', calls('print'), how('print'), '| pdf', name, mime, base64.b64decode(data)[:8], len(base64.b64decode(data)), 'bytes')

    pg.goto(U+'#recipe/house-pale-ale'); pg.wait_for_timeout(500); pg.tap('[data-act=brew]'); pg.wait_for_timeout(700); clear()
    print('6 timer card:', pg.inner_text('#timer-card .t-opts .hint').replace('\n',' '))
    pg.tap('[data-act=t-notify]'); pg.wait_for_timeout(100); print('  asked the app:', len(calls('askToNotify')), how('askToNotify'))
    pg.evaluate("window.__notify='granted'; window.dispatchEvent(new Event('gyle-notify'))"); pg.wait_for_timeout(200)
    print('  after yes:', pg.inner_text('#timer-card .t-opts .hint').replace('\n',' '), '| alert shown:', [c[1] for c in calls('showAlert')])
    pg.evaluate("window.__notify='denied'; window.dispatchEvent(new Event('gyle-notify'))"); pg.wait_for_timeout(200)
    print('  after no:', pg.inner_text('#timer-card .t-opts .hint').replace('\n',' '), '| status asked through', how('notifyStatus'))
    pg.evaluate("window.__notify='granted'; window.dispatchEvent(new Event('gyle-notify'))"); pg.wait_for_timeout(200)
    segs=pg.eval_on_selector_all('#timer-card [data-act=t-seg]','o=>o.map(x=>x.textContent)')
    pg.tap('#timer-card [data-act=t-seg] >> nth=%d' % next(i for i,s in enumerate(segs) if s.startswith('Boil'))); pg.wait_for_timeout(200); clear()
    now=pg.evaluate('Date.now()'); pg.tap('[data-act=t-start]'); pg.wait_for_timeout(300)
    plan=json.loads(calls('setAlarms')[-1][0])
    print('7 boil started: awake', calls('keepAwake'), how('keepAwake'), '| alarms:', [(round((a['at']-now)/60000,1), a['title'], a['body'][:40]) for a in plan], how('setAlarms'))
    clear(); pg.tap('[data-act=t-pause]'); pg.wait_for_timeout(200)
    print('  paused: alarms', calls('setAlarms')[-1], '| awake', calls('keepAwake'))
    # A step that ends while the page is open: the page shows it under the key the app was given.
    pg.evaluate("(() => { const s = JSON.parse(localStorage.getItem('gyle.timer.v1')); s.remaining = 1500; localStorage.setItem('gyle.timer.v1', JSON.stringify(s)); })()")
    pg.reload(); pg.wait_for_timeout(900); clear(); pg.tap('[data-act=t-start]'); pg.wait_for_timeout(200)
    key=json.loads(calls('setAlarms')[-1][0])[-1]['key']; pg.wait_for_timeout(2300)
    print('8 step ended:', calls('showAlert')[-1][1], how('showAlert'), '| under the key the app has:', calls('showAlert')[-1][0]==key, '| alarms left:', calls('setAlarms')[-1], '| awake', calls('keepAwake')[-1])

    print('  autosave: the brew log is in the account:', sorted(k[0] for k in rows))
    # Sign out: back to the welcome screen. Then the app hands a sign-in link to the open page, by setting location.hash.
    pg.goto(U+'#settings/storage'); pg.wait_for_timeout(300); pg.tap('[data-act=sb-signout]'); pg.wait_for_timeout(700)
    print('9 signed out:', pg.inner_text('#view h1'), cards(), '| toast:', pg.inner_text('#toast'), '| recipes on the phone:', pg.evaluate("Object.keys(JSON.parse(localStorage.getItem('gyle.cache.v1')).recipes).length"))
    s=session('u1','stu@example.com')
    pg.evaluate(f"location.hash = 'access_token={s['access_token']}&refresh_token={s['refresh_token']}&expires_in=3600&token_type=bearer'"); pg.wait_for_timeout(1500)
    print('  link while open: url', pg.url.split('/')[-1], '| toast:', pg.inner_text('#toast'), '|', pg.inner_text('#storage .summary'), '| chip', repr(chip()))
    pg.goto(U+'#recipes'); pg.wait_for_timeout(400); print('  recipes back:', names())
    pg.evaluate("location.hash = 'error=access_denied&error_description=Email+link+is+invalid+or+has+expired'"); pg.wait_for_timeout(500)
    print('  bad link:', pg.inner_text('#toast'))
    # A project with no outside sign-in service: the form has no such button.
    services['github']=False; pg.goto(U+'#settings/storage'); pg.wait_for_timeout(300); pg.tap('[data-act=sb-signout]'); pg.wait_for_timeout(700)
    pg.evaluate("localStorage.removeItem('gyle.supabase.providers')"); pg.reload(); pg.wait_for_timeout(1200)
    print('  services all off: buttons', pg.eval_on_selector_all('#sb-providers button','o=>o.map(x=>x.textContent)'), '| the block is hidden:', not shown('#sb-providers'))
    wide = "[...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > innerWidth + 0.5).map(e => e.tagName + '#' + e.id + '.' + e.className + ' ' + Math.round(e.getBoundingClientRect().right))"
    print('overflow', pg.evaluate('document.documentElement.scrollWidth > innerWidth'), pg.evaluate(wide), errs); b.close()
