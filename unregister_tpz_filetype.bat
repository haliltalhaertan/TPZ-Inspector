@echo off
chcp 65001 >nul
echo TPZ Inspector dosya iliskilendirmesi kaldiriliyor...
reg delete "HKCU\Software\Classes\.tpz" /f >nul 2>&1
reg delete "HKCU\Software\Classes\TPZInspector.Archive" /f >nul 2>&1
reg delete "HKCU\Software\Classes\TPZStudio.Archive" /f >nul 2>&1
reg delete "HKCU\Software\Classes\Directory\shell\TPZInspectorOpenFolder" /f >nul 2>&1
reg delete "HKCU\Software\Classes\Directory\shell\TPZStudioOpenFolder" /f >nul 2>&1
powershell -NoProfile -Command "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class Sh { [DllImport(\"shell32.dll\")] public static extern void SHChangeNotify(int e, int f, IntPtr d1, IntPtr d2); }'; [Sh]::SHChangeNotify(0x08000000, 0x0000, [IntPtr]::Zero, [IntPtr]::Zero)"
echo [OK] .tpz dosya iliskilendirmesi kaldirildi.
