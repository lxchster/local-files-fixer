#!/bin/bash
# Opens Local Files Toolkit (fix local files + tag songs) on macOS.
# Double-click this file in Finder (or run it from Terminal).
cd "$(dirname "$0")/electron-app" || exit 1

if [ -d "dist/Local Files Toolkit-darwin-arm64/Local Files Toolkit.app" ]; then
    open "dist/Local Files Toolkit-darwin-arm64/Local Files Toolkit.app"
    exit 0
fi
if [ -d "dist/Local Files Toolkit-darwin-x64/Local Files Toolkit.app" ]; then
    open "dist/Local Files Toolkit-darwin-x64/Local Files Toolkit.app"
    exit 0
fi

if [ ! -d "node_modules/electron" ]; then
    echo "First run: installing... this needs Node.js (https://nodejs.org)."
    npm install
fi

npx electron .
