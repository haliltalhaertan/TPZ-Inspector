@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "PY_EXE="
for /d %%D in ("%LOCALAPPDATA%\Programs\Python\Python*") do (
    if exist "%%~fD\python.exe" set "PY_EXE=%%~fD\python.exe"
)
if not defined PY_EXE (
    for /d %%D in ("%ProgramFiles%\Python*") do (
        if exist "%%~fD\python.exe" set "PY_EXE=%%~fD\python.exe"
    )
)
if not defined PY_EXE (
    if exist "%LOCALAPPDATA%\Python\bin\python.exe" set "PY_EXE=%LOCALAPPDATA%\Python\bin\python.exe"
)
if not defined PY_EXE (
    for /f "delims=" %%P in ('where python.exe 2^>nul') do (
        echo %%P | findstr /i "WindowsApps" >nul || if not defined PY_EXE set "PY_EXE=%%P"
    )
)
if not defined PY_EXE (
    where py >nul 2>nul && set "PY_EXE=py"
)
if not defined PY_EXE (
    echo [HATA] Python 3 bulunamadi! Lutfen https://www.python.org/downloads/ adresinden kurun.
    pause
    exit /b 1
)

echo Using Python: %PY_EXE%
"%PY_EXE%" backend\standalone_server.py %*
if errorlevel 1 (
    echo.
    echo [ERROR] Server failed to start.
    pause
)
