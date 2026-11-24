@echo off
chcp 65001 >nul
setlocal EnableExtensions
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
set "ICON=%ROOT%\assets\tpz_file.ico,0"
set "OPENER=%ROOT%\backend\open_tpz.py"

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
    echo [HATA] pythonw.exe bulunamadi!
    if /i not "%~1"=="--quiet" pause
    exit /b 1
)

echo TPZ Inspector dosya iliskilendirmesi ve simgesi kaydediliyor...
reg delete "HKCU\Software\Classes\TPZStudio.Archive" /f >nul 2>&1
reg delete "HKCU\Software\Classes\Directory\shell\TPZStudioOpenFolder" /f >nul 2>&1
reg delete "HKCU\Software\Classes\.tpz\OpenWithProgids" /v "TPZStudio.Archive" /f >nul 2>&1

reg add "HKCU\Software\Classes\.tpz" /ve /d "TPZInspector.Archive" /f >nul
reg add "HKCU\Software\Classes\.tpz" /v "Content Type" /d "application/x-sap-tpz" /f >nul
reg add "HKCU\Software\Classes\.tpz" /v "PerceivedType" /d "compressed" /f >nul
reg add "HKCU\Software\Classes\.tpz\OpenWithProgids" /v "TPZInspector.Archive" /t REG_NONE /d "" /f >nul

reg add "HKCU\Software\Classes\TPZInspector.Archive" /ve /d "SAP PI/PO TPZ Paketi" /f >nul
reg add "HKCU\Software\Classes\TPZInspector.Archive" /v "FriendlyTypeName" /d "SAP PI/PO TPZ Paketi (TPZ Inspector)" /f >nul
reg add "HKCU\Software\Classes\TPZInspector.Archive\DefaultIcon" /ve /d "%ICON%" /f >nul
reg add "HKCU\Software\Classes\TPZInspector.Archive\shell\open" /ve /d "TPZ Inspector ile Ac" /f >nul
reg add "HKCU\Software\Classes\TPZInspector.Archive\shell\open" /v "Icon" /d "%ICON%" /f >nul
reg add "HKCU\Software\Classes\TPZInspector.Archive\shell\open\command" /ve /d "\"%PYW_EXE%\" \"%OPENER%\" \"%%1\"" /f >nul

reg add "HKCU\Software\Classes\Directory\shell\TPZInspectorOpenFolder" /ve /d "TPZ Inspector ile Klasoru Ac" /f >nul
reg add "HKCU\Software\Classes\Directory\shell\TPZInspectorOpenFolder" /v "Icon" /d "%ICON%" /f >nul
reg add "HKCU\Software\Classes\Directory\shell\TPZInspectorOpenFolder\command" /ve /d "\"%PYW_EXE%\" \"%OPENER%\" \"%%V\"" /f >nul

reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.tpz\UserChoice" /f >nul 2>&1

powershell -NoProfile -Command "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class Sh { [DllImport(\"shell32.dll\")] public static extern void SHChangeNotify(int e, int f, IntPtr d1, IntPtr d2); }'; [Sh]::SHChangeNotify(0x08000000, 0x0000, [IntPtr]::Zero, [IntPtr]::Zero)"
echo [OK] .tpz dosyalari artik TPZ Inspector simgesiyle gorunecek ve cift tikla acilacak.
