# Gyle

A personal homebrew app for Stuart (GitHub: shaslam): recipe design, brew tracking, brewing
calculators. Static site, no build step, no dependencies, no framework. Live at
https://shaslam.github.io/gyle/ (GitHub Pages from the public `shaslam/gyle` repo).

This file is the handoff from the chat session where the app was first built. README.md is
the user-facing guide; this is the working context.

## Run and test

```
python3 -m http.server 8000        # then open http://localhost:8000 (ES modules need http, not file://)
node tests/calc.test.mjs           # brewing maths, BeerJSON round trip, water and mash pH
python3 tests/browser/supabase.py  # browser tests against simulated services; see the header of each file
python3 tests/browser/native.py    # the web files in Android-app mode, with a fake GyleNative object
python3 tests/browser/ios.py       # the web files in iOS-app mode, in Playwright's WebKit, with the real ios/bridge.js
cd android && ./gradlew assembleDebug lintDebug   # the Android app (needs android/local.properties with sdk.dir)
node --experimental-websocket tests/android/device.mjs   # the app on an emulator; Node 22+ needs no flag
```

The browser tests need Python Playwright (`pip install playwright` in a virtual environment), Google Chrome, and the app served on port 8765.

Always run `node tests/calc.test.mjs` after touching `js/calc.js`, `js/data.js` or `js/beerjson.js`.

The Android app and the iOS app pack the web files at build time. After a change to `index.html`, `css/`, `js/` or `fonts/`, an app shows it only after a new build and install. A new top-level web file or folder must also be added to `sitePaths` in `android/app/build.gradle` and to `ios/copy-web-files.sh`, or the page gets a 404 for it inside the app.

## Ground rules

- Plain ES modules, hand-written HTML strings, one stylesheet. Do not add a framework, bundler or npm dependency without asking.
- Everything is metric internally and in the UI: litres, kg, g, °C, EBC (SRM is shown alongside in places).
- Recipes are stored as BeerJSON 1.0. App-only fields go under `x_` keys (`x_use`, `x_temp`, `x_mash_ratio`, `x_equipment`, `x_status`, `x_water`, and for versions `x_family`, `x_version`, `x_version_note`, `x_based_on`, and `x_pump_clip`). Keep the round trip in the tests passing.
- The app must stay usable on a phone at about 390 px wide with no sideways scroll.
- No `alert`/`confirm`/`prompt`: destructive buttons use the two-tap `confirmTap` helper.
- UK spelling in UI text ("colour"). Plain, short labels.
- Commit author for this repo: `stuart@bozon.net` (set with `git config user.email` in the repo).

## How the code is laid out

