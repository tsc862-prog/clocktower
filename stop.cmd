@echo off
rem Clocktower: stop the game. Asks the supervisor to stop every runner, then closes the relay and the page.
setlocal
cd /d "%~dp0"
echo Stopping the runners...
curl -s -m 10 -X POST -H "content-type: application/json" -H "Origin: http://localhost:5173" -d "{\"why\":\"stop.cmd\",\"waitMs\":5000}" http://127.0.0.1:8787/play/runner/stop-all
echo.
echo Closing the relay and the page...
for /f "tokens=2 delims=," %%p in ('wmic process where "name='node.exe' and (commandline like '%%scripts\\relay.mjs%%' or commandline like '%%vite%%--port 5173%%')" get processid^,name /format:csv ^| findstr /r "[0-9]"') do taskkill /pid %%p /f > nul 2>&1
timeout /t 2 /nobreak > nul
curl -s -m 2 -o nul http://127.0.0.1:8787/play/health && (echo The relay is still answering; close its window by hand.) || (echo Stopped.)
timeout /t 4
