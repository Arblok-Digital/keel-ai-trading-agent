# Backup otomatis PostgreSQL (S8) — jalankan via Task Scheduler Windows atau cron.
# Simpan OUTSIDE volume Docker. Contoh: node --env-file=.env backup-db.cjs (schedule harian 03:00)
@echo off
setlocal
cd /d "%~dp0"
if not exist backups mkdir backups
set STAMP=%date:~-4%%date:~-4%%date:~3,2%%date:~0,2%-%time:~0,2%%time:~3,2%
for /f "tokens=1-3 delims=:" %%a in ("%time%") do set H=%%a&set M=%%b
set STAMP=%date:~-4%%date:~3,2%%date:~0,2%-%H%%M%
echo Running pg_dump to backups\keel_%STAMP%.sql
docker exec keel-postgres-1 pg_dump -U postgres -d keel_trading -Fc > backups\keel_%STAMP%.sql
echo Pruning backups older than 14 days...
forfiles /p backups /m *.sql /d -14 /c "cmd /c del @path" 2>nul
echo Done.