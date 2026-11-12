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

## Where your data lives

Settings → Storage offers three choices. Settings has three pages: Equipment, Water and Storage. In all of them the browser keeps a working copy,
so the app works offline and nothing is lost mid-brew.

- **This device**: the browser only.
- **GitHub repo**: BeerJSON files in a repo, one commit per save (the steps above). The app
  code and the data can be different repos: host the app from a public repo and point
  Settings at a private one.
- **Gyle account**: a Supabase project with sign-in. Changes save by themselves a moment
  after you stop typing.

Switching from one to another copies what is on the device into the new place. Signing out
of a Gyle account clears the device copy.

### Setting up a Gyle account (Supabase)

1. Create a project at supabase.com.
2. In the project's **SQL Editor**, paste and run `supabase/setup.sql`. It creates one
   `documents` table with row-level security, so each person sees only their own rows.
3. Under **Authentication → URL Configuration**, set the Site URL to the address the app is
   served from (for example `https://<you>.github.io/<repo>/`). Sign-in links and
   GitHub/Google sign-in return there.
4. Optional: under **Authentication → Providers**, switch on GitHub or Google to use the
   "Continue with" buttons. Email and password works without this.
5. Copy the project's URL and its publishable (or legacy "anon") key into `js/config.js`,
   or leave that file empty and type them into Settings on each device. Both are public
   values. Never use the secret or service-role key.
6. Open Gyle → Settings → Storage → Gyle account, and create your account.

On Supabase's free plan a project is paused after about a week without database activity.
`.github/workflows/supabase-keepalive.yml` writes a heartbeat every three days: add the
repository secrets `SUPABASE_URL` and `SUPABASE_KEY` to switch it on. If the project does
get paused, restore it from the Supabase dashboard; Gyle keeps working from the device copy
in the meantime.

## How saving works (GitHub repo)

- Edits are written to the browser straight away, so nothing is lost mid-brew.
- **Commit to repo** on a recipe or brew writes that one file as a commit.
  The chip in the header shows how many documents are waiting, and commits them all when tapped.
- On load the app pulls anything that changed in the repo. If the same recipe was edited
  on two devices, the later commit wins; the earlier version is still in git history.

## What is in the repo

```
recipes/<id>.json   one BeerJSON 1.0 document per recipe
brews/<id>.json     one brew log each, with a snapshot of the recipe as brewed
photos/<id>.jpg     brew photos (timeline and pump clips)
settings.json       your equipment profiles (created the first time you commit them)
js/calc.js          all the brewing maths
js/data.js          styles, malts, hops and yeasts offered in the editor
js/beerjson.js      BeerJSON <-> the app's model
js/beerxml.js       BeerXML import and export
js/brewfather.js    Brewfather complete backup import
js/unzip.js         reads zip files (for the Brewfather backup)
js/store.js         local working copy and syncing
js/photos.js        brew photos: kept in the browser, saved to the repo or account
js/backend-git.js   storage backend: GitHub repo
js/backend-supabase.js  storage backend: Supabase account (sign-in + documents table)
js/config.js        Supabase project URL and public key
supabase/setup.sql  database setup for the Supabase backend
js/timer.js         brew-day timer, alerts and notifications
js/sources.js       reading sources for automatic gravity readings (ThingSpeak)
js/brewsheet.js     the brew sheet, as a web page and as a PDF
js/pdf.js           a small PDF writer for the brew sheet
fonts/              the web fonts, served from this site
js/app.js           the screens
sw.js               service worker, only so Android can show timer notifications
```

A few things BeerJSON has no field for are stored under `x_` keys in the recipe
files: first-wort / whirlpool hop use (`x_use`), whirlpool temperature (`x_temp`),
mash ratio (`x_mash_ratio`), the equipment profile id (`x_equipment`), and the version
fields (`x_family`, `x_version`, `x_version_note`, `x_based_on`). Other software ignores them.

