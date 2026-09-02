@echo off
REM keel Worker — watchdog launcher (owned by Task Scheduler, NOT by the chat terminal)
cd /d "%~dp0.."
if not exist .logs mkdir .logs
echo [%date% %time%] [keel-worker] launcher started >> .logs\worker.log
:loop
echo [%date% %time%] [keel-worker] starting npx tsx src/worker.ts >> .logs\worker.log
call npx --yes tsx --env-file=.env src/worker.ts >> .logs\worker.log 2>&1
set RC=%ERRORLEVEL%
echo [%date% %time%] [keel-worker] exited code %RC%, restarting in 2s >> .logs\worker.log
timeout /t 2 /nobreak >nul
goto loop
