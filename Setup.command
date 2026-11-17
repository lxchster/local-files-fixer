#!/bin/bash
# One-time setup for macOS: installs the prerequisites Local Files Toolkit needs - Python 3 and
# the "mutagen" package for Tag songs, and Node.js if you don't already have a ready-made app in
# electron-app/dist. Safe to run more than once: every step checks first and skips what's
# already there. Double-click this file, or run it from Terminal.
cd "$(dirname "$0")" || exit 1

echo "== Local Files Toolkit setup =="
echo
echo "Checking Python 3..."
if ! command -v python3 >/dev/null 2>&1; then
    echo "Python 3 isn't installed. macOS should now offer to install it (as part of the"
    echo "Command Line Tools) - follow its prompts, then run this Setup again."
    python3 --version
    exit 1
fi
echo "Found: $(python3 --version)"
echo

echo "Checking the mutagen package (needed for Tag songs)..."
if python3 -c "import mutagen" >/dev/null 2>&1; then
    echo "mutagen is already installed."
else
    echo "Installing mutagen..."
    python3 -m pip install --quiet --disable-pip-version-check --user mutagen \
        || python3 -m pip install --quiet --disable-pip-version-check mutagen
    if python3 -c "import mutagen" >/dev/null 2>&1; then
        echo "mutagen installed."
    else
        echo "Couldn't install mutagen automatically. Tag songs will try again the next time you use it."
    fi
fi
echo

echo "Checking for a ready-made app..."
for APP in "electron-app/dist/Local Files Toolkit-darwin-arm64/Local Files Toolkit.app" \
           "electron-app/dist/Local Files Toolkit-darwin-x64/Local Files Toolkit.app"; do
    if [ -d "$APP" ]; then
        # Clear the quarantine flag macOS adds when this was copied from another Mac
        # (AirDrop/zip/cloud drive) - without this, an unsigned app like this one can show
        # a misleading "is damaged and can't be opened" error.
        xattr -cr "$APP" 2>/dev/null
        echo "Found one - nothing else to set up."
        echo
        echo "Setup finished. Use \"Local Files Toolkit.command\" to open the app."
        exit 0
    fi
done
echo

echo "Checking Node.js (only needed to run the New Look app from source)..."
if command -v npm >/dev/null 2>&1; then
    echo "Found: node $(node --version)"
elif command -v brew >/dev/null 2>&1; then
    echo "Installing Node.js with Homebrew..."
    brew install node
else
    echo "Node.js isn't installed and Homebrew isn't available to install it automatically."
    echo "Install it yourself from https://nodejs.org, then run this Setup again -"
    echo "or just use the Classic app instead (python3 local_files_fixer.py), which needs no Node.js."
    exit 1
fi
echo

echo "Installing the New Look app's dependencies (first run only, a few hundred MB)..."
(cd electron-app && npm install)

echo
echo "Setup finished. Use \"Local Files Toolkit.command\" to open the app."
