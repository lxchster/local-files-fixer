#!/bin/bash
# Opens Local Files Toolkit (fix local files + tag songs) on macOS.
# Double-click this file in Finder (or run it from Terminal).
cd "$(dirname "$0")/electron-app" || exit 1

# The packaged app isn't code-signed, so macOS quarantines it when it's copied here from
# another Mac (AirDrop/zip/cloud drive) and Gatekeeper then refuses it as "damaged". Clearing
# that flag before every launch means it always just opens instead.
for APP in "dist/Local Files Toolkit-darwin-arm64/Local Files Toolkit.app" "dist/Local Files Toolkit-darwin-x64/Local Files Toolkit.app"; do
    if [ -d "$APP" ]; then
        xattr -cr "$APP" 2>/dev/null
        open "$APP"
        exit 0
    fi
done

if [ ! -d "node_modules/electron" ]; then
    echo "First run: installing... this needs Node.js (https://nodejs.org)."
    npm install
fi

npx electron .
