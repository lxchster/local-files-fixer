@echo off
rem Opens the new rounded Local Files Fixer (Electron version).
cd /d "%~dp0electron-app"
if not exist "node_modules\electron\dist\electron.exe" (
    echo Electron isn't installed yet. Run "npm install" in the electron-app folder first.
    pause
    exit /b 1
)
start "" "node_modules\electron\dist\electron.exe" .