| File | What it does |
|---|---|
| `index.html` | Shell: header, tab bar, `#view`, toast |
| `css/app.css` | All styling. Tokens at the top. Later sections were appended as features landed, so some rules override earlier ones lower down the file |
| `js/app.js` | Every screen. One `ctx` object per view; `#view` has delegated `input`/`change`/`click`/`submit` listeners that call into `ctx` |
| `js/calc.js` | Pure maths: OG/FG/ABV, Tinseth IBU, Morey colour, water volumes, tools, salts, mash pH |
| `js/data.js` | Reference data: BJCP 2021 styles, fermentables (with substitution `group`), hops (alpha, `group`, 8-axis `aroma`), yeasts, water targets |
| `js/beerjson.js`, `js/beerxml.js`, `js/units.js` | Format converters. Internal recipe model <-> BeerJSON; BeerXML import/export |
| `js/brewfather.js` | Brewfather complete backup (`backup.json` in a zip) -> recipes, brew logs, equipment and water profiles. Pure: `importBrewfather()` in `app.js` stores the result. Ids are `bf-…` from the Brewfather id, so a second import skips what is there |
| `js/unzip.js` | Minimal zip reader (stored and deflate entries, via `DecompressionStream`) |
| `js/store.js` | Local working copy (localStorage) and syncing. Backend-agnostic |
| `js/photos.js` | Brew photos: IndexedDB copy of each JPEG (`{ id, blob, owner, deleted }`), `shrink()` to 1600 px, `flush(backend)` uploads and deletes. `store.push()` and `store.sync()` call it. A photo error does not stop documents saving. Backends add `putFile`/`getFile`/`removeFile`. Git uses `photos/<id>.jpg`, Supabase uses the Storage bucket `photos` with one folder per user id |
| `js/backend-git.js` | Storage backend: GitHub contents API, one commit per save |
| `js/backend-supabase.js` | Storage backend: Supabase Auth + a `documents` table over plain `fetch` (no SDK) |
| `js/config.js` | Supabase project URL and public key (filled in, so Settings does not ask for them) |
| `js/native.js` | `native`: the `GyleNative` object of the Android or iOS app, or null in a browser. Every app-only branch in the web code tests this. `ios` is true in the iOS app only (`native.platform === 'ios'`). Also `APP_LINK` (`gyle://auth`) |
| `js/demo.js` | `demoData()`: four recipes and four brew logs for the demo of the apps, with dates counted back from today. `loadDemo()` in `app.js` adds the recipe snapshot, equipment and checklist to each brew |
| `js/picker.js` | `pickSelects()`: in the Android and iOS apps, a tap on any single `<select>` opens a `dialog.choose` popup with `.pick` rows in place of Android's list. It sets the select and sends `input` and `change`, so screens need no changes |
| `android/` | The Android app. Plain Java, no libraries, one Activity with a WebView. See "Android app" below |
| `ios/` | The iOS app. Plain Swift (UIKit), no libraries, one view controller with a WKWebView. See "iOS app" below |
| `.github/workflows/ios-build.yml` | Builds `ios/` for the simulator on a GitHub Mac (push under `ios/`, or by hand). The only compile check there is without a Mac |
| `js/brewsheet.js` | Brew sheet: `sheetHtml(model)` and `sheetPdf(model)` draw the same description. `sheetModel()` in `app.js` builds it |
| `js/pdf.js` | Minimal PDF writer: A4 pages, Helvetica and Helvetica-Bold (not embedded, WinAnsi only), text, lines, boxes, shapes |
| `js/timer.js` | Brew-day timer, alerts, notifications, wake lock |
| `js/sources.js` | Reading sources for automatic gravity readings (ThingSpeak, for an iSpindel) |
| `fonts/` | Self-hosted Alfa Slab One, Archivo (variable width and weight) and IBM Plex Mono, Latin subsets, with their OFL licence texts. `@font-face` rules are at the top of `css/app.css` |
| `sw.js` | Minimal service worker so Android can show timer notifications. Caches nothing |
| `supabase/setup.sql` | Database setup for the Supabase backend |
| `.github/workflows/supabase-keepalive.yml` | Optional heartbeat so a free Supabase project is not paused |

### Android app

`android/` is a Gradle project (Android Gradle plugin 9.5.1, Gradle 9.9.1 wrapper, compileSdk and targetSdk 36, minSdk 29, package `io.github.shaslam.gyle`). The `webFiles` task in `app/build.gradle` copies the web files into `assets/www/`. `MainActivity` serves them to the WebView from `https://appassets.androidplatform.net/` through `shouldInterceptRequest`, so ES modules, localStorage, IndexedDB and the CSP work as on the website. Other hosts go to the network. Navigation to another host opens the phone's browser.

