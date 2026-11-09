@echo off
rem Clocktower: one click to play. Starts the relay with a fresh seeded game and the page, opens the browser,
rem then starts the Storyteller and the seven seats at the readable pace. Keys come from .env (never shown here).
rem   play.cmd            a new game with a random seed
rem   play.cmd 7          a new game with seed 7
rem   play.cmd 7 fast     pace fast (20 s between a seat's turns); readable (60 s) is the default; slow is 150 s
setlocal
cd /d "%~dp0"
set SEED=%1
if "%SEED%"=="" set /a SEED=%RANDOM% %% 1000 + 1
set PACE=%2
if "%PACE%"=="" set PACE=readable
set MINGAP=60
set HEARTBEAT=360
if /i "%PACE%"=="fast" set MINGAP=20& set HEARTBEAT=120
if /i "%PACE%"=="slow" set MINGAP=150& set HEARTBEAT=720
if not exist .env echo No .env yet: copy .env.example to .env and fill ANTHROPIC_API_KEY. & pause & exit /b 1
if not exist node_modules\.bin\vite.cmd echo Run "npm install" once first. & pause & exit /b 1
if not exist logs\tmp mkdir logs\tmp

echo Clocktower: seed %SEED%, pace %PACE% (%MINGAP% s between a seat's turns)
curl -s -m 2 -o nul http://127.0.0.1:8787/play/health && (echo A relay is already running on 8787; using it.) || (
  start "Clocktower relay (seed %SEED%)" /min cmd /c "node scripts\relay.mjs --runners --game --seed %SEED% --rounds 3 --verbose > logs\tmp\relay.log 2>&1"
)
curl -s -m 2 -o nul http://localhost:5173/ && (echo The page is already up on 5173.) || (
  start "Clocktower page" /min cmd /c "node_modules\.bin\vite.cmd --port 5173 --strictPort > logs\tmp\vite.log 2>&1"
)

echo Waiting for the relay...
set TRIES=0
:waitrelay
curl -s -m 2 -o nul http://127.0.0.1:8787/play/health && goto relayup
set /a TRIES+=1
if %TRIES% GEQ 40 echo The relay did not start; see logs\tmp\relay.log & pause & exit /b 1
timeout /t 1 /nobreak > nul
goto waitrelay
:relayup

start "" http://localhost:5173/

echo Starting the Storyteller...
curl -s -m 10 -X POST -H "content-type: application/json" -H "Origin: http://localhost:5173" -d "{\"kind\":\"storyteller\",\"by\":\"owner\",\"minGap\":%MINGAP%,\"heartbeat\":%HEARTBEAT%}" http://127.0.0.1:8787/play/runner/start
echo.
for %%i in (1 2 3 4 5 6 7) do (
  echo Starting seat %%i...
  curl -s -m 10 -X POST -H "content-type: application/json" -H "Origin: http://localhost:5173" -d "{\"player\":%%i,\"by\":\"owner\",\"minGap\":%MINGAP%,\"heartbeat\":%HEARTBEAT%}" http://127.0.0.1:8787/play/runner/start
  echo.
  timeout /t 1 /nobreak > nul
)
echo.
echo All eight runners asked to start. Watch the page; stop.cmd ends the game and closes everything.
timeout /t 8
