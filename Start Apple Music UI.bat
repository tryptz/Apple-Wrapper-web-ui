@echo off
title Apple Music Downloader - Web UI
cd /d "%~dp0"

echo Starting Apple Music web UI...
echo.

REM Launch the Node server in its own window (close that window to stop the server)
start "Apple Music Web UI (server)" cmd /k node webui\server.js

REM Give the server a moment to bind the port, then open the browser
timeout /t 2 /nobreak >nul
start "" http://localhost:8080

exit