## Brew queue

The recipe list is ordered as a brew queue by default: the top recipe is the one you plan
to brew next. Drag a row by its numbered handle (or focus the handle and use the arrow
keys) to reorder. The order is stored as `brewOrder` in `settings.json`. The Order menu
switches the list to recently edited or by name.

Each recipe is flagged **In planning**, **Ready to brew** or **Archived** with the toggle
under its name. The file stores this as `x_status`. The queue lists ready recipes first,
then recipes in planning. You can drag rows only inside their own group. The first ready
recipe is tagged as the next brew. When a recipe changes status, it goes to the bottom of
its new group.

Archived recipes are not in the queue or in the brew picker. To see them, set Show to
Archived. To bring one back, press Restore on its row, or choose In planning or Ready to
brew on the recipe. To archive many recipes at once, set Show to a status or type a
search, then press "Archive these".

## Versions and new recipes

To change a recipe and keep its name, press **New version** under the recipe's name. The new version
starts as a copy and gets the next number. The old version stays as it was, so brews made
from it still show what you brewed. You can say what will change, and the note shows under
**Packaging & notes**.

The recipe list and the brew picker show only the newest version of each recipe. The
links under the recipe name (v1, v2, v3) open the other versions. An older version says
so at the top. If you delete the newest version, the one before it takes its place in
the brew queue.

To start a different beer from an existing one, press **New recipe from this**, or
**New recipe** on the recipe list and choose a recipe under "Start from". The new recipe
must have a name of its own: no two recipes can share a name, except the versions of one
recipe. Renaming a version renames all its versions, and an imported recipe whose name is
already in use gets a number added ("Best Bitter 2"). It starts as a copy at version 1 and links back to the
recipe it was based on.

## Brew days

The Brews page has a Brew days card with one row per year and one dot per brew, in the colour
of the beer. Gaps in brewing show as empty stretches. Above the chart are the number of brews,
the brews in the last 12 months, the longest gap and the time since the last brew. To read a
dot, hover over it or select it with the keyboard. Tap a dot to open its brew log.

## Brew sheets

**Brew sheet** on a recipe or a brew log opens a sheet for brew day: the targets,
every ingredient, the water, the brew-day checklist with tick boxes, a plan-and-actual
table and space for notes. A recipe's sheet has blanks to fill in by hand. A brew log's
sheet fills in what you measured and ticked.

**Print** uses the browser's print dialog, which can also save a PDF. **Download PDF**
makes an A4 PDF file in the app itself. The PDF uses the standard Helvetica font, so
characters outside Western European text show as "?".

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
parts of the app. While the timer runs, the browser tab title shows the time left and the step.

Browsers stop web pages when the phone is locked, so alerts only fire while the app is
open: leave "Keep the screen on" ticked on brew day. On iPhone, notifications need the
app added to the Home Screen first (Share → Add to Home Screen).

## Photos, timeline and pump clip

Each brew log has a Timeline card for photos and notes, grouped by brew day, day 1, day 2
and so on. Press **Add photos** to add pictures, several at once. On a phone, you can take
a picture or choose one from the gallery. A photo gets the time of its file, and you can
change the time. Press **Add note** for a note without a photo. Tap a photo to see it
full size.

A pump clip is the badge for the beer. It shows at the top of the page and in the lists, in
place of the pint. A recipe and a brew log can each have one.

- **On a recipe**: press **Add pump clip** under the recipe status. Every version of the
  recipe gets the same clip. Each brew of the recipe shows it, unless the brew has its own.
- **On a brew log**: press **Add pump clip** in the Timeline card, or press **Pin as the pump
  clip** under a timeline photo. Press **Use this pump clip for the recipe too** to give the
  recipe the same clip.

A recipe file that you export does not contain the picture.

Gyle makes each photo smaller before it keeps it, to at most 1600 pixels on the long side.
A photo is usually 150 to 400 kB. The photos are kept in the browser and saved with the brew:

