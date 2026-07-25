@echo off
REM Re-authenticate the Apple Music wrapper after changing your Apple ID
REM password. Prompts for the password without echoing it; nothing is stored.
REM
REM Pass an agent URL to drive a wrapper on another machine, e.g.
REM   "Re-sign in (new password).cmd" http://<your-agent-host>:8080
cd /d "%~dp0"

if "%~1"=="" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\resignin.ps1"
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\resignin.ps1" -Agent "%~1"
)

echo.
pause
