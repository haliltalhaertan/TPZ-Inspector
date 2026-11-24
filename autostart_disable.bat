@echo off
setlocal EnableExtensions
set "LINK_PATH=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\TPZ Inspector Server.lnk"
set "OLD_LINK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\TPZ Studio Server.lnk"
if exist "%OLD_LINK%" del /f /q "%OLD_LINK%" >nul 2>&1
if exist "%LINK_PATH%" (
    del /f /q "%LINK_PATH%"
    echo [OK] Otomatik baslatma kisayolu silindi.
) else (
    echo [INFO] Otomatik baslatma kisayolu zaten yok.
)
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*standalone_server.py*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
echo [OK] Arka plandaki TPZ Inspector sunucusu durduruldu.
