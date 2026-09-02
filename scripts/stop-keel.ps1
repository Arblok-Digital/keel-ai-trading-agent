# Stop ONLY keel processes (never blanket-kill node — 9router is node too!)
$procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
  $_.CommandLine -like '*--env-file=.env src/index.ts*' -or $_.CommandLine -like '*--env-file=.env src/worker.ts*'
}
if (-not $procs) { Write-Host '[keel] nothing to stop'; exit 0 }
foreach ($p in $procs) {
  try { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue; Write-Host "Stopped keel PID $($p.ProcessId) $($p.CommandLine.Substring(0,[Math]::Min(120,$p.CommandLine.Length)))" } catch { Write-Host "Failed $($p.ProcessId): $_" }
}
Write-Host '[keel] stop done'
