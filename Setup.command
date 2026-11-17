#!/bin/bash
# macOS setup. There is nothing to install: the app contains everything it needs (no Python,
# no Node.js, no Apple command line tools). This clears the "is damaged and can't be opened"
# flag macOS puts on apps copied from another Mac, tells you about the macOS settings that can
# get in the way, then opens the app.
cd "$(dirname "$0")" || exit 1

say()  { printf '%s\n' "$*"; }
note() { printf '  - %s\n' "$*"; }
cont() { printf '    %s\n' "$*"; }

say "== Local Files Toolkit setup =="
say

# Is there an app to open at all? (Local Files Toolkit.command does the real work and explains if not.)
FOUND=""
for APP in "Local Files Toolkit.app" \
           "electron-app/dist/Local Files Toolkit-darwin-universal/Local Files Toolkit.app" \
           "electron-app/dist/Local Files Toolkit-darwin-arm64/Local Files Toolkit.app" \
           "electron-app/dist/Local Files Toolkit-darwin-x64/Local Files Toolkit.app"; do
    [ -d "$APP" ] && FOUND="$APP" && break
done
if [ -n "$FOUND" ]; then
    say "Found the app. Nothing needs installing."
else
    say "I couldn't find Local Files Toolkit.app next to this file."
    say "Download the Mac version (a .zip) from the project page, unzip it, and keep the app"
    say "in this same folder."
fi
say

# Settings that can get in the way - only the ones that apply to this Mac are shown.
say "Things you may need to change in System Settings:"
SHOWN=0

# The app isn't notarized by Apple, so macOS can refuse the first open.
if [ -n "$FOUND" ] && xattr -p com.apple.quarantine "$FOUND" >/dev/null 2>&1; then
    note "This app came from the internet, so macOS may say it \"can't be opened\"."
    cont "Fix: System Settings > Privacy & Security > scroll down > click \"Open Anyway\" next to"
    cont "Local Files Toolkit, then confirm. (Or right-click the app > Open > Open.) Once only."
    SHOWN=1
fi

# Sending files to your phone / another computer needs incoming network connections to be allowed.
FW="/usr/libexec/ApplicationFirewall/socketfilterfw"
if [ -x "$FW" ] && "$FW" --getglobalstate 2>/dev/null | grep -qi "enabled"; then
    note "The Mac firewall is ON. For \"Send files\" to work, when macOS asks \"Do you want the application"
    cont "to accept incoming network connections?\" click Allow. (If you missed it: System Settings >"
    cont "Network > Firewall > Options > add Local Files Toolkit and set it to Allow incoming connections.)"
    SHOWN=1
fi
note "The first time you use \"Send files\", macOS may ask to allow Local Network access - click Allow."
cont "(If you clicked Don't Allow: System Settings > Privacy & Security > Local Network > turn on"
cont "Local Files Toolkit.)"

# Some school / work Macs are managed and block opening unidentified apps.
if profiles status -type enrollment 2>/dev/null | grep -qi "MDM enrollment: Yes"; then
    note "This Mac is managed (school or work). If it won't open the app or won't allow it to receive"
    cont "connections, an administrator has restricted it - ask them to allow Local Files Toolkit."
    SHOWN=1
fi
say
say "Opening the app..."
exec bash "./Local Files Toolkit.command"
