@echo off
chcp 65001 >nul
setlocal EnableExtensions
set "SRC_DIR=%~dp0"
if "%SRC_DIR:~-1%"=="\" set "SRC_DIR=%SRC_DIR:~0,-1%"
set "INSTALL_DIR=%LOCALAPPDATA%\TPZ-Inspector"

echo ==============================================================
echo   TPZ Inspector - Tek Tikla Kurulum (Admin Yetkisi Gerekmez)
echo ==============================================================
echo.

if not exist "%SRC_DIR%\web\dist\index.html" (
    echo [HATA] web\dist\index.html bulunamadi.
    echo Lutfen TPZ-Inspector-Setup.zip dosyasini klasore cikartip KURULUM.bat calistirin.
    pause
    exit /b 1
)

echo [1/5] Python 3 kontrol ediliyor...
call :find_pythonw
if not defined PYW_EXE (
    echo       Python 3 bulunamadi. winget ile otomatik kuruluyor (kullanici bazli)...
    where winget >nul 2>nul && (
        winget install -e --id Python.Python.3.12 --scope user --silent --accept-package-agreements --accept-source-agreements
    )
    call :find_pythonw
)
if not defined PYW_EXE (
    echo.
    echo [UYARI] Python 3 otomatik kurulamadi.
    echo Lutfen https://www.python.org/downloads/ adresinden Python 3 kurun
    echo (kurulumda 'Add python.exe to PATH' kutusunu isaretleyin),
    echo ardindan bu KURULUM.bat dosyasini tekrar calistirin.
    echo.
    pause
    exit /b 1
)
echo       Bulunan Python: %PYW_EXE%

echo [2/5] Eski arka plan sureci durduruluyor ve dosyalar kopyalaniyor...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*standalone_server.py*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >nul 2>&1
timeout /t 1 /nobreak >nul

if not exist "%INSTALL_DIR%" mkdir "%INSTALL_DIR%"
if /i not "%SRC_DIR%"=="%INSTALL_DIR%" (
    robocopy "%SRC_DIR%\assets" "%INSTALL_DIR%\assets" /E /NFL /NDL /NJH /NJS /NC /NS >nul
    robocopy "%SRC_DIR%\backend" "%INSTALL_DIR%\backend" *.py /NFL /NDL /NJH /NJS /NC /NS >nul
    robocopy "%SRC_DIR%\tools" "%INSTALL_DIR%\tools" *.jar /NFL /NDL /NJH /NJS /NC /NS >nul
    robocopy "%SRC_DIR%\web\dist" "%INSTALL_DIR%\web\dist" /E /PURGE /NFL /NDL /NJH /NJS /NC /NS >nul
    copy /Y "%SRC_DIR%\start.bat" "%INSTALL_DIR%\" >nul
    copy /Y "%SRC_DIR%\register_tpz_filetype.bat" "%INSTALL_DIR%\" >nul
    copy /Y "%SRC_DIR%\unregister_tpz_filetype.bat" "%INSTALL_DIR%\" >nul
    copy /Y "%SRC_DIR%\autostart_enable.bat" "%INSTALL_DIR%\" >nul
    copy /Y "%SRC_DIR%\autostart_disable.bat" "%INSTALL_DIR%\" >nul
    copy /Y "%SRC_DIR%\KALDIR.bat" "%INSTALL_DIR%\" >nul
)
if not exist "%INSTALL_DIR%\backend\standalone_server.py" (
    echo [HATA] Dosyalar %INSTALL_DIR% klasorune kopyalanamadi.
    pause
    exit /b 1
)
echo       Kurulum klasoru: %INSTALL_DIR%

echo [3/5] .tpz dosya ikonu ve cift tikla acma kaydediliyor...
call "%INSTALL_DIR%\register_tpz_filetype.bat" --quiet

echo [4/5] Arka plan servisi ve Windows otomatik baslatma kuruluyor...
call "%INSTALL_DIR%\autostart_enable.bat"

echo [5/5] Masaustu kisayolu olusturuluyor...
set "OPENER_PATH=%INSTALL_DIR%\backend\open_tpz.py"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$q=[char]34; $ws=New-Object -ComObject WScript.Shell; $d=[Environment]::GetFolderPath('Desktop'); $s=$ws.CreateShortcut((Join-Path $d 'TPZ Inspector.lnk')); $s.TargetPath=$env:PYW_EXE; $s.Arguments=($q + $env:OPENER_PATH + $q); $s.WorkingDirectory=$env:INSTALL_DIR; $s.IconLocation=($env:INSTALL_DIR + '\assets\tpz_file.ico,0'); $s.Description='TPZ Inspector - SAP PI/PO Transport Analyzer'; $s.Save()"

echo.
echo ==============================================================
echo   [TAMAM] TPZ Inspector basariyla kuruldu!
echo   - Artik her .tpz dosyasina CIFT TIKLAYARAK acabilirsiniz.
echo   - Masaustunde 'TPZ Inspector' kisayolu olusturuldu.
echo   - Adres: http://127.0.0.1:8765 (100%% lokal / offline)
echo   - Kaldirmak icin: %INSTALL_DIR%\KALDIR.bat
echo ==============================================================
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:8765"
pause
exit /b 0

:find_pythonw
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
exit /b 0
