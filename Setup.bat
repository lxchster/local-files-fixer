@echo off
rem Windows setup. Double-click this file. It runs Setup.ps1, which:
rem   - does nothing to install if a ready-made app is in electron-app\dist (no Python or Node.js needed),
rem   - otherwise installs Node.js and the app's files so it can run from source,
rem   - and tells you plainly if a Windows setting or permission is in the way.
rem Safe to run more than once: it skips whatever is already done.
cd /d "%~dp0"

if not exist "%~dp0Setup.ps1" (
    echo Setup.ps1 is missing. Keep Setup.bat and Setup.ps1 together in the same folder.
    pause
    exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Setup.ps1"
if errorlevel 1 (
    echo.
    echo Windows wouldn't run the setup script. Things to try:
    echo   - If you downloaded this as a .zip: right-click the .zip, choose Properties, tick
    echo     "Unblock" at the bottom, click OK, then extract it again.
    echo   - If "Windows protected your PC" appeared: click "More info", then "Run anyway".
    echo   - On a school or work PC, PowerShell scripts may be blocked by policy. Ask the
    echo     person who manages the PC. If a ready-made app is in electron-app\dist you don't need
    echo     this setup at all - just open "Local Files Toolkit.bat". Otherwise install Node.js
    echo     from https://nodejs.org ^(LTS^) and then open "Local Files Toolkit.bat".
)
echo.
pause
