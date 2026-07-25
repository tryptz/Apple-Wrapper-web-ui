@echo off
REM Starts the wrapper web UI in LOCAL (agent) mode, hidden, on port 8080.
REM This is the process the Railway web UI proxies to over Tailscale, so it
REM needs to be running for remote downloads to work.
cd /d "%~dp0"
start "" /b node webui\server.js
echo Agent started on port 8080 (tailnet: http://<your-agent-host>:8080)
