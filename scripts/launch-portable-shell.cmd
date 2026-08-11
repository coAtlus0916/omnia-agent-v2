@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start Omnia Agent v5.ps1" -ProductRoot "%~dp0."
if errorlevel 1 (
  echo.
  echo Omnia Agent v5 could not be started. See the error above.
  pause
)
endlocal
