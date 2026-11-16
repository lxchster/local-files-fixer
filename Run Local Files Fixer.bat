@echo off
rem Opens Local Files Fixer (no console window if pythonw is available).
cd /d "%~dp0"
where pythonw >nul 2>nul
if %errorlevel%==0 (
    start "" pythonw "local_files_fixer.py"
) else (
    python "local_files_fixer.py"
)
