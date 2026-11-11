# Browser test for the supabase integration, run against a simulated service (no real account needed).
# Needs: Python Playwright, Google Chrome at /usr/bin/google-chrome, and the app served on port 8765:
#   python3 -m http.server 8765   (from the repo root, in another terminal)
#   python3 tests/browser/supabase.py
# It prints one line per check; read the output, there are no assertions on the UI text.
import os
import json, re, base64, time, urllib.parse
from playwright.sync_api import sync_playwright
SB='https://mock.supabase.co'
users={}      # email -> {id, password}
tokens={}     # access_token -> user id
refresh={}    # refresh_token -> user id
rows={}       # (uid, kind, id) -> {data, updated_at}
log=[]; n=[0]
def session(uid, email, expires=3600):
    n[0]+=1; at=f'at{n[0]}'; rt=f'rt{n[0]}'; tokens[at]=uid; refresh[rt]=uid
    return {"access_token":at,"refresh_token":rt,"expires_in":expires,"token_type":"bearer","user":{"id":uid,"email":email}}
CORS={'access-control-allow-origin':'*','access-control-allow-headers':'*','access-control-allow-methods':'*'}
def J(route, status, body): route.fulfill(status=status, content_type='application/json', body=json.dumps(body), headers=CORS)
short=[False]
def sb(route):
    r=route.request; u=urllib.parse.urlparse(r.url); q=urllib.parse.parse_qs(u.query); path=u.path
    if r.method=='OPTIONS': return route.fulfill(status=204, headers=CORS)
    assert r.headers.get('apikey')=='PUBKEY', 'missing apikey'
    body=json.loads(r.post_data) if r.post_data else {}
    log.append(f'{r.method} {path}{"?"+u.query if u.query else ""}'[:110])
    if path=='/auth/v1/signup':
        if body['email'] in users: return J(route,422,{"code":422,"error_code":"user_already_exists","msg":"User already registered"})
        uid=f'u{len(users)+1}'; users[body['email']]={'id':uid,'password':body['password']}
        if body['email'].startswith('confirm'): return J(route,200,{"id":uid,"email":body['email'],"confirmation_sent_at":"now"})
        return J(route,200,session(uid,body['email']))
    if path=='/auth/v1/token' and q['grant_type']==['password']:
        usr=users.get(body['email'])
        if not usr or usr['password']!=body['password']: return J(route,400,{"code":400,"error_code":"invalid_credentials","msg":"Invalid login credentials"})
        return J(route,200,session(usr['id'],body['email'], 30 if short[0] else 3600))
    if path=='/auth/v1/token' and q['grant_type']==['refresh_token']:
        uid=refresh.get(body['refresh_token'])
        if not uid: return J(route,400,{"error_code":"refresh_token_not_found","msg":"Invalid Refresh Token"})
        return J(route,200,session(uid,[e for e,v in users.items() if v['id']==uid][0]))
    auth=r.headers.get('authorization','').replace('Bearer ','')
    if path=='/auth/v1/logout': return route.fulfill(status=204, headers=CORS)
    uid=tokens.get(auth)
    if path=='/auth/v1/user':
        if not uid: return J(route,401,{"msg":"bad jwt"})
        if r.method=='PUT': 
            for e,v in users.items():
                if v['id']==uid: v['password']=body['password']
        return J(route,200,{"id":uid,"email":[e for e,v in users.items() if v['id']==uid][0]})
    if path=='/rest/v1/documents':
        if not uid: return J(route,401,{"message":"JWT expired","code":"PGRST301"})
        kind=q.get('kind',[''])[0].replace('eq.',''); did=q.get('id',[''])[0].replace('eq.','')
        if r.method=='GET':
            out=[{"id":k[2],"updated_at":v['updated_at'],"data":v['data']} for k,v in rows.items() if k[0]==uid and k[1]==kind and (not did or k[2]==did)]
            sel=q['select'][0].split(',')
            return J(route,200,[{f:o[f] for f in sel} for o in out])
        if r.method=='POST':
            assert 'resolution=merge-duplicates' in r.headers.get('prefer',''), 'no upsert prefer'
            n[0]+=1; rows[(uid,body['kind'],body['id'])]={'data':body['data'],'updated_at':f'2026-11-11T00:00:{n[0]:02d}Z'}
            return J(route,201,[{"updated_at":rows[(uid,body['kind'],body['id'])]['updated_at']}])
        if r.method=='DELETE':
            rows.pop((uid,kind,did),None); return route.fulfill(status=204, headers=CORS)
    J(route,404,{"message":"not found"})