- **Storage**: `store.init()` forces mode `supabase` when `native` is set, and Settings → Storage shows no mode buttons. The git backend is still in the bundle but nothing reaches it.
- **Welcome and demo** (the two apps only): Stuart found it not obvious that the app needs a sign-in, and asked for a clear split between a demo and real use (2026-11-13). `route()` shows `welcomeView()` for every address while `mustChoose()` is true (native, not signed in, not in the demo). It has two cards: the sign-in form, and **Open the demo**. `store.startDemo()` loads `js/demo.js` and sets `store.demo` (kept in `gyle.storage.v1`). In the demo the chip says "Demo" and `#demo-bar` (a gold strip in `index.html`) shows on every screen and leads to `#welcome`. `store.adopt()` removes the demo at sign-in, so demo data never reaches an account. Sign-out and a session that ran out go back to the welcome screen. The website has none of this: it still seeds one example recipe and treats "This device" as real use.
- **Sign-in form**: `signInForm()` and `signInActions()` in `app.js` serve Settings → Storage and the welcome screen. The "Continue with" buttons come from `store.account.providers`: `loadProviders()` asks `/auth/v1/settings` which services the project has on and keeps the answer in `gyle.supabase.providers`. A service that is off has no button. On 2026-11-13 the real project had only email on, which is why GitHub and Google sign-in failed for Stuart ("Unsupported provider: provider is not enabled").
- **Bridge**: `Bridge.java` is exposed as `window.GyleNative`: `saveFile`, `print`, `setAlarms`, `showAlert`, `notifyStatus`, `askToNotify`, `keepAwake`, `openExternal`. `js/native.js` documents the contract. Keep the two files in step.
- **Timer alerts**: the WebView has no Notification API, and Android stops the page in the background. `plan()` in `timer.js` runs on every `save()` and hands the app the alerts still to come. `Alarms.java` keeps the list in SharedPreferences and sets one `setAlarmClock` alarm for the earliest. The page also raises each alert through `showAlert` while it is open. Both use the same key (`brewId|segment|endsAt|minutes or end`), and the app shows a key once.
- **Sign-in links**: in the app `redirect_to` is `gyle://auth`. The manifest routes that link to `MainActivity`, which loads `index.html#<the link's fragment>`. The `hashchange` listener in `app.js` runs `arrive()`, so a page that is already open signs in.
- **Files**: `onShowFileChooser` builds its own chooser. A request for images only also offers the camera, which writes into the cache through the `CameraFiles` provider. Downloads go to MediaStore Downloads.
- **Insets**: from Android 11 the Activity draws edge to edge and sizes a green band (status bar) and a tan band (navigation bar or keyboard) itself. Android 10 uses the theme colours.
- **Popups**: Stuart found Android's list for a `<select>` ugly (2026-11-13), so `js/picker.js` replaces it in the app. Date fields still open Android's date dialog, which the theme `Gyle.Dialog` styles as a cream panel with a green heading. Back first closes the top `dialog[open]` in the page (`CLOSE_POPUP` in `MainActivity`), then goes back in history.
- In the windowed emulator, Google's keyboard can show a "Try out your stylus" sheet in place of the keys. The keyboard check of the device test then reports no change in page height. It passed with `-no-window`.
- The WebView keeps the screen on while a debugger is attached. Read the `KEEP_SCREEN_ON` flag only with the debugger detached (the device test does this).

