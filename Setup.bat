@echo off
rem One-time setup for Windows: installs the prerequisites Local Files Toolkit needs - Python 3
rem and the "mutagen" package for Tag songs, and Node.js if you don't already have a ready-made
rem app in electron-app\dist. Safe to run more than once: every step checks first and skips
rem what's already there. Double-click this file to run it.
cd /d "%~dp0"

echo == Local Files Toolkit setup ==
echo.
echo Checking Python 3...
where python >nul 2>&1
if %errorlevel% equ 0 goto havepython
where py >nul 2>&1
if %errorlevel% equ 0 goto havepython
where python3 >nul 2>&1
if %errorlevel% equ 0 goto havepython

echo Python wasn't found. Trying to install it with winget...
winget install -e --id Python.Python.3.12 --silent --accept-package-agreements --accept-source-agreements
if %errorlevel% neq 0 (
    echo Could not install Python automatically. Install it yourself from https://python.org,
    echo then run this Setup again.
    pause
    exit /b 1
)
echo Python was installed. Close this window and run Setup.bat once more so Windows picks it up.
pause
exit /b 0

:havepython
echo Python found.
echo.

echo Checking the mutagen package (needed for Tag songs)...
python -c "import mutagen" >nul 2>&1
if %errorlevel% equ 0 (
    echo mutagen is already installed.
) else (
    echo Installing mutagen...
    python -m pip install --quiet --disable-pip-version-check --user mutagen
    python -c "import mutagen" >nul 2>&1
    if %errorlevel% equ 0 (
        echo mutagen installed.
    ) else (
        echo Couldn't install mutagen automatically. Tag songs will try again the next time you use it.
    )
)
echo.

if exist "electron-app\dist\Local Files Toolkit-win32-x64\Local Files Toolkit.exe" (
    echo A ready-made app is already in electron-app\dist - nothing else to set up.
    echo.
    echo Setup finished. Use "Local Files Toolkit.bat" to open the app.
    pause
    exit /b 0
)

echo Checking Node.js ^(only needed to run the New Look app from source^)...
where npm >nul 2>&1
if %errorlevel% equ 0 goto havenode

echo Node.js wasn't found. Trying to install it with winget...
winget install -e --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
if %errorlevel% neq 0 (
    echo Could not install Node.js automatically. Install it yourself from https://nodejs.org,
    echo then run this Setup again - or just use the Classic app instead
    echo ^(python local_files_fixer.py^), which needs no Node.js.
    pause
    exit /b 1
)
echo Node.js was installed. Close this window and run Setup.bat once more so Windows picks it up.
pause
exit /b 0

:havenode
echo Node.js found.
echo.

echo Installing the New Look app's dependencies ^(first run only, a few hundred MB^)...
cd electron-app
call npm install
cd ..

echo.
echo Setup finished. Use "Local Files Toolkit.bat" to open the app.
pause
