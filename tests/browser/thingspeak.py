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
    dmsg = lambda: pg.inner_text('#devices [role=status]')
    pg.goto(U); pg.wait_for_timeout(1300)
    # Settings -> Devices: set up the iSpindel once.
    pg.goto(U+'#settings/devices'); pg.wait_for_timeout(400)
    print('devices page:', pg.inner_text('#devices'))
    pg.click('[data-act=add-device]'); pg.wait_for_timeout(200)
    pg.click('[data-act=dev-test]'); pg.wait_for_timeout(200); print('no channel:', dmsg())
    pg.fill('#f-devices-0-channel','999'); pg.click('[data-act=dev-test]'); pg.wait_for_timeout(500); print('bad channel:', dmsg())
    pg.fill('#f-devices-0-channel','123'); pg.click('[data-act=dev-test]'); pg.wait_for_timeout(500); print('no key:', dmsg())
    pg.fill('#dv-key-0','SECRET'); pg.click('[data-act=dev-test]'); pg.wait_for_timeout(600); print('test ok:', dmsg())
    print('field picks:', pg.eval_on_selector_all('#devices select','o=>o.map(s=>s.id+"="+s.value+" ("+s.options.length+" options)")'))
    settings = pg.evaluate("JSON.parse(localStorage.getItem('gyle.cache.v1')).settings.settings.data")
    print('device saved:', settings.get('devices'), '| key in settings:', 'SECRET' in json.dumps(settings))
    # A brew picks the device.
    pg.goto(U+'#recipe/house-pale-ale'); pg.wait_for_timeout(1200)
    pg.click('[data-act=brew]'); pg.wait_for_timeout(400)
    pg.fill('#f-brewDate', (now - datetime.timedelta(days=6)).strftime('%Y-%m-%d')); pg.fill('#f-measured-og','1.051')
    print('picker:', pg.eval_on_selector_all('#dev-pick option','o=>o.map(x=>x.textContent)'), '| count:', pg.inner_text('#sec-device .count'))
    pg.select_option('#dev-pick', label='iSpindel'); pg.wait_for_timeout(700); print('ok:', msg())
    print('url:', seen[-1][:140])
    print('head:', pg.inner_text('#sec-device .count'), '| summary:', pg.inner_text('#sec-device .summary').replace('\n',' | '))
    print('pva FG row:', pg.inner_text('#pva tbody tr:nth-child(3)').replace('\t',' '), '| abv:', pg.inner_text('#pva tbody tr:nth-child(4)').replace('\t',' '))
    print('chart hint:', pg.inner_text('#dev-chart .hint'), '| panels:', pg.locator('#dev-chart svg').count(), '| readout:', pg.inner_text('#dev-chart .readout'), '| save:', pg.inner_text('#save-btn'))
    stored = pg.evaluate("JSON.parse(localStorage.getItem('gyle.cache.v1')).brews"); bid=list(stored)[0]
    pg.wait_for_timeout(600); stored = pg.evaluate("JSON.parse(localStorage.getItem('gyle.cache.v1')).brews"); d=stored[bid]['data']
    print('saved deviceId:', d.get('deviceId'), '| old device field:', d.get('device'), '| n:', len(d.get('deviceReadings',[])), '| first/last:', d['deviceReadings'][0], d['deviceReadings'][-1], '| key in brew file:', 'SECRET' in json.dumps(d))
    pg.locator('#sec-device').scroll_into_view_if_needed(); pg.evaluate("window.scrollBy(0,-70)"); pg.wait_for_timeout(200); None
    pg.locator('#dev-chart').scroll_into_view_if_needed(); pg.wait_for_timeout(200); None
    pg.select_option('#f-status','fermenting'); n0=len(seen); pg.reload(); pg.wait_for_timeout(1500); print('auto-fetch on open:', len(seen)-n0, '|', msg())
    # A brew linked before devices existed (channel stored on the brew) gets a device of its own.
    bid0 = pg.evaluate('location.hash'); pg.wait_for_timeout(800); pg.goto(U+'README.md')  # outside the app, so it cannot write its copy back
    pg.evaluate("""()=>{const c=JSON.parse(localStorage.getItem('gyle.cache.v1'));const s=c.settings.settings.data;s.devices=[];const b=c.brews[Object.keys(c.brews)[0]].data;delete b.deviceId;b.device={type:'thingspeak',channel:'456',gravityField:'4',tempField:''};localStorage.setItem('gyle.cache.v1',JSON.stringify(c))}""")
    pg.goto(U+bid0); pg.wait_for_timeout(1200)
    c = pg.evaluate("JSON.parse(localStorage.getItem('gyle.cache.v1'))"); bd = list(c['brews'].values())[0]['data']
    print('old link moved:', c['settings']['settings']['data'].get('devices'), '| brew deviceId:', bd.get('deviceId'), '| brew device field gone:', 'device' not in bd, '| picker:', pg.eval_on_selector('#dev-pick','s=>s.selectedOptions[0].textContent'))
    print('overflow', pg.evaluate('document.documentElement.scrollWidth > innerWidth'), errs); b.close()
