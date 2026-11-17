#!/bin/bash
# One-time setup for macOS. If a ready-made app is already in electron-app/dist, this does
# almost nothing - just clears the flag that can make an unsigned app show "is damaged and
# can't be opened". Otherwise it checks for Node.js (to run the app from source) and tries to
# get the "mutagen" package ready for Tag songs - but neither of those ever stops the main app
# from opening; they're just nice-to-haves this script tries on a best-effort basis.
# Double-click this file, or run it from Terminal.
cd "$(dirname "$0")" || exit 1

echo "== Local Files Toolkit setup =="
echo

echo "Checking for a ready-made app..."
for APP in "electron-app/dist/Local Files Toolkit-darwin-arm64/Local Files Toolkit.app" \
           "electron-app/dist/Local Files Toolkit-darwin-x64/Local Files Toolkit.app"; do
    if [ -d "$APP" ]; then
        # Clear the quarantine flag macOS adds when this was copied from another Mac
        # (AirDrop/zip/cloud drive) - without this, an unsigned app like this one can show
        # a misleading "is damaged and can't be opened" error.
        xattr -cr "$APP" 2>/dev/null
        echo "Found one and it's ready to open."
        FOUND_APP=1
        break
    fi
done
echo

if [ -z "$FOUND_APP" ]; then
    echo "No ready-made app found - checking Node.js (needed to run the New Look app from source)..."
    if command -v npm >/dev/null 2>&1; then
        echo "Found: node $(node --version)"
        echo "Installing the app's dependencies (first run only, a few hundred MB)..."
        (cd electron-app && npm install)
    elif command -v brew >/dev/null 2>&1; then
        echo "Installing Node.js with Homebrew..."
        brew install node && (cd electron-app && npm install)
    else
        echo "Node.js isn't installed and Homebrew isn't available to install it automatically."
        echo "Install it yourself from https://nodejs.org, then run this Setup again -"
        echo "or just use the Classic app instead (python3 local_files_fixer.py)."
    fi
    echo
fi

# Tag songs needs Python 3 + mutagen, but a LOT of people using this won't have Python set up.
# macOS's own /usr/bin/python3 is just a stub that POPS UP A DIALOG asking to install Apple's
# "command line developer tools" the moment it's actually run - and some school/work Macs don't
# allow installing those at all. So: never run python3 unless something other than that bare
# stub is going to answer (a real install, or the stub backed by actually-installed tools).
# This is best-effort only and NEVER stops Setup from finishing; Tag songs tries to install
# mutagen itself too, the first time you actually use it.
echo "Checking Python 3 (only needed for Tag songs - Fix local files doesn't need it at all)..."
PY3="$(command -v python3 2>/dev/null)"
if [ -n "$PY3" ] && { [ "$PY3" != "/usr/bin/python3" ] || xcode-select -p >/dev/null 2>&1; }; then
    echo "Found: $(python3 --version 2>&1)"
    if python3 -c "import mutagen" >/dev/null 2>&1; then
        echo "mutagen is already installed."
    else
        echo "Installing mutagen..."
        python3 -m pip install --quiet --disable-pip-version-check --user mutagen >/dev/null 2>&1 \
            || python3 -m pip install --quiet --disable-pip-version-check mutagen >/dev/null 2>&1
        if python3 -c "import mutagen" >/dev/null 2>&1; then
            echo "mutagen installed."
        else
            echo "Couldn't install mutagen automatically - Tag songs will try again when you use it."
        fi
    fi
else
    echo "Python 3 isn't set up here. That's fine for Fix local files - it doesn't need it."
    echo "Tag songs won't work until Python 3 is installed (from python.org, or Apple's command"
    echo "line developer tools if this Mac allows installing those)."
fi

echo
echo "Setup finished. Use \"Local Files Toolkit.command\" to open the app."
