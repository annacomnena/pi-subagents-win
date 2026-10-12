@echo off
rem master-status.cmd - double-click for a read-only health check (master / daemon autostart)
rem chcp 65001 makes the Chinese output of the PS1 render correctly (PS1 is UTF-8 with BOM)
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0boot-autostart-status.ps1"
echo.
echo ---- SUMMARY: OK above means the autostart chain is healthy ----
pause
