@echo off
rem master-open.cmd - double-click to open or focus the global Master (idempotent, never double-opens)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0open-master.ps1" %*
exit /b %ERRORLEVEL%
