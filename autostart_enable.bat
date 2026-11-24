@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "PYW_EXE="
for /d %%D in ("%LOCALAPPDATA%\Programs\Python\Python*") do (
    if exist "%%~fD\pythonw.exe" set "PYW_EXE=%%~fD\pythonw.exe"
)
if not defined PYW_EXE (
    for /d %%D in ("%ProgramFiles%\Python*") do (
        if exist "%%~fD\pythonw.exe" set "PYW_EXE=%%~fD\pythonw.exe"
    )
)
if not defined PYW_EXE (
    if exist "%LOCALAPPDATA%\Python\bin\pythonw.exe" set "PYW_EXE=%LOCALAPPDATA%\Python\bin\pythonw.exe"
)
if not defined PYW_EXE (
    for /f "delims=" %%P in ('where pythonw.exe 2^>nul') do (
        echo %%P | findstr /i "WindowsApps" >nul || if not defined PYW_EXE set "PYW_EXE=%%P"
    )
)
if not defined PYW_EXE (
    echo [ERROR] pythonw.exe not found.
    exit /b 1
)

set "OLD_LINK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\TPZ Studio Server.lnk"
if exist "%OLD_LINK%" del /f /q "%OLD_LINK%" >nul 2>&1

set "LINK_PATH=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\TPZ Inspector Server.lnk"
set "SCRIPT_PATH=%~dp0backend\standalone_server.py"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$q=[char]34; $ws=New-Object -ComObject WScript.Shell; $s=$ws.CreateShortcut($env:LINK_PATH); $s.TargetPath=$env:PYW_EXE; $s.Arguments=($q + $env:SCRIPT_PATH + $q + ' --no-browser'); $s.WorkingDirectory='%~dp0'; $s.IconLocation='%~dp0assets\tpz_file.ico,0'; $s.Description='TPZ Inspector Local Server (http://127.0.0.1:8765)'; $s.Save()"
if errorlevel 1 (
    echo [ERROR] Failed to create Startup shortcut.
    exit /b 1
)
echo [OK] Startup shortcut installed: %LINK_PATH%
start "" "%LINK_PATH%"
echo [OK] TPZ Inspector running in background: http://127.0.0.1:8765
