# Browser test for the github integration, run against a simulated service (no real account needed).
# Needs: Python Playwright, Google Chrome at /usr/bin/google-chrome, and the app served on port 8765:
#   python3 -m http.server 8765   (from the repo root, in another terminal)
#   python3 tests/browser/github.py
# It prints one line per check; read the output, there are no assertions on the UI text.
import os
import json, base64, urllib.parse, hashlib
from playwright.sync_api import sync_playwright
files={}  # path -> text
seed=open(os.path.join(os.path.dirname(__file__), '..', '..', 'recipes', 'house-pale-ale.json')).read().replace('House Pale Ale','Repo Bitter')
files['recipes/repo-bitter.json']=seed
sha=lambda t: hashlib.sha1(t.encode()).hexdigest()
log=[]
CORS={'access-control-allow-origin':'*','access-control-allow-headers':'*','access-control-allow-methods':'*'}
def J(route, status, body): route.fulfill(status=status, content_type='application/json', body=json.dumps(body), headers=CORS)
def gh(route):
    r=route.request; u=urllib.parse.urlparse(r.url); path=u.path
    if r.method=='OPTIONS': return route.fulfill(status=204, headers=CORS)
    log.append(f'{r.method} {path}')
    if path=='/repos/stu/data': return J(route,200,{"default_branch":"main","private":True,"permissions":{"push":True}})
    assert path.startswith('/repos/stu/data/contents/'), path
    assert r.headers.get('authorization')=='Bearer TOKEN'
    fp=path.split('/contents/')[1]
    if r.method=='GET':
        if fp in files: return J(route,200,{"sha":sha(files[fp]),"content":base64.encodebytes(files[fp].encode()).decode(),"type":"file","name":fp.split('/')[-1]})
        kids=[f for f in files if f.startswith(fp+'/')]
        if kids: return J(route,200,[{"type":"file","name":f.split('/')[-1],"sha":sha(files[f])} for f in kids])
        return J(route,404,{"message":"Not Found"})
    body=json.loads(r.post_data)
    if r.method=='PUT':
        if fp in files and body.get('sha')!=sha(files[fp]): return J(route,409,{"message":"sha mismatch"})
        files[fp]=base64.b64decode(body['content']).decode(); log.append('  msg: '+body['message']); return J(route,200,{"content":{"sha":sha(files[fp])}})
    if r.method=='DELETE': files.pop(fp,None); log.append('  msg: '+body['message']); return J(route,200,{})
with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    pg = b.new_page(viewport={'width':390,'height':844}, device_scale_factor=2)
    errs=[]; pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.route('https://api.github.com/**', gh)
    U='http://localhost:8765/'
    chip=lambda: pg.inner_text('#sync-chip')
    names=lambda: pg.eval_on_selector_all('#recipe-list .q-row','o=>o.map(x=>x.querySelector("strong").textContent+(x.querySelector("em")?" ("+x.querySelector("em").textContent+")":""))')
    pg.goto(U); pg.wait_for_timeout(1300)
    pg.goto(U+'#settings/storage'); pg.wait_for_timeout(300); pg.click('[data-act=mode][data-v=git]'); pg.wait_for_timeout(200)
    pg.fill('#gh-repo','stu/data'); pg.fill('#gh-token','TOKEN'); pg.click('[data-act=connect]'); pg.wait_for_timeout(1500)
    print('connect:', pg.inner_text('#storage-msg'), '| chip:', chip())
    pg.goto(U+'#recipes'); pg.wait_for_timeout(500); print('list:', names())
    pg.click('#sync-chip'); pg.wait_for_timeout(1500); print('commit all:', chip(), '| toast:', pg.inner_text('#toast'), '| files:', sorted(files))
    pg.goto(U+'#recipe/repo-bitter'); pg.wait_for_timeout(1300); print('editor:', pg.inner_text('#save-btn'))
    pg.fill('#f-name','Repo Bitter 2'); pg.wait_for_timeout(3200); print('no autosave in git mode:', pg.inner_text('#save-btn'), chip())
    files['recipes/repo-bitter.json']=files['recipes/repo-bitter.json'].replace('"carbonation": 2.4','"carbonation": 2.5')  # someone else changed it
    pg.click('#save-btn'); pg.wait_for_timeout(1200); print('commit one (after a remote change):', pg.inner_text('#save-btn'), '| name in repo:', json.loads(files['recipes/repo-bitter.json'])['beerjson']['recipes'][0]['name'])
    pg.click('[data-act=delete]'); pg.click('[data-act=delete]'); pg.wait_for_timeout(400); pg.click('#sync-chip'); pg.wait_for_timeout(1200); print('delete committed:', sorted(files))
    pg.reload(); pg.wait_for_timeout(1500); print('reload: chip', chip(), names())
    print('\n'.join(l for l in log if 'msg' in l)); print(errs); b.close()
