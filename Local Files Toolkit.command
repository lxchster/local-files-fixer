#!/bin/bash
# Opens Local Files Toolkit (fix local files + tag songs) on macOS.
# Double-click this file in Finder. Nothing needs to be installed: the app is self-contained
# (no Python, no Node.js, no Apple command line tools).
cd "$(dirname "$0")" || exit 1

# The app isn't notarized by Apple, so macOS quarantines it when it's copied here from another
# Mac (AirDrop / zip / cloud drive) and Gatekeeper then calls it "damaged". Clearing that flag
# and giving it a local signature (codesign ships with macOS itself) makes it just open.
for APP in "Local Files Toolkit.app" \
           "electron-app/dist/Local Files Toolkit-darwin-universal/Local Files Toolkit.app" \
           "electron-app/dist/Local Files Toolkit-darwin-arm64/Local Files Toolkit.app" \
           "electron-app/dist/Local Files Toolkit-darwin-x64/Local Files Toolkit.app"; do
    if [ -d "$APP" ]; then
        xattr -cr "$APP" 2>/dev/null
        codesign --force --deep --sign - "$APP" >/dev/null 2>&1
        open "$APP"
        exit 0
    fi
done

# No ready-made app here: run from source (only needed by whoever builds the app).
if [ -f electron-app/package.json ] && command -v npm >/dev/null 2>&1; then
    cd electron-app || exit 1
    [ -d node_modules/electron ] || npm install
    npx electron .
    exit 0
fi

osascript -e 'display dialog "The Local Files Toolkit app was not found next to this file. Download the Mac version (a .zip) from the project page, unzip it, and open Local Files Toolkit.app." buttons {"OK"} default button 1 with icon caution' >/dev/null 2>&1
echo "Local Files Toolkit.app was not found next to this file."
exit 1
