# Keel — detached launcher (no terminal dependency)
# Starts API + Worker as hidden processes; they survive even if calling terminal dies.
# STOP/RESTART: see scripts/stop-keel.ps1 then re-run this file.

param()

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$logs = Join-Path $root '.logs'
if (-not (Test-Path $logs)) { New-Item -ItemType Directory -Path $logs | Out-Null }

# Kill stale keel processes ONLY by CommandLine match (NEVER blanket kill node.exe — 9router lives there!)
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*--env-file=.env src/index.ts*' -or $_.CommandLine -like '*--env-file=.env src/worker.ts*' } | ForEach-Object {
  try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; Write-Host "Stopped keel PID $($_.ProcessId)" } catch {}
}
Start-Sleep -Seconds 1

function Start-Detached([string]$tsxArgs, [string]$logFile) {
  $file = ($tsxArgs -replace '.*(src/[^ ]+\.ts).*', '$1')
  if ($file -eq $tsxArgs) { $file = 'src/index.ts' }
  $argLine = "/c npx --yes tsx --env-file=.env $file >> `"$logFile`" 2>&1"
  Start-Process -FilePath 'cmd.exe' -ArgumentList $argLine -WorkingDirectory $root -WindowStyle Hidden | Out-Null
}

Start-Detached '--env-file=.env src/index.ts'  (Join-Path $logs 'api.log')
Write-Host "[keel] API launched - .logs\api.log"
Start-Detached '--env-file=.env src/worker.ts' (Join-Path $logs 'worker.log')
Write-Host "[keel] Worker launched - .logs\worker.log"
Write-Host "[keel] Launcher done - processes are detached. Check .logs\*.log"
