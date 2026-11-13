#!/bin/sh
# The app shows the same files as the website. Xcode runs this script on every build. It copies
# the web files from the repo root into the app (as www/), so there is one copy of the web code
# to maintain. A file that the page needs but that is not copied here gives a 404 inside the app.
# android/app/build.gradle has the same list (sitePaths). Keep the two lists the same.
set -eu

site="$SRCROOT/.."
app="$TARGET_BUILD_DIR/$UNLOCALIZED_RESOURCES_FOLDER_PATH"

rm -rf "$app/www"
mkdir -p "$app/www/recipes"
cp "$site/index.html" "$app/www/"
cp -R "$site/css" "$site/js" "$site/fonts" "$app/www/"
cp "$site/recipes/house-pale-ale.json" "$app/www/recipes/"

# The script that gives the page its GyleNative object (see WebScreen.swift).
cp "$SRCROOT/bridge.js" "$app/bridge.js"
