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
```

The browser tests need Python Playwright (`pip install playwright` in a virtual environment), Google Chrome, and the app served on port 8765.

Always run `node tests/calc.test.mjs` after touching `js/calc.js`, `js/data.js` or `js/beerjson.js`.

## Ground rules

- Plain ES modules, hand-written HTML strings, one stylesheet. Do not add a framework, bundler or npm dependency without asking.
- Everything is metric internally and in the UI: litres, kg, g, °C, EBC (SRM is shown alongside in places).
- Recipes are stored as BeerJSON 1.0. App-only fields go under `x_` keys (`x_use`, `x_temp`, `x_mash_ratio`, `x_equipment`, `x_status`, `x_water`, and for versions `x_family`, `x_version`, `x_version_note`, `x_based_on`). Keep the round trip in the tests passing.
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
| `js/config.js` | Supabase project URL and public key (currently empty: typed into Settings instead) |
| `js/brewsheet.js` | Brew sheet: `sheetHtml(model)` and `sheetPdf(model)` draw the same description. `sheetModel()` in `app.js` builds it |
| `js/pdf.js` | Minimal PDF writer: A4 pages, Helvetica and Helvetica-Bold (not embedded, WinAnsi only), text, lines, boxes, shapes |
| `js/timer.js` | Brew-day timer, alerts, notifications, wake lock |
| `js/sources.js` | Reading sources for automatic gravity readings (ThingSpeak, for an iSpindel) |
| `fonts/` | Self-hosted Alfa Slab One, Archivo (variable width and weight) and IBM Plex Mono, Latin subsets, with their OFL licence texts. `@font-face` rules are at the top of `css/app.css` |
| `sw.js` | Minimal service worker so Android can show timer notifications. Caches nothing |
| `supabase/setup.sql` | Database setup for the Supabase backend |
| `.github/workflows/supabase-keepalive.yml` | Optional heartbeat so a free Supabase project is not paused |

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
`datetime-local` value) and `pumpClip: { id, w, h }`. A pinned timeline photo shares its id with
the clip, so a photo file is removed only when neither uses it (`forgetPhoto()` in `brewView`).
`notesToTimeline()` moves the dated notes of older Brewfather imports into the timeline.

### Settings document

`settings/settings` holds `profiles` + `defaultProfile` (equipment), `waters` + `defaultWater`,
and `brewOrder` (the draggable brew queue: recipe ids, next brew first). `queued()` sorts by
status first (ready, planning, archived) and by `brewOrder` inside each status, so the list draws
one draggable group per status. `setStatus()` changes every version of a recipe and moves it to the
bottom of its new group. Archived recipes are hidden from the queue and the brew picker. Recipes
from a Brewfather backup arrive archived.

## What has and has not been verified

Verified in a real browser against **simulated** services (see `tests/browser/`): Supabase
sign-up/sign-in/refresh/sign-out/recovery, autosave, per-user isolation; GitHub connect,
commit, conflict retry, delete; ThingSpeak fetch, hourly down-sampling, stable-gravity flag.

**Never run against the real thing, so expect teething problems:**

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
3. **iSpindel**: stock firmware. He needs to check whether its Service Type list offers ThingSpeak; if not, reflash to GravityMon. Then link a real channel on a brew log.
4. **Token trust**: he found a pasted GitHub token stored in localStorage "dodgy". Proper "Sign in with GitHub" needs a small server-side function to hold a client secret; parked as too much for now. The cheap hardening is done: `index.html` has a Content-Security-Policy meta tag that limits connections to GitHub, `*.supabase.co` and ThingSpeak, and the fonts are served from `fonts/`. A new outside service, or a self-hosted Supabase, needs its host added to `connect-src`.
5. **Offered but not built**: RO-water dilution in the Water card; moving a recipe to the bottom of the brew queue when a brew is started from it; an SRM-first display setting; sparge-water acidification.

All four ingredient lists (fermentables, hops, yeast, other additions) now use compact rows: tap the name for a popup, edit the amount inline. Only fermentables and hops offer substitutes in their popups.

## Design direction

"Beer mats on kraft board": tan background, cream panels with a printed keyline, bottle-green
header and tab bar, amber primary buttons, slab display type. Every beer gets a pint glass
filled with its calculated colour; the timer drains a pint. He asked for smaller type and less
green/less dark than earlier versions, so keep it light and do not enlarge headings.