The Android SDK is in `~/Android/Sdk` (installed 2026-11-13 with Stuart's approval, including the emulator and the AVD `gyle-test`, Android 16). Start it with `~/Android/Sdk/emulator/emulator -avd gyle-test -no-window -no-audio -no-snapshot -gpu swiftshader_indirect`.

### iOS app

`ios/` is an Xcode project written by hand on Linux (2026-11-13). No Mac was available. The workflow `ios-build.yml` compiled it for the simulator with Xcode 26.6 on the first push, with no Swift warnings. **Nobody ran it yet**, on a simulator or a phone, so treat the first run as the first test. After a change under `ios/`, push and read that workflow's result (`gh run watch`): it is the compile check. `Gyle.xcodeproj` uses a synchronized folder (Xcode 16+, `objectVersion = 77`), so a new file in `ios/Gyle/` needs no project edit. `Info.plist`, `bridge.js` and `copy-web-files.sh` are outside that folder on purpose: Xcode would treat a `.js` file in it as source code, and a second Info.plist as a clash. Deployment target iOS 16.4 (`DecompressionStream` for the Brewfather import needs it), Swift 5 language mode, bundle id `io.github.shaslam.gyle`.

- **Page address**: `WebFiles.swift` is a `WKURLSchemeHandler` for `gyle-app://local/`. It serves `www/` from the app bundle. When it serves `index.html` it adds `gyle-app:` after each `'self'` in the CSP, in case WebKit does not count the custom scheme as `'self'`.
- **Bridge**: `ios/bridge.js` is a user script that runs at document start. It builds `GyleNative` with the same methods as Android plus `platform: 'ios'`. Methods with no answer go through `webkit.messageHandlers.gyle.postMessage({ name, args })`. `saveFile` and `notifyStatus` must answer at once, so they call `prompt('gyle-native', json)`, and `WebScreen` answers in the prompt delegate without showing anything. `Bridge.swift` does the work.
- **Delegates use the `async` forms** (`decidePolicyFor`, the prompt panel, `willPresent`). The completion-handler forms changed their attributes between SDKs, and a method that "nearly matches" is silently never called. Calls to `UIApplication.open` and `evaluateJavaScript` stay in plain (not async) functions, because inside async code Swift picks their async overloads.
- **Files**: no Downloads folder on iOS. `saveFile` writes to `tmp/export/`, then shows a PDF in `QLPreviewController` and any other file in the share sheet. The page shows no "Saved in Downloads" toast when `ios` is true. File and photo choosers are WKWebView's own (the camera needs `NSCameraUsageDescription`, which is set).
- **Timer alerts**: `Alerts.swift` hands each alert to `UNUserNotificationCenter` with the alert key as the identifier. `planned` (key → time) and `shown` (keys) are in UserDefaults. `show()` skips a key that iOS already delivered, and replaces one that still waits. `set()` leaves alone an alert that is past its time.
- **Layout**: a green band behind the status bar. The web view runs from the safe area's top to the bottom edge of the screen. `bridge.js` adds `viewport-fit=cover, maximum-scale=1` to the viewport, so `env(safe-area-inset-bottom)` works (the tab bar, `body` and `#toast` use it) and iOS does not zoom in on small fields. Scroll bounce is off.
- **Sign-in links**: `gyle://auth` is in `CFBundleURLTypes`. `SceneDelegate` passes a link to `WebScreen.open(link:)`, which sets `location.hash` on the open page (or loads `index.html#…` at a cold start).
- **Popups**: the same `js/picker.js` as Android. `open()` calls `sel.blur()` first, in case iOS opens its own list for a focused select.
- `tests/browser/ios.py` needs Playwright's WebKit. On this machine WebKit lacked `libgstreamer-plugins-bad1.0-0` and there is no root access: the libraries from that package were copied into `~/.cache/ms-playwright/webkit-*/minibrowser-wpe/sys/lib/`, and the test runs with `PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1`.

### Storage model

`store.docs[kind][id] = { data, sha, dirty, deleted }` for kinds `recipes`, `brews`, `settings`.
`sha` is the backend's version string (git blob sha, or Supabase `updated_at`). A backend
implements `id`, `ready`, `canWrite`, `auto`, `words`, `list(kind)`, `read(kind, id)`,
`write(...)`, `remove(...)`. Git saves on an explicit commit; Supabase auto-saves about 2.5 s
after the last edit. `store.adopt()` re-queues the whole working copy when the backend
changes (this is how data migrates between backends); `store.wipe()` runs on sign-out.

### Recipe versions

Each version is its own recipe document. Versions share `family` (the id of version 1) and
count up in `version`. Old recipes without these fields are version 1 of a family named after
their own id (`familyOf()`, `versionOf()` in `app.js`). Lists show only the newest version per
family (`latestOnly()`), and the brew queue keeps the newest version's id (`swapInQueue()`).
A recipe started from another one gets a new family and `basedOn: { id, name, version }`.

### Brew photos and timeline

A brew log has `timeline: [{ id, t, text, stage?, photo?: { id, w, h } }]` (`t` is a local
`datetime-local` value) and `pumpClip: { id, w, h }`. A recipe also has `pumpClip`, stored as
`x_pump_clip`. `setRecipeClip()` gives every version of the recipe the same clip. A brew without
a clip shows its recipe's clip (`clipOf()`), and the recipe snapshot in a brew holds no clip.
Several documents can use one photo id, so `dropPhoto()` removes a file only when no recipe and
no brew uses it.
`notesToTimeline()` moves the dated notes of older Brewfather imports into the timeline.

### Hydrometer devices

`settings.devices: [{ id, name, type: 'thingspeak', channel, gravityField, tempField }]`, edited
in Settings → Devices. A brew stores `deviceId` and its hourly `deviceReadings`. The ThingSpeak
read key is in localStorage only, as `gyle.tskey.<channel>`. Brews from before devices existed
held `device: { channel, … }`. `adoptOldDevice()` turns that into a settings device on open.

### Settings document

`settings/settings` holds `profiles` + `defaultProfile` (equipment), `waters` + `defaultWater`, `devices`,
and `brewOrder` (the draggable brew queue: recipe ids, next brew first). `queued()` sorts by
status first (ready, planning, archived) and by `brewOrder` inside each status, so the list draws
one draggable group per status. `setStatus()` changes every version of a recipe and moves it to the
bottom of its new group. Archived recipes are hidden from the queue and the brew picker. Recipes
from a Brewfather backup arrive archived.

## What has and has not been verified

Verified in a real browser against **simulated** services (see `tests/browser/`): Supabase
sign-up/sign-in/refresh/sign-out/recovery, autosave, per-user isolation; GitHub connect,
commit, conflict retry, delete; ThingSpeak fetch, hourly down-sampling, stable-gravity flag.

Verified on the Android 16 emulator (WebView 133) with `tests/android/device.mjs`: start, sign-up and autosave against a simulated Supabase, export and PDF to Downloads, print screen, notification permission, exact alarm set and cancelled, an alert shown while the app process was stopped, no second copy of that alert on reopen, screen kept on, Back, `gyle://auth` sign-in, camera photo into the timeline and uploaded, recipe import from the file picker, keyboard resize.

Verified in Playwright's WebKit 27.2 with `tests/browser/ios.py`: the website starts with no error, and the page with the real `ios/bridge.js` does sign-up, autosave, the Gyle popup for a select, export, brew sheet print and PDF, timer alarms and keys, and a sign-in link set through `location.hash`. The Swift side is a stand-in in that test.

**Never run against the real thing, so expect teething problems:**

- The whole iOS app: it compiles (GitHub, Xcode 26.6) but was never run on a simulator or a phone. Unknowns to look at first: `'self'` in the CSP under `gyle-app:`, localStorage and IndexedDB under that scheme, `env(safe-area-inset-bottom)`, whether `mousedown` `preventDefault` stops the iOS select list, print layout from `viewPrintFormatter()`, and alert timing.
- The Android app on Android 10 to 15. Stuart installed the first build on his own phone on 2026-11-13 and said it works well (sign-in with email worked). The emulator is Android 16.
- The Android app against the real Supabase project. `gyle://auth` must be added to the project's Redirect URLs for email links and GitHub/Google sign-in to return to the app.
- Timer alarms on a phone with a maker's battery saver (the emulator has none), and the alarm after a restart of the phone.

- `supabase/setup.sql` has never been executed on a real project.
- Supabase Auth and REST calls (endpoint shapes, publishable-key behaviour, error formats).
- GitHub commits with a real token (Stuart was about to try this).
- ThingSpeak from a browser (assumes its API allows cross-origin reads).
- Timer notifications on a real phone.

### Brewfather backup, what is in it

`data.recipes` (colours in SRM, hop `use` Boil / First Wort / Aroma (= hopstand) / Dry Hop, `temp` often
null: the equipment's `hopstandTemperature` applies), `data.batches` (notes, measured values, a
recipe snapshot), `data.profiles` (equipment, water), `data.inventory`, and
`completeBackup.documents` (Firestore paths: `batches/<id>/readings_accumulated/…` hold iSpindel
readings every 15 min, `recipes/<id>/users_recipes_versions/…` hold version snapshots).
`settings.recipe.fg` holds Brewfather's FG mash-temperature slope (centre 67.5 °C). Stuart's
iSpindel posts to Brewfather (`data/iSpindel` documents), which matters for the iSpindel plan below.
Gyle gives 0 IBU to 0-minute boil hops. Brewfather gives them some, so imported recipes with them read lower in Gyle.

## Things flagged to Stuart as "from memory, check them"

- BJCP style ranges, fermentable potentials/colours, hop alphas, yeast attenuations, water target profiles in `js/data.js`.
- Hop aroma scores are a subjective reading, not supplier data. He asked where real data could come from (Yakima Chief, BarthHaas, Beer Maverick); the suggestion on the table is to make hops user-editable and move to the standard aroma categories.
- Mash pH is a simple charge-balance model (`MASH_BUFFER = 45 mEq/kg/pH` in `calc.js`). Suggested doses may run high; calibrate against his meter readings when he has some.
- He thought 6.0% ABV was too high for 5.2 kg in 21 L at 72%. The maths was checked and is right for those inputs (US-05 at 81% attenuation, 21 L into the fermenter, brewhouse efficiency). He was going to send a Brewfather BeerXML export plus Brewfather's stats and equipment profile for a side-by-side comparison. That has not happened yet.

## Where things stand and what is next

1. **Supabase**: Stuart is creating an account. Next: run `setup.sql`, set the Auth Site URL to `https://shaslam.github.io/gyle/`, sign up in the app, fix whatever breaks. Then put the project URL and public key in `js/config.js`.
2. **Repos**: GitHub Pages only serves public repos on the free plan, so the app repo is public. If he keeps using git storage, data goes in a separate private repo set in Settings.
3. **iSpindel**: stock firmware. He needs to check whether its Service Type list offers ThingSpeak; if not, reflash to GravityMon. Then add it in Settings → Devices and choose it on a brew log.
4. **Token trust**: he found a pasted GitHub token stored in localStorage "dodgy". Proper "Sign in with GitHub" needs a small server-side function to hold a client secret; parked as too much for now. The cheap hardening is done: `index.html` has a Content-Security-Policy meta tag that limits connections to GitHub, `*.supabase.co` and ThingSpeak, and the fonts are served from `fonts/`. A new outside service, or a self-hosted Supabase, needs its host added to `connect-src`.
5. **Offered but not built**: RO-water dilution in the Water card; moving a recipe to the bottom of the brew queue when a brew is started from it; an SRM-first display setting; sparge-water acidification.

All four ingredient lists (fermentables, hops, yeast, other additions) now use compact rows: tap the name for a popup, edit the amount inline. Only fermentables and hops offer substitutes in their popups.

## Design direction

"Beer mats on kraft board": tan background, cream panels with a printed keyline, bottle-green
header and tab bar, amber primary buttons, slab display type. Every beer gets a pint glass
filled with its calculated colour; the timer drains a pint. The actions under a recipe and a brew log are one row of icon buttons with short labels (`tile()` and `ICONS` in `app.js`), because he found the rows of text buttons messy (2026-11-13). Export asks for the format in a popup. A brew starts from a recipe, or from **Brew again** on a brew log: the Brews page has no start control. The sync chip is a light with no words when it has nothing to ask of him (he found "In sync" too much like a developer tool, 2026-11-13): green, flashing gold, steady gold, red. `drawChip()` keeps the words in a `.sr` span, so tests and screen readers still read them. A press syncs and `#sync-tip` says how it went. A press on red shows the reason first. The brew queue needs a 300 ms hold before a finger can drag a handle (`HOLD_MS` in `enableReorder()`), because he moved recipes by accident while he scrolled. A mouse drags at once. The status stamps (`.pill`) are not on the cards of the brew queue, because the group heading says the status already (his request, 2026-11-13). A list in another order keeps them. On the recipe page the status is one stamp (`.status-stamp`) that opens a menu (`status-menu` action), in place of the three buttons that were there. He asked for smaller type and less
green/less dark than earlier versions, so keep it light and do not enlarge headings.
