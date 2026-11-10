# Gyle

A personal homebrew app: recipe design, brew tracking and brewing calculators.
It is a static web app with no build step and no server. Recipes live in this
repo as BeerJSON files, and every save is a git commit.

## Set up

1. Push this folder to a GitHub repo.
2. In the repo: **Settings → Pages → Deploy from a branch → `main` / root**.
   The app appears at `https://<you>.github.io/<repo>/`.
3. Create a token so the app can commit: GitHub **Settings → Developer settings →
   Fine-grained tokens → Generate new token**. Limit it to this one repo and give it
   **Contents: Read and write**. Nothing else.
4. Open the app, go to **Settings**, paste the token and press **Connect and sync**.
   On GitHub Pages the repo name is filled in for you.

The token is kept in that browser's local storage only. Repeat step 4 on each
device (phone, laptop). A public repo can be read without a token; a private repo
needs the token for reading too (and GitHub Pages on private repos needs a paid plan).

To run it locally instead: `python3 -m http.server` in this folder, then open
`http://localhost:8000`. It must be served over http; opening `index.html` as a
file does not work because the code uses JavaScript modules.

## How saving works

- Edits are written to the browser straight away, so nothing is lost mid-brew.
- **Commit to repo** on a recipe or brew writes that one file as a commit.
  The chip in the header shows how many documents are waiting, and commits them all when tapped.
- On load the app pulls anything that changed in the repo. If the same recipe was edited
  on two devices, the later commit wins; the earlier version is still in git history.

## What is in the repo

```
recipes/<id>.json   one BeerJSON 1.0 document per recipe
brews/<id>.json     one brew log each, with a snapshot of the recipe as brewed
settings.json       your equipment profiles (created the first time you commit them)
js/calc.js          all the brewing maths
js/data.js          styles, malts, hops and yeasts offered in the editor
js/beerjson.js      BeerJSON <-> the app's model
js/beerxml.js       BeerXML import and export
js/store.js         local working copy + GitHub API
js/timer.js         brew-day timer, alerts and notifications
js/sources.js       reading sources for automatic gravity readings (ThingSpeak)
js/app.js           the screens
sw.js               service worker, only so Android can show timer notifications
```

A few things BeerJSON has no field for are stored under `x_` keys in the recipe
files: first-wort / whirlpool hop use (`x_use`), whirlpool temperature (`x_temp`),
mash ratio (`x_mash_ratio`) and the equipment profile id (`x_equipment`). Other software ignores them.

## Brew queue

The recipe list is ordered as a brew queue by default: the top recipe is the one you plan
to brew next. Drag a row by its numbered handle (or focus the handle and use the arrow
keys) to reorder. The order is stored as `brewOrder` in `settings.json`. The Order menu
switches the list to recently edited or by name.

Each recipe is flagged **In planning** or **Ready to brew** (the toggle under its name;
`x_status` in the file). The first ready recipe in the queue is tagged as the next brew,
and the Show menu filters the list by status.

## Equipment profiles

**Settings → Equipment profiles** holds one profile per setup: batch size, efficiency,
boil-off, kettle and mash tun losses, grain absorption, mash ratio. Each recipe picks a
profile; new recipes start from the default. If a recipe's batch size or efficiency
differs from its profile, **Scale recipe to fit** rescales the ingredients to keep OG
and IBU. A brew log keeps a copy of the profile it was brewed on.

## Brew-day timer

Each brew log has a timer with one segment per mash step, one for the boil (with an
alert for every hop and kettle addition) and one per whirlpool stand. An alert beeps,
vibrates the phone, shows a banner in the app and, if you allow it, sends a browser
notification. The countdown survives a reload and keeps running while you use other
parts of the app.

Browsers stop web pages when the phone is locked, so alerts only fire while the app is
open: leave "Keep the screen on" ticked on brew day. On iPhone, notifications need the
app added to the Home Screen first (Share → Add to Home Screen).

## Hop aroma

Every built-in hop has scores on eight aroma axes (in `js/data.js`), drawn as a spider
chart: a small one beside each hop in a recipe, a labelled one in the hop popup, and a
combined chart for the recipe that weights late, whirlpool and dry hop additions by weight.

## Water

**Settings → Water profiles** holds the mineral content of the water you brew with. Each
recipe has a Water card: pick your water and a target profile, enter salt additions or let
**Suggest salts** work them out, and compare source, treated and target ppm for each ion.
Salts are treated as dissolved in all the brewing water (mash plus sparge). The card also
estimates mash pH from the treated water and the grist, and suggests an acid dose (lactic or
phosphoric) for your target pH. It is a simple charge-balance estimate, good to about ±0.1. The water choice and salts are stored as `x_water`.

## Wireless hydrometer (iSpindel)

A brew log can pull gravity readings from an iSpindel that posts to a ThingSpeak channel.
Enter the channel ID on the brew's Hydrometer card (and the channel's Read API key if it
is private). Gyle fetches the readings for the brew's dates, keeps one per hour in the
brew file, draws them on the gravity chart and says when gravity has held steady for two
days. The read key is kept in the browser and never committed. Plato readings are
converted to SG. `js/sources.js` is where other reading sources can be added.

## Importing

**Recipes → Import** takes BeerXML (`.xml`) and BeerJSON (`.json`), several files at once.

- BeerSmith: File → Export → BeerXML.
- Brewfather: open a recipe → Export → BeerXML.

## Calculations

- OG: points per pound per gallon with brewhouse efficiency into the fermenter. Sugars and extracts are not scaled by efficiency.
- FG: OG × average yeast attenuation. ABV: (OG − FG) × 131.25.
- IBU: Tinseth on post-boil volume and average boil gravity. Pellets +10%, first wort +10%,
  mash hops 20%, whirlpool scaled by temperature (Malowicki), dry hops 0.
- Colour: Morey. Stored and shown in EBC.
- Water: mash water = grain × ratio; sparge makes up the pre-boil volume after grain absorption.

Everything is metric (litres, kg, g, °C, EBC). Style ranges are BJCP 2021 and the
ingredient values in `js/data.js` are typical figures: edit that file to match what you buy.

## Tests

```
node tests/calc.test.mjs
```