with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    pg = b.new_page(viewport={'width':390,'height':844}, device_scale_factor=2)
    errs=[]; pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.route(SB+'/**', sb)
    U='http://localhost:8765/'
    chip=lambda: pg.inner_text('#sync-chip'); msg=lambda: pg.inner_text('#storage-msg')
    names=lambda: pg.eval_on_selector_all('#recipe-list strong','o=>o.map(x=>x.textContent)')
    pg.goto(U); pg.wait_for_timeout(1300); print('1 local:', chip(), names())
    pg.goto(U+'#settings'); pg.wait_for_timeout(300)
    print('  modes:', pg.eval_on_selector_all('#storage .seg','o=>o.map(x=>x.textContent+(x.classList.contains("on")?"*":""))'))
    pg.click('[data-act=mode][data-v=supabase]'); pg.wait_for_timeout(200)
    pg.fill('#sb-email','stu@example.com'); pg.fill('#sb-password','hunter22'); pg.click('#sb-form button[type=submit]'); pg.wait_for_timeout(200); print('  no project:', msg())
    pg.fill('#sb-url', SB+'/'); pg.fill('#sb-key','PUBKEY')
    pg.fill('#sb-email','stu@example.com'); pg.fill('#sb-password','hunter22'); pg.click('#sb-form button[type=submit]'); pg.wait_for_timeout(400); print('  wrong login:', msg())
    pg.click('[data-act=sb-signup]'); pg.wait_for_timeout(1500)
    print('2 signed up:', pg.inner_text('#storage .summary'), '|', msg(), '| chip:', chip())
    pg.wait_for_timeout(1500); print('  after autosave: chip', chip(), '| rows:', sorted((k[1],k[2]) for k in rows))
    None
    pg.goto(U+'#recipe/house-pale-ale'); pg.wait_for_timeout(1300); print('3 editor save btn:', pg.inner_text('#save-btn'))
    pg.fill('#f-name','House Pale Ale v2'); pg.wait_for_timeout(300); print('  typing:', pg.inner_text('#save-btn'), chip())
    pg.wait_for_timeout(3200); print('  later:', pg.inner_text('#save-btn'), chip(), '| stored name:', rows[('u1','recipes','house-pale-ale')]['data']['beerjson']['recipes'][0]['name'], '| focus kept:', pg.evaluate('document.activeElement.id'))
    pg.goto(U+'#recipes'); pg.wait_for_timeout(400); pg.click('[data-act=new]'); pg.wait_for_timeout(300); pg.fill('#f-name','Second'); pg.wait_for_timeout(3300)
    rid=[k[2] for k in rows if k[1]=='recipes' and k[2]!='house-pale-ale'][0]
    pg.click('[data-act=delete]'); pg.click('[data-act=delete]'); pg.wait_for_timeout(3300); print('4 delete synced:', ('u1','recipes',rid) not in rows, names())
    pg.goto(U+'#settings'); pg.wait_for_timeout(300); pg.click('[data-act=sb-signout]'); pg.wait_for_timeout(600)
    print('5 signed out:', msg(), '| chip:', chip(), '| cache recipes:', pg.evaluate("Object.keys(JSON.parse(localStorage.getItem('gyle.cache.v1')).recipes).length"))
    short[0]=True
    pg.fill('#sb-email','stu@example.com'); pg.fill('#sb-password','hunter22'); pg.click('#sb-form button[type=submit]'); pg.wait_for_timeout(1500)
    pg.goto(U+'#recipes'); pg.wait_for_timeout(500); print('6 signed back in:', names(), chip(), '| refresh used:', any('grant_type=refresh_token' in l for l in log))
    short[0]=False
    pg.goto(U+'#settings'); pg.wait_for_timeout(300); pg.click('[data-act=sb-signout]'); pg.wait_for_timeout(600)
    pg.fill('#sb-email','other@example.com'); pg.fill('#sb-password','password9'); pg.click('[data-act=sb-signup]'); pg.wait_for_timeout(1500)
    pg.goto(U+'#recipes'); pg.wait_for_timeout(500); print('7 second user sees:', names(), '| their rows:', [k for k in rows if k[0]=='u2'])
    pg.goto(U+'#settings'); pg.wait_for_timeout(300); pg.click('[data-act=sb-signout]'); pg.wait_for_timeout(500)
    pg.fill('#sb-email','confirm@example.com'); pg.fill('#sb-password','password9'); pg.click('[data-act=sb-signup]'); pg.wait_for_timeout(600); print('8 confirm flow:', msg())
    # arriving from an OAuth / email link
    s=session('u1','stu@example.com')
    pg.goto('about:blank'); pg.goto(U+f"#access_token={s['access_token']}&refresh_token={s['refresh_token']}&expires_in=3600&token_type=bearer"); pg.wait_for_timeout(1500)
    print('9 link sign-in: url', pg.url.split('/')[-1], '| toast:', pg.inner_text('#toast'), '|', pg.inner_text('#storage .summary'))
    pg.goto(U+'#recipes'); pg.wait_for_timeout(500); print('  recipes:', names())
    pg.goto('about:blank'); pg.goto(U+f"#access_token={s['access_token']}&refresh_token={s['refresh_token']}&expires_in=3600&type=recovery"); pg.wait_for_timeout(1200)
    print('10 recovery:', pg.locator('#sb-new').count(), pg.inner_text('#toast')); pg.fill('#sb-new','newpassword1'); pg.click('#sb-newpass button'); pg.wait_for_timeout(500); print('  ', msg(), users['stu@example.com']['password'])
    print('overflow', pg.evaluate('document.documentElement.scrollWidth > innerWidth'), errs); b.close()
