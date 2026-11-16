@echo off
rem Opens Local Files Toolkit (fix local files + tag songs).
cd /d "%~dp0electron-app"
if exist "dist\Local Files Toolkit-win32-x64\Local Files Toolkit.exe" (
    start "" "dist\Local Files Toolkit-win32-x64\Local Files Toolkit.exe"
    exit /b 0
)
if not exist "node_modules\electron\dist\electron.exe" (
    echo First run: installing... this needs Node.js.
    call npm install
)
start "" "node_modules\electron\dist\electron.exe" .
