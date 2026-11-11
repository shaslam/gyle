# Browser test for the thingspeak integration, run against a simulated service (no real account needed).
# Needs: Python Playwright, Google Chrome at /usr/bin/google-chrome, and the app served on port 8765:
#   python3 -m http.server 8765   (from the repo root, in another terminal)
#   python3 tests/browser/thingspeak.py
# It prints one line per check; read the output, there are no assertions on the UI text.
import os
import json, math, datetime
from playwright.sync_api import sync_playwright
# A fake ThingSpeak channel: 6 days of 15-minute iSpindel readings in Plato, fermenting from 12.6 °P down to 2.6 °P then flat.
now = datetime.datetime.utcnow().replace(microsecond=0)
feeds=[]
start = now - datetime.timedelta(days=6)
for i in range(6*96):
    t = start + datetime.timedelta(minutes=15*i); d = i/96
    plato = 2.6 + 10.0*math.exp(-1.6*d) if d < 3.5 else 2.6 + 10.0*math.exp(-1.6*3.5)
    feeds.append({"created_at": t.strftime('%Y-%m-%dT%H:%M:%SZ'), "entry_id": i+1, "field1": f"{45-d*3:.2f}", "field2": f"{19.5+0.4*math.sin(i/20):.2f}", "field3": f"{4.1-d*0.02:.3f}", "field4": f"{plato:.3f}", "field5": "900", "field6": "-60"})
body={"channel":{"id":123,"name":"iSpindel","field1":"tilt","field2":"temperature","field3":"battery","field4":"gravity","field5":"interval","field6":"rssi"},"feeds":feeds}
seen=[]
def handle(route):
    seen.append(route.request.url)
    if 'channels/999' in route.request.url: return route.fulfill(status=404, body='{}')
    if 'channels/123' in route.request.url and 'api_key=SECRET' not in route.request.url: return route.fulfill(status=200, content_type='application/json', body='-1', headers={'access-control-allow-origin':'*'})
    route.fulfill(status=200, content_type='application/json', body=json.dumps(body), headers={'access-control-allow-origin':'*'})
with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    pg = b.new_page(viewport={'width':390,'height':844}, device_scale_factor=2)
    errs=[]; pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.route('https://api.thingspeak.com/**', handle)
    U='http://localhost:8765/'
    msg = lambda: pg.inner_text('#sec-device [role=status]')
    pg.goto(U); pg.wait_for_timeout(1300); pg.goto(U+'#recipe/house-pale-ale'); pg.wait_for_timeout(1200)
    pg.click('[data-act=brew]'); pg.wait_for_timeout(400)
    pg.fill('#f-brewDate', (now - datetime.timedelta(days=6)).strftime('%Y-%m-%d')); pg.fill('#f-measured-og','1.051')
    pg.click('[data-act=dev-fetch]'); pg.wait_for_timeout(200); print('no channel:', msg())
    pg.fill('#dev-channel','999'); pg.click('[data-act=dev-fetch]'); pg.wait_for_timeout(400); print('bad channel:', msg())
    pg.fill('#dev-channel','123'); pg.click('[data-act=dev-fetch]'); pg.wait_for_timeout(400); print('no key:', msg())
    pg.fill('#dev-key','SECRET'); pg.click('[data-act=dev-fetch]'); pg.wait_for_timeout(600); print('ok:', msg())
    print('url:', seen[-1][:140])
    print('head:', pg.inner_text('#sec-device .count'), '| summary:', pg.inner_text('#sec-device .summary').replace('\n',' | '))
    print('pva FG row:', pg.inner_text('#pva tbody tr:nth-child(3)').replace('\t',' '), '| abv:', pg.inner_text('#pva tbody tr:nth-child(4)').replace('\t',' '))
    print('chart hint:', pg.inner_text('#chart .hint'), '| save:', pg.inner_text('#save-btn'))
    stored = pg.evaluate("JSON.parse(localStorage.getItem('gyle.cache.v1')).brews"); bid=list(stored)[0]
    pg.wait_for_timeout(600); stored = pg.evaluate("JSON.parse(localStorage.getItem('gyle.cache.v1')).brews"); d=stored[bid]['data']
    print('saved device:', d.get('device'), '| n:', len(d.get('deviceReadings',[])), '| first/last:', d['deviceReadings'][0], d['deviceReadings'][-1], '| key in brew file:', 'SECRET' in json.dumps(d))
    pg.locator('#sec-device').scroll_into_view_if_needed(); pg.evaluate("window.scrollBy(0,-70)"); pg.wait_for_timeout(200); None
    pg.locator('#chart').scroll_into_view_if_needed(); pg.wait_for_timeout(200); None
    pg.select_option('#f-status','fermenting'); n0=len(seen); pg.reload(); pg.wait_for_timeout(1500); print('auto-fetch on open:', len(seen)-n0, '|', msg())
    print('overflow', pg.evaluate('document.documentElement.scrollWidth > innerWidth'), errs); b.close()
