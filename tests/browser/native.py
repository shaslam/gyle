# Browser test for the web files as the Android app runs them: a stand-in for the app's
# `GyleNative` object records every call, and a simulated Supabase answers the requests.
# It tests the page's side of the bridge only. The Java side needs a phone or an emulator.
# Needs: Python Playwright, Google Chrome at /usr/bin/google-chrome, and the app served on port 8765:
#   python3 -m http.server 8765   (from the repo root, in another terminal)
#   python3 tests/browser/native.py
# It prints one line per check; read the output, there are no assertions on the UI text.
import json, base64, urllib.parse, pathlib
from playwright.sync_api import sync_playwright
SB='https://mock.supabase.co'
ROOT=pathlib.Path(__file__).resolve().parents[2]
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

# The stand-in for the app. Every call is kept in window.__calls as [method, ...arguments].
FAKE = """
window.__calls = []; window.__notify = 'default';
window.GyleNative = Object.fromEntries(['saveFile','print','setAlarms','showAlert','notifyStatus','askToNotify','keepAwake','openExternal'].map(name =>
  [name, (...args) => { window.__calls.push([name, ...args]); return name === 'saveFile' ? '' : name === 'notifyStatus' ? window.__notify : undefined; }]));
"""

with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    U='http://localhost:8765/'
    config=lambda route: route.fulfill(status=200, content_type='text/javascript', body=f"export const SUPABASE_URL = '{SB}';\nexport const SUPABASE_KEY = 'PUBKEY';\n")

    # A plain browser is unchanged: three places to keep data.
    web = b.new_page(viewport={'width':390,'height':844}); web.route('**/js/config.js', config); web.route(SB+'/**', sb)
    web.goto(U+'#settings/storage'); web.wait_for_timeout(900)
    print('0 browser: modes', web.eval_on_selector_all('#storage .seg','o=>o.map(x=>x.textContent)'), '| chip:', web.inner_text('#sync-chip'))
    web.goto(U+'#recipes'); web.wait_for_timeout(400); web.focus('#show'); web.keyboard.press('Enter'); web.wait_for_timeout(200)
    print('  a dropdown keeps the browser list: Gyle popups', web.locator('dialog.choose').count()); web.close()

    pg = b.new_page(viewport={'width':390,'height':844}, device_scale_factor=2, has_touch=True)
    errs=[]; pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.add_init_script(FAKE); pg.route('**/js/config.js', config); pg.route(SB+'/**', sb)
    calls=lambda name: [c[1:] for c in pg.evaluate('window.__calls') if c[0]==name]
    clear=lambda: pg.evaluate('window.__calls.length = 0')
    chip=lambda: pg.inner_text('#sync-chip'); msg=lambda: pg.inner_text('#storage-msg')

    names=lambda: pg.eval_on_selector_all('#recipe-list strong','o=>o.map(x=>x.textContent)')
    shown=lambda sel: pg.eval_on_selector(sel, "e => getComputedStyle(e).display !== 'none' && !e.hidden")
    cards=lambda: pg.eval_on_selector_all('#view .card h2','o=>o.map(x=>x.textContent)')

    # First open, not signed in: the welcome screen with the two ways on, and nothing else.
    pg.goto(U); pg.wait_for_timeout(1300)
    print('1 first open:', pg.inner_text('#view h1'), cards(), '| tab bar', shown('#tabs'), '| chip', shown('#sync-chip'), '| demo strip', shown('#demo-bar'))
    print('  sign-in form', pg.locator('#sb-form').count(), '| buttons for the services that are on:', pg.eval_on_selector_all('#sb-providers button','o=>o.map(x=>x.textContent)'), '| demo button:', pg.inner_text('[data-act=demo]'))
    pg.goto(U+'#settings/storage'); pg.wait_for_timeout(300); print('  any other address still shows it:', pg.inner_text('#view h1'), '| recipes on the phone:', pg.evaluate("Object.keys(JSON.parse(localStorage.getItem('gyle.cache.v1') || '{}').recipes || {}).length"))

    # The demo: four recipes and four brew logs, marked as a demo on every screen.
    pg.click('[data-act=demo]'); pg.wait_for_timeout(500)
    print('2 demo:', names(), '| chip', repr(chip()), '| strip:', pg.inner_text('#demo-bar') if shown('#demo-bar') else None, '| tab bar', shown('#tabs'), '| toast:', pg.inner_text('#toast'))
    pg.goto(U+'#brews'); pg.wait_for_timeout(500)
    print('  brews:', pg.eval_on_selector_all('#view .list .item', "o=>o.map(x=>x.querySelector('strong').textContent+' ['+x.querySelector('.pill').textContent+']')"), '| brew days chart', shown('#brew-days'))
    pg.click('#view .list .item >> nth=1'); pg.wait_for_timeout(600)
    print('  a fermenting brew:', pg.input_value('#f-name'), '| readings', pg.locator('#sec-readings input[type=date]').count(), '| timeline entries', pg.locator('.tl-entry').count(), '| steps ticked', pg.locator('.steps input:checked').count(), 'of', pg.locator('.steps input').count())
    pg.goto(U+'#settings/storage'); pg.wait_for_timeout(300)
    print('  storage card: mode buttons', pg.locator('#storage .seg').count(), '| sign-in form', pg.locator('#sb-form').count(), '| GitHub repo fields', pg.locator('#gh-repo').count())
    print('  hints:', pg.inner_text('.card > .hint')[:60], '|', pg.inner_text('#storage .hint >> nth=-2')[:50])
    pg.reload(); pg.wait_for_timeout(900); pg.goto(U+'#recipes'); pg.wait_for_timeout(300); print('  after a restart: still the demo', len(names()), repr(chip()))

    # A dropdown opens Gyle's own popup, and a choice there reaches the page as a normal change.
    pg.click('#show'); pg.wait_for_timeout(200)
    print('  dropdown:', pg.inner_text('dialog.choose h2'), pg.eval_on_selector_all('dialog.choose .pick', "o=>o.map(x=>x.textContent+(x.classList.contains('on')?'*':''))"))
    pg.click('dialog.choose .pick >> text=In planning'); pg.wait_for_timeout(300)
    print('  chosen:', pg.eval_on_selector('#show', 'e=>e.selectedOptions[0].text'), '| popup gone:', pg.locator('dialog.choose').count()==0, '| list now:', names())
    pg.click('#show'); pg.click('dialog.choose .pick >> text=Ready and planning'); pg.wait_for_timeout(300)
    pg.click('#sort'); pg.wait_for_timeout(200); pg.mouse.click(5, 5); pg.wait_for_timeout(200)
    print('  tap outside closes it:', pg.locator('dialog.choose').count()==0, '| unchanged:', pg.eval_on_selector('#sort', 'e=>e.selectedOptions[0].text'))

    # The brew queue. A finger that starts on a handle and moves at once scrolls the page.
    # A finger that holds the handle first picks the recipe up, and a drag then moves it.
    cdp = pg.context.new_cdp_session(pg)
    def finger(kind, x=0, y=0): cdp.send('Input.dispatchTouchEvent', {'type': kind, 'touchPoints': [] if kind == 'touchEnd' else [{'x': x, 'y': y}]})
    def drag(sel, dy, hold):
        box = pg.locator(sel).bounding_box(); x = box['x'] + box['width']/2; y = box['y'] + box['height']/2
        finger('touchStart', x, y); pg.wait_for_timeout(hold)
        for i in range(1, 13): finger('touchMove', x, y + dy*i/12); pg.wait_for_timeout(16)
        lifted = pg.locator('.q-row.dragging').count(); finger('touchEnd'); pg.wait_for_timeout(500); return lifted
    lifted = drag('.grip >> nth=0', -220, 0)
    print('  queue, a swipe that starts on a handle: row picked up', lifted, '| page scrolled', pg.evaluate('scrollY') > 100, '| order', names()[:2])
    pg.evaluate('scrollTo(0, 0)'); pg.wait_for_timeout(200); lifted = drag('.grip >> nth=0', 150, 450)
    print('  queue, hold then drag: row picked up', lifted, '| page scrolled', pg.evaluate('scrollY') > 0, '| order', names()[:2])
    pg.evaluate('scrollTo(0, 0)'); pg.wait_for_timeout(200); lifted = drag('.grip >> nth=0', 150, 120)
    print('  queue, a hold that is too short: row picked up', lifted, '| order', names()[:2])
    pg.evaluate('scrollTo(0, 0)'); pg.wait_for_timeout(200)

    # From the demo to an account: the strip leads to the welcome screen. Signing in removes the demo.
    pg.click('#demo-bar'); pg.wait_for_timeout(300)
    print('3 from the demo strip:', cards(), '|', pg.eval_on_selector_all('#welcome-demo button','o=>o.map(x=>x.textContent)'))
    pg.click('[data-act=demo-back]'); pg.wait_for_timeout(300); print('  back to the demo:', len(names()), 'recipes'); pg.click('#sync-chip'); pg.wait_for_timeout(300)
    pg.click('[data-act=sb-oauth][data-v=github]'); pg.wait_for_timeout(200)
    print('  GitHub sign-in opens outside:', [urllib.parse.unquote(c[0]).replace(SB,'') for c in calls('openExternal')], '| page stayed:', pg.inner_text('#view h1'))
    pg.fill('#sb-email','stu@example.com'); pg.click('[data-act=sb-recover]'); pg.wait_for_timeout(300)
    print('  reset link comes back to:', [urllib.parse.unquote(l.split('redirect_to=')[1]) for l in log if 'recover' in l], '|', msg())
    pg.fill('#sb-password','hunter22'); pg.click('[data-act=sb-signup]'); pg.wait_for_timeout(1800)
    print('  signed up: toast', repr(pg.inner_text('#toast')), '| recipes', names(), '| chip', repr(chip()), '| strip', shown('#demo-bar'), '| tab bar', shown('#tabs'), '| sign-up link comes back to:', [urllib.parse.unquote(l.split('redirect_to=')[1]) for l in log if 'signup' in l])
    pg.wait_for_timeout(3000); print('  the demo did not go into the account: rows', sorted(rows), '| brews on the phone', pg.evaluate("Object.keys(JSON.parse(localStorage.getItem('gyle.cache.v1')).brews).length"), '| stored state', pg.evaluate("localStorage.getItem('gyle.storage.v1')"))

    pg.goto(U+'#recipe/house-pale-ale'); pg.wait_for_timeout(600); clear()
    pg.click('[data-act=export]'); pg.wait_for_timeout(200); pg.click('dialog.sheet [data-fmt=json]'); pg.wait_for_timeout(300)
    name, mime, data = calls('saveFile')[0]
    print('4 export:', name, mime, '| a BeerJSON file:', 'beerjson' in json.loads(base64.b64decode(data)), '| toast:', pg.inner_text('#toast'))
    pg.goto(U+'#sheet/house-pale-ale'); pg.wait_for_timeout(500); clear()
    pg.click('[data-act=print]'); pg.click('[data-act=pdf]'); pg.wait_for_timeout(400)
    name, mime, data = calls('saveFile')[0]
    print('5 brew sheet: print', calls('print'), '| pdf', name, mime, base64.b64decode(data)[:8], len(base64.b64decode(data)), 'bytes')

    pg.goto(U+'#recipe/house-pale-ale'); pg.wait_for_timeout(500); pg.click('[data-act=brew]'); pg.wait_for_timeout(700); clear()
    print('6 timer card:', pg.inner_text('#timer-card .t-opts .hint').replace('\n',' '))
    pg.click('[data-act=t-notify]'); pg.wait_for_timeout(100); print('  asked the app:', len(calls('askToNotify')))
    pg.evaluate("window.__notify='granted'; window.dispatchEvent(new Event('gyle-notify'))"); pg.wait_for_timeout(200)
    print('  after yes:', pg.inner_text('#timer-card .t-opts .hint').replace('\n',' '), '| alert shown:', [c[1] for c in calls('showAlert')])
    pg.evaluate("window.__notify='denied'; window.dispatchEvent(new Event('gyle-notify'))"); pg.wait_for_timeout(200)
    print('  after no:', pg.inner_text('#timer-card .t-opts .hint').replace('\n',' '))
    pg.evaluate("window.__notify='granted'; window.dispatchEvent(new Event('gyle-notify'))"); pg.wait_for_timeout(200)
    segs=pg.eval_on_selector_all('#timer-card [data-act=t-seg]','o=>o.map(x=>x.textContent)'); print('  steps:', segs)
    pg.click('#timer-card [data-act=t-seg] >> nth=%d' % next(i for i,s in enumerate(segs) if s.startswith('Boil'))); pg.wait_for_timeout(200); clear()
    now=pg.evaluate('Date.now()'); pg.click('[data-act=t-start]'); pg.wait_for_timeout(300)
    plan=json.loads(calls('setAlarms')[-1][0])
    print('7 boil started: awake', calls('keepAwake'), '| alarms:', [(round((a['at']-now)/60000,1), a['title'], a['body'][:40]) for a in plan])
    print('  due at once, shown by the page:', [(c[1], c[2][:40]) for c in calls('showAlert')], '| keys differ:', len({a['key'] for a in plan})==len(plan))
    clear(); pg.click('[data-act=t-adj][data-d="1"]'); pg.wait_for_timeout(200)
    print('  +1 min: end moves to', [round((a['at']-now)/60000,1) for a in json.loads(calls('setAlarms')[-1][0]) if a['key'].endswith('|end')])
    clear(); pg.click('[data-act=t-pause]'); pg.wait_for_timeout(200)
    print('  paused: alarms', calls('setAlarms')[-1], '| awake', calls('keepAwake'))
    clear(); pg.click('[data-act=t-test]'); pg.wait_for_timeout(200); print('  test alert:', [c[1] for c in calls('showAlert')])
    # A step that ends while the page is open: the page shows it under the key the app was given.
    pg.evaluate("(() => { const s = JSON.parse(localStorage.getItem('gyle.timer.v1')); s.remaining = 1500; localStorage.setItem('gyle.timer.v1', JSON.stringify(s)); })()")
    pg.reload(); pg.wait_for_timeout(900); clear(); pg.click('[data-act=t-start]'); pg.wait_for_timeout(200)
    key=json.loads(calls('setAlarms')[-1][0])[-1]['key']; pg.wait_for_timeout(2300)
    print('8 step ended:', calls('showAlert')[-1][1], '| under the key the app has:', calls('showAlert')[-1][0]==key, '| alarms left:', calls('setAlarms')[-1], '| awake', calls('keepAwake')[-1])

    print('  autosave: the brew log is in the account:', sorted(k[0] for k in rows))
    # Sign out: back to the welcome screen. Then the app hands a sign-in link to the open page.
    pg.goto(U+'#settings/storage'); pg.wait_for_timeout(300); pg.click('[data-act=sb-signout]'); pg.wait_for_timeout(700)
    print('9 signed out:', pg.inner_text('#view h1'), cards(), '| toast:', pg.inner_text('#toast'), '| recipes on the phone:', pg.evaluate("Object.keys(JSON.parse(localStorage.getItem('gyle.cache.v1')).recipes).length"))
    s=session('u1','stu@example.com')
    pg.evaluate(f"location.href = '{U}#access_token={s['access_token']}&refresh_token={s['refresh_token']}&expires_in=3600&token_type=bearer'"); pg.wait_for_timeout(1500)
    print('  link while open: url', pg.url.split('/')[-1], '| toast:', pg.inner_text('#toast'), '|', pg.inner_text('#storage .summary'), '| chip', repr(chip()))
    pg.goto(U+'#recipes'); pg.wait_for_timeout(400); print('  recipes back:', names())
    pg.evaluate(f"location.href = '{U}#error=access_denied&error_description=Email+link+is+invalid+or+has+expired'"); pg.wait_for_timeout(500)
    print('  bad link:', pg.inner_text('#toast'))
    # A project with no outside sign-in service: the form has no such button.
    services['github']=False; pg.goto(U+'#settings/storage'); pg.wait_for_timeout(300); pg.click('[data-act=sb-signout]'); pg.wait_for_timeout(700)
    pg.evaluate("localStorage.removeItem('gyle.supabase.providers')"); pg.reload(); pg.wait_for_timeout(1200)
    print('  services all off: buttons', pg.eval_on_selector_all('#sb-providers button','o=>o.map(x=>x.textContent)'), '| the block is hidden:', not shown('#sb-providers'))
    wide = "[...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > innerWidth + 0.5).map(e => e.tagName + '#' + e.id + '.' + e.className + ' ' + Math.round(e.getBoundingClientRect().right))"
    print('overflow', pg.evaluate('document.documentElement.scrollWidth > innerWidth'), pg.evaluate(wide), errs); b.close()
