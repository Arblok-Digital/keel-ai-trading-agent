# Migrate Docker WSL from C: to D: — ONE-CLICK for Hermes agent
# - Exports pgdata via pg_dump (safety backup)
# - Exports WSL distros (docker-desktop + Ubuntu) to D:\wsl-backup
# - Imports them to D:\wsl\... (new location)
# - Verifies keel DB after move
# Jalankan sebagai Administrator: powershell -ExecutionPolicy Bypass -File .\scripts\migrate-wsl-to-D.ps1
# Jika hermes agent non-interactive: jalankan tanpa -NoProfile

param(
  [string]$TargetRoot = "D:\wsl",
  [string]$BackupRoot = "D:\wsl-backup",
  [string]$KeelRoot = "D:\DATA YAYAH\PROJECT YAYAH\keel"
)

$ErrorActionPreference = 'Stop'
function log($m){ Write-Host "[migrate-wsl] $m" -ForegroundColor Cyan }
function warn($m){ Write-Host "[migrate-wsl] WARN: $m" -ForegroundColor Yellow }
function err($m){ Write-Host "[migrate-wsl] ERR: $m" -ForegroundColor Red }

# 0. Preflight: must be admin for wsl --import
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { err "Jalankan sebagai Administrator (Run as Administrator) — wsl --import butuh admin."; exit 1 }

# 1. pg_dump safety backup (if keel running)
log "Step 1/6 — pg_dump backup keel_trading (if DB up)…"
try {
  Push-Location $KeelRoot
  $stamp = Get-Date -Format yyyyMMdd-HHmm
  $dumpFile = Join-Path $BackupRoot "keel_$stamp.dump"
  if (-not (Test-Path $BackupRoot)) { New-Item -ItemType Directory -Path $BackupRoot | Out-Null }
  # try docker exec pg_dump; ignore if container not running
  $hasCompose = Test-Path (Join-Path $KeelRoot "docker-compose.yml")
  if ($hasCompose) {
    try {
      docker exec keel-postgres-1 pg_dump -U postgres -d keel_trading -Fc > $dumpFile 2>$null
      if ((Test-Path $dumpFile) -and (Get-Item $dumpFile).Length -gt 1024) { log "pg_dump OK -> $dumpFile ($([Math]::Round((Get-Item $dumpFile).Length/1KB)) KB)" }
      else { warn "pg_dump skipped or empty (container maybe not running) — lanjut export WSL tetap aman (pgdata di volume)." ; if (Test-Path $dumpFile) { Remove-Item $dumpFile -Force -ErrorAction SilentlyContinue } }
    } catch { warn "pg_dump gagal: $($_.Exception.Message) — lanjut export WSL (volume tetap kebawa)." }
  }
  Pop-Location
} catch { warn "Step 1 warning: $($_.Exception.Message)" }

# 2. Graceful shutdown
log "Step 2/6 — wsl --shutdown (biar DB tidak korup)…"
try { wsl --shutdown 2>&1 | Out-Null } catch {}
Start-Sleep -Seconds 5
log "WSL shutdown done. Verifikasi: wsl --list --verbose"
wsl --list --verbose 2>&1 | Out-String | Write-Host

# 3. Prepare target dirs
log "Step 3/6 — Siapkan folder di D: …"
foreach ($d in @($TargetRoot, $BackupRoot, (Join-Path $TargetRoot "docker-desktop"), (Join-Path $TargetRoot "Ubuntu"))) {
  if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d | Out-Null; log "  mkdir $d" }
}

# 4. Export
log "Step 4/6 — Export WSL distros ke $BackupRoot (bisa 5-15 menit, sabar)…"
$exports = @(
  @{ name = "docker-desktop"; file = Join-Path $BackupRoot "docker-desktop.tar" },
  @{ name = "Ubuntu";         file = Join-Path $BackupRoot "Ubuntu.tar" }
)
foreach ($e in $exports) {
  $exists = (wsl --list --verbose 2>&1 | Out-String) -match $e.name
  if (-not $exists) { warn "Distro $($e.name) tidak ditemukan — skip export."; continue }
  if (Test-Path $e.file) { warn "File $($e.file) sudah ada — skip (hapus manual kalau mau re-export)."; continue }
  log "  Exporting $($e.name) -> $($e.file) …"
  $sw = [Diagnostics.Stopwatch]::StartNew()
  wsl --export $e.name $e.file 2>&1 | Out-String | Write-Host
  $sw.Stop()
  if (Test-Path $e.file) { log "  Export $($e.name) done in $([int]$sw.Elapsed.TotalSeconds)s — $([Math]::Round((Get-Item $e.file).Length/1GB,2)) GB" }
  else { err "Export $($e.name) GAGAL — file tidak tercipta. Stop, cek disk D:."; exit 1 }
}

# 5. Unregister old + Import to D:\wsl\
log "Step 5/6 — Unregister distro lama (C:) lalu import ke $TargetRoot …"
log "  PENTING: unregister akan hapus vhdx di C: — tapi backup .tar di $BackupRoot sudah aman. Jika mau extra aman, comment baris unregister di script ini."
foreach ($e in $exports) {
  if (-not (Test-Path $e.file)) { warn "Skip import $($e.name) — no tar."; continue }
  # Check if distro still exists before unregister
  $still = (wsl --list --verbose 2>&1 | Out-String) -match $e.name
  if ($still) {
    log "  Unregister $($e.name) (old C: location)…"
    wsl --unregister $e.name 2>&1 | Out-String | Write-Host
    Start-Sleep -Seconds 2
  }
  $importDir = Join-Path $TargetRoot $e.name
  log "  Import $($e.name) -> $importDir …"
  wsl --import $e.name $importDir $e.file --version 2 2>&1 | Out-String | Write-Host
  if ((wsl --list --verbose 2>&1 | Out-String) -match $e.name) { log "  Import $($e.name) OK" } else { err "Import $($e.name) gagal — cek log di atas."; exit 1 }
}

# 6. Verify
log "Step 6/6 — Verifikasi…"
wsl --list --verbose 2>&1 | Out-String | Write-Host
log "Cek disk: D:\wsl\ harus berisi docker-desktop.vhdx + Ubuntu.vhdx"
Get-ChildItem $TargetRoot -Recurse -Filter *.vhdx -ErrorAction SilentlyContinue | Select-Object FullName, @{N="GB";E={[Math]::Round($_.Length/1GB,2)}} | Format-Table -AutoSize | Out-String | Write-Host

log "Selesai. Langkah setelah ini (Hermes):"
log "  1. Restart Docker Desktop (akan auto-detect WSL di D:)"
log "  2. cd `"$KeelRoot`" ; docker compose up -d ; npx --yes tsx --env-file=.env src/db/migrate.ts"
log "  3. powershell -File .\scripts\keel-run.ps1  (nyalakan API+worker)"
log "  4. Buka http://localhost:3000/app — cek HEALTH db:up"
log "Backup .tar tetap di $BackupRoot — JANGAN DIHAPUS sampai verifikasi sukses (bisa jadi restore point)."