- **This device**: in the browser only.
- **GitHub repo**: as `photos/<id>.jpg` in the repo. Each photo is one commit, made with the
  commit of its brew. A public repo makes the photos public. Keep your data in a private repo.
- **Gyle account**: in Supabase Storage, in a private `photos` bucket. Run
  `supabase/setup.sql` again to create the bucket. Until you do, the status chip says
  "Photos not saved yet".

Notes from a Brewfather backup arrive in the timeline. Some brews came in before the timeline
existed. If you open one of them, Gyle moves its dated notes into the timeline.

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

Gyle reads gravity from an iSpindel that posts to a ThingSpeak channel.

1. Go to **Settings → Devices** and press **Add device**.
2. Enter a name, the channel ID and, for a private channel, the Read API key.
3. Press **Test**. Gyle shows the latest reading and which fields hold gravity and temperature.
4. On a brew log, choose the device on the Hydrometer card.

Gyle then fetches the readings from the brew date to the packaged date and keeps one per hour
in the brew log. While a brew is fermenting or conditioning, Gyle fetches new readings each
time you open it. It also says when gravity has held steady for two days. Plato readings are
converted to SG. `js/sources.js` is where other reading sources can be added.

The read key is kept in the browser and never saved to the repo or your account. Enter it
again on each phone or computer that you use. Gyle leaves out a reading that is more than
10 points above the lowest reading before it. That reading comes from after the iSpindel
left the beer.

The Hydrometer card draws the readings as two charts on one time scale: gravity, and
temperature below it. Your own readings show as dots. To read one hour, touch or hover
over a chart, or focus it and use the arrow keys.

## Importing

**Recipes → Import** takes BeerXML (`.xml`) and BeerJSON (`.json`), several files at once.

- BeerSmith: File → Export → BeerXML.
- Brewfather: open a recipe → Export → BeerXML.
- Brewfather, everything at once: in Brewfather, make a complete backup, then import the zip file.

A Brewfather complete backup brings in these items:

- every recipe, with hopstands as whirlpool additions at the hopstand temperature
- the water salts and acid from Brewfather's water calculator, in each recipe's Water card
- every batch as a brew log, with its notes, OG, volume, rating and iSpindel or Tilt readings
- your equipment profiles, and the water profiles that you made or that a recipe uses

The recipes from a backup arrive archived, so they do not fill the brew queue. Restore
the ones that you plan to brew. Gyle leaves out the inventory, the device settings, the calendar and Brewfather's recipe
version history. Brewfather's version copies are the same as the recipe in every backup
checked so far. If you import a newer backup later, Gyle adds only what is new. It does
not change a recipe or a brew log that came from an earlier import.

Brewfather gives IBU to hops added at 0 minutes, because they stay in hot wort after
the boil. Gyle gives them none, so those recipes show fewer IBU in Gyle. To count them,
change those hops to whirlpool.

## Calculations

- OG: points per pound per gallon with brewhouse efficiency into the fermenter. Sugars and extracts are not scaled by efficiency.
- FG: OG × average yeast attenuation. ABV: (OG − FG) × 131.25.
- IBU: Tinseth on post-boil volume and average boil gravity. Pellets +10%, first wort +10%,
  mash hops 20%, whirlpool scaled by temperature (Malowicki), dry hops 0.
- Colour: Morey, over the wort volume at the end of the boil. Gyle uses the SRM number of
  each malt as its Lovibond value, as Brewfather and BeerSmith do. Gyle stores and shows colour in EBC.
- Water: mash water = grain × ratio; sparge makes up the pre-boil volume after grain absorption.

Everything is metric (litres, kg, g, °C, EBC). Style ranges are BJCP 2021 and the
ingredient values in `js/data.js` are typical figures: edit that file to match what you buy.

## Tests

```
node tests/calc.test.mjs
```
