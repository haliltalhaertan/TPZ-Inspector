@echo off
chcp 65001 >nul
setlocal EnableExtensions
set "INSTALL_DIR=%LOCALAPPDATA%\TPZ-Inspector"

echo TPZ Inspector kaldiriliyor...
set "LINK_PATH=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\TPZ Inspector Server.lnk"
if exist "%LINK_PATH%" del /f /q "%LINK_PATH%" >nul 2>&1
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*standalone_server.py*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >nul 2>&1
powershell -NoProfile -ExecutionPolicy Bypass -Command "$d=[Environment]::GetFolderPath('Desktop'); $p=Join-Path $d 'TPZ Inspector.lnk'; if (Test-Path $p) { Remove-Item $p -Force }" >nul 2>&1
reg delete "HKCU\Software\Classes\.tpz" /f >nul 2>&1
reg delete "HKCU\Software\Classes\TPZInspector.Archive" /f >nul 2>&1
reg delete "HKCU\Software\Classes\Directory\shell\TPZInspectorOpenFolder" /f >nul 2>&1
powershell -NoProfile -Command "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class Sh { [DllImport(\"shell32.dll\")] public static extern void SHChangeNotify(int e, int f, IntPtr d1, IntPtr d2); }'; [Sh]::SHChangeNotify(0x08000000, 0x0000, [IntPtr]::Zero, [IntPtr]::Zero)"
if exist "%INSTALL_DIR%" (
    if /i "%~dp0"=="%INSTALL_DIR%\" (
        echo [OK] Kisayollar, servis ve .tpz iliskilendirmesi kaldirildi.
        echo Klasoru tamamen silmek icin pencereyi kapattiktan sonra %INSTALL_DIR% klasorunu silebilirsiniz.
    ) else (
        rmdir /s /q "%INSTALL_DIR%" >nul 2>&1
        echo [OK] TPZ Inspector tamamen kaldirildi.
    )
) else (
    echo [OK] TPZ Inspector tamamen kaldirildi.
)
pause
