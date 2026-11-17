@echo off
rem Opens Local Files Toolkit (fix local files + tag songs).
cd /d "%~dp0electron-app"
if exist "dist\Local Files Toolkit-win32-x64\Local Files Toolkit.exe" (
    start "" "dist\Local Files Toolkit-win32-x64\Local Files Toolkit.exe"
    exit /b 0
)
if not exist "node_modules\electron\package.json" (
    echo First run: installing... this needs Node.js.
    call npm install
)
if not exist "node_modules\electron\dist\electron.exe" (
    echo Downloading the Electron program file ^(a few hundred MB, first run only^)...
    call node node_modules\electron\install.js
)
if not exist "node_modules\electron\dist\electron.exe" (
    echo.
    echo Electron could not be downloaded. Check your internet connection, delete the
    echo "electron-app\node_modules" folder, and run this again.
    pause
    exit /b 1
)
start "" "node_modules\electron\dist\electron.exe" .
