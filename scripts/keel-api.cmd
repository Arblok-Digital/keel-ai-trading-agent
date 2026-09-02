@echo off
REM keel API — watchdog launcher (owned by Task Scheduler, NOT by the chat terminal)
cd /d "%~dp0.."
if not exist .logs mkdir .logs
echo [%date% %time%] [keel-api] launcher started (PID %PROCESSOR_IDENTIFIER% not relevant; scheduler-owned) >> .logs\api.log
:loop
echo [%date% %time%] [keel-api] starting npx tsx src/index.ts >> .logs\api.log
call npx --yes tsx --env-file=.env src/index.ts >> .logs\api.log 2>&1
set RC=%ERRORLEVEL%
echo [%date% %time%] [keel-api] exited code %RC%, restarting in 2s >> .logs\api.log
timeout /t 2 /nobreak >nul
goto loop
